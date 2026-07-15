import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { PRODUCT } from '@forgeboard/core';
import { app, dialog, ipcMain } from 'electron';
import { z } from 'zod';

import {
  AuditListInputSchema,
  BackupHealthSchema,
  CanvasDocumentSchema,
  CloneProjectInputSchema,
  ConfirmProjectRecoveryInputSchema,
  CreateProjectInputSchema,
  IPC_CHANNELS,
  LocalReferenceSelectionInputSchema,
  LocateProjectRecoveryInputSchema,
  type AppSettings,
  type IpcResult,
} from '../shared/contracts.js';
import { AutomaticBackupCoordinator } from './automatic-backup-coordinator.js';
import { CheckIpcService } from './check-ipc.js';
import { CheckRuntime } from './check-runtime.js';
import { detectAgents, ProjectService } from './project-service.js';
import { DockerIpcService } from './docker-ipc.js';
import { ExtensionIpcService } from './extension-ipc.js';
import { GitIpcService } from './git-ipc.js';
import { createBundledGitRepositoryService } from './git-runtime.js';
import { DataOperationGate } from './lifecycle/data-operation-gate.js';
import { performPrivacyDeletion } from './lifecycle/privacy-deletion.js';
import { PreviewIpcService } from './preview-ipc.js';
import { prepareReversibleQuitBackup } from './quit-backup-preparation.js';
import { RecoveryIpcService } from './recovery-ipc.js';
import { RunService } from './run-service.js';
import { SettingsIpcService } from './settings-ipc.js';
import type { LocalStore } from './storage.js';

const PathSchema = z.string().min(1).max(32_768);
const ProjectIdSchema = z.string().uuid();

export function createDefaultSettings(): AppSettings {
  const documents = app.getPath('documents');
  return {
    onboardingCompleted: false,
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    canvasGridSize: 16,
    canvasSnapToGrid: true,
    keyboardPreset: 'standard',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'worktree-write',
    agentExecutableOverrides: {},
    agentDefaultModels: {},
    customAgent: {
      enabled: false,
      name: 'Custom CLI',
      providerName: 'Custom provider',
      providerDisclosure:
        'This user-configured CLI may send the prompt and selected context to its configured provider.',
      sendsContextOffDevice: true,
      executable: '',
      versionArguments: ['--version'],
      launchArguments: [],
      promptTransport: 'argument',
      runtime: 'pty',
      output: 'text',
    },
    worktreeRoot: join(documents, PRODUCT.dataDirectoryName, PRODUCT.worktreeDirectoryName),
    worktreeCleanupPolicy: 'manual',
    branchPrefix: 'forgeboard/',
    gitIdentityName: '',
    gitIdentityEmail: '',
    gitRemote: 'origin',
    terminalShell:
      process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh'),
    envAllowlist: ['PATH', 'HOME', 'LANG', 'TERM', 'COLORTERM'],
    developmentCommand: { executable: '', arguments: [] },
    testCommand: { executable: '', arguments: [] },
    lintCommand: { executable: '', arguments: [] },
    typecheckCommand: { executable: '', arguments: [] },
    buildCommand: { executable: '', arguments: [] },
    previewPortStart: 41_000,
    previewPortEnd: 41_999,
    previewTrustedHosts: ['127.0.0.1', 'localhost'],
    dockerEnabled: false,
    dockerExecutable: 'docker',
    dockerImage: '',
    dockerContainerExecutable: '',
    dockerNetwork: 'disabled',
    dockerCpuLimit: 2,
    dockerMemoryMb: 4096,
    dockerMountHostCredentials: false,
    transcriptRetentionDays: 30,
    auditRetentionDays: 365,
    snapshotRetentionCount: 100,
    autosaveIntervalMs: 2000,
    backupsEnabled: true,
    backupDirectory: join(documents, PRODUCT.dataDirectoryName, 'backups'),
    backupIntervalHours: 24,
    backupOnQuit: true,
    backupRetentionCount: 30,
    collaborationEnabled: false,
    collaborationUrl: 'ws://127.0.0.1:1234',
    collaborationDisplayName: 'Local user',
    collaborationRoom: 'default',
    collaborationReconnect: true,
    updateChannel: 'stable',
    automaticUpdateDownloads: false,
  };
}

export interface ApplicationServices {
  settings: SettingsIpcService;
  docker: DockerIpcService;
  runs: RunService;
  previews: PreviewIpcService;
  extensions: ExtensionIpcService;
  git: GitIpcService;
  checks: CheckIpcService;
  recovery: RecoveryIpcService;
  prepareToQuit(): Promise<void>;
  dispose(): Promise<void>;
}

export function registerIpcHandlers(store: LocalStore): ApplicationServices {
  const dataOperations = new DataOperationGate();
  let shutdownServicesPaused = false;
  const runDataOperation = async <Output>(
    operation: () => Output | Promise<Output>,
  ): Promise<Output> => await dataOperations.run(operation);
  const awaitDataServices = async (operations: Array<Promise<unknown>>): Promise<void> => {
    const results = await Promise.allSettled(operations);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) throw failure.reason;
  };
  const repositories = createBundledGitRepositoryService();
  const projects = new ProjectService(app, dialog, store, repositories);
  const transcripts = join(app.getPath('userData'), 'transcripts');
  const testAgentPath = app.isPackaged
    ? join(process.resourcesPath, 'test-agent', 'cli.js')
    : resolve(process.cwd(), '../../packages/test-agent/dist/cli.js');
  const extensions = new ExtensionIpcService(app, dialog, store);
  const docker = new DockerIpcService(dialog, store);
  const backups = new AutomaticBackupCoordinator(
    store,
    () => store.getSettings(createDefaultSettings()),
    {
      audit: (category, action, outcome, metadata) => {
        if (metadata.trigger !== 'flush' || action === 'automatic-prune' || outcome === 'failed') {
          store.appendAudit(category, action, outcome, metadata, false);
        }
      },
      onBackgroundError: (error) => {
        process.stderr.write(
          `Forgeboard automatic backup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
        );
      },
      onAttempt: (attempt) => store.recordBackupAttempt(attempt),
    },
  );
  const unsubscribeBackupChanges = store.subscribeToDurableChanges(() => backups.markDataChanged());
  backups.start();
  const settings = new SettingsIpcService(
    dialog,
    store,
    createDefaultSettings,
    () => backups.refreshSchedule(),
    runDataOperation,
  );
  const runs = new RunService(
    store,
    () => store.getSettings(createDefaultSettings()),
    async (adapterId) =>
      (await extensions.listActiveAgentAdapters()).find((adapter) => adapter.id === adapterId),
    async (adapterId, expectedManifest, launch) =>
      await extensions.launchTrustedAdapter(adapterId, expectedManifest, launch),
    repositories,
  );
  const previews = new PreviewIpcService(store, () => store.getSettings(createDefaultSettings()));
  const git = new GitIpcService(dialog, store, repositories, () =>
    store.getSettings(createDefaultSettings()),
  );
  const checks = new CheckIpcService(
    dialog,
    store,
    (emit) => new CheckRuntime(store, () => store.getSettings(createDefaultSettings()), emit),
  );
  const resumeDataServices = (): void => {
    recovery.resumeAfterExternalDataMutation();
    docker.resumeAfterShutdownPause();
    git.resumeAfterPrivacyReset();
    extensions.resumeAfterPrivacyReset();
    previews.resumeAfterPrivacyReset();
    runs.resumeAfterPrivacyReset();
    checks.resumeAfterPrivacyReset();
    shutdownServicesPaused = false;
  };
  const resumeAfterDataMutation = (): void => {
    resumeDataServices();
    dataOperations.finishMutation();
    backups.resume();
  };
  const pauseForShutdown = async (includeRecovery = true): Promise<void> => {
    if (shutdownServicesPaused) return;
    const operations = [
      runs.pauseForShutdown(),
      previews.pauseForShutdown(),
      checks.pauseForShutdown(),
      docker.pauseForShutdown(),
      extensions.pauseForShutdown(),
      git.pauseForShutdown(),
    ];
    if (includeRecovery) operations.push(recovery.pauseForExternalDataMutation());
    await awaitDataServices(operations);
    shutdownServicesPaused = true;
  };
  const pauseForDataImport = async (mode: 'merge' | 'replace'): Promise<void> => {
    await dataOperations.beginMutation('import');
    try {
      await backups.pause();
      await docker.pauseForShutdown();
      if (mode === 'replace') {
        await awaitDataServices([
          runs.resetForPrivacy(),
          previews.resetForPrivacy(),
          checks.resetForPrivacy(),
          extensions.pauseForDataMutation(),
          git.resetForPrivacy(),
        ]);
      } else {
        runs.pauseForDataMutation();
        previews.pauseForDataMutation();
        checks.pauseForDataMutation();
        await awaitDataServices([extensions.pauseForDataMutation(), git.resetForPrivacy()]);
      }
    } catch (error) {
      resumeAfterDataMutation();
      throw error;
    }
  };
  const recovery = new RecoveryIpcService(dialog, store, {
    beforeImport: async (context) => await pauseForDataImport(context.mode),
    afterImport: () => {
      recovery.clearPendingPlans();
      resumeAfterDataMutation();
      return Promise.resolve();
    },
  });
  const startupRetention = store.applyRetention(store.getSettings(createDefaultSettings()));
  if (Object.values(startupRetention).some((count) => count > 0)) {
    store.appendAudit('retention', 'startup', 'allowed', { ...startupRetention });
  }

  handle(IPC_CHANNELS.appInfo, z.tuple([]), () => ({
    name: PRODUCT.name,
    version: app.getVersion(),
    platform: process.platform,
    dataDirectory: app.getPath('userData'),
    databasePath: store.databasePath,
    transcriptDirectory: transcripts,
  }));

  handle(IPC_CHANNELS.agentsDetect, z.tuple([]), async () => {
    return await runDataOperation(async () => {
      const settings = store.getSettings(createDefaultSettings());
      return detectAgents(
        testAgentPath,
        await extensions.listActiveAgentAdapters(),
        settings.agentExecutableOverrides,
        settings.customAgent,
      );
    });
  });
  handle(
    IPC_CHANNELS.projectsRecent,
    z.tuple([]),
    async () => await runDataOperation(() => projects.refreshRecentProjects()),
  );
  handle(
    IPC_CHANNELS.projectsPick,
    z.tuple([]),
    async () => await runDataOperation(async () => await projects.pickRepository()),
  );
  handle(
    IPC_CHANNELS.projectsPickParent,
    z.tuple([]),
    async () => await runDataOperation(async () => await projects.pickParent()),
  );
  handle(
    IPC_CHANNELS.projectsPickExecutable,
    z.tuple([]),
    async () => await runDataOperation(async () => await projects.pickExecutable()),
  );
  handle(
    IPC_CHANNELS.projectsPickReferences,
    z.tuple([LocalReferenceSelectionInputSchema]),
    async (input) => await runDataOperation(async () => await projects.pickReferences(input)),
  );
  handle(
    IPC_CHANNELS.projectsLocateMoved,
    z.tuple([LocateProjectRecoveryInputSchema]),
    async (input) =>
      await runDataOperation(async () => await projects.selectMovedProject(input.projectId)),
  );
  handle(
    IPC_CHANNELS.projectsConfirmMoved,
    z.tuple([ConfirmProjectRecoveryInputSchema]),
    async (input) => await runDataOperation(async () => await projects.confirmMovedProject(input)),
  );
  handle(
    IPC_CHANNELS.projectsOpen,
    z.tuple([PathSchema]),
    async (path) => await runDataOperation(async () => await projects.open(path)),
  );
  handle(
    IPC_CHANNELS.projectsCreate,
    z.tuple([CreateProjectInputSchema]),
    async (input) =>
      await runDataOperation(
        async () => await projects.create(input.parentPath, input.name, input.initializeGit),
      ),
  );
  handle(
    IPC_CHANNELS.projectsClone,
    z.tuple([CloneProjectInputSchema]),
    async (input) =>
      await runDataOperation(
        async () => await projects.clone(input.remoteUrl, input.destinationPath),
      ),
  );
  handle(
    IPC_CHANNELS.projectsDemo,
    z.tuple([]),
    async () => await runDataOperation(async () => await projects.createDemo()),
  );
  handle(
    IPC_CHANNELS.projectsInitializeGit,
    z.tuple([z.string().uuid()]),
    async (projectId) =>
      await runDataOperation(async () => await projects.initializeGit(projectId)),
  );

  handle(
    IPC_CHANNELS.canvasLoad,
    z.tuple([ProjectIdSchema]),
    async (projectId) =>
      await runDataOperation(() => {
        if (!store.listProjects().some((project) => project.id === projectId && !project.missing)) {
          throw new Error('The selected project is no longer available.');
        }
        const existing = store.loadCanvas(projectId);
        if (existing) return existing;
        return store.saveCanvas({
          id: randomUUID(),
          projectId,
          name: 'Workshop',
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          updatedAt: new Date().toISOString(),
        });
      }),
  );
  handle(
    IPC_CHANNELS.canvasSave,
    z.tuple([CanvasDocumentSchema]),
    async (document) =>
      await runDataOperation(() => {
        if (
          !store
            .listProjects()
            .some((project) => project.id === document.projectId && !project.missing)
        ) {
          throw new Error('The selected project is no longer available.');
        }
        return store.saveCanvas(document);
      }),
  );

  handle(
    IPC_CHANNELS.auditList,
    z.tuple([AuditListInputSchema]),
    async (input) => await runDataOperation(() => store.listAuditEvents(input.limit)),
  );

  handle(
    IPC_CHANNELS.privacyExport,
    z.tuple([]),
    async () =>
      await runDataOperation(async () => {
        const selection = await dialog.showSaveDialog({
          title: 'Export portable Forgeboard data',
          defaultPath: 'forgeboard-local-data.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (selection.canceled || !selection.filePath) return null;
        await writeFile(selection.filePath, `${JSON.stringify(store.exportData(), null, 2)}\n`, {
          mode: 0o600,
        });
        store.appendAudit('export', 'local-data', 'allowed', {
          fileName: 'forgeboard-local-data.json',
        });
        return selection.filePath;
      }),
  );
  handle(
    IPC_CHANNELS.storageCreateBackup,
    z.tuple([]),
    async () =>
      await runDataOperation(async () => {
        const currentSettings = store.getSettings(createDefaultSettings());
        if (!currentSettings.backupsEnabled) {
          throw new Error('Enable local backups in Settings first.');
        }
        const destination = currentSettings.backupDirectory.trim();
        if (destination === '') {
          throw new Error('Choose a backup directory in Settings first.');
        }
        backups.markDataChanged();
        const outcome = await backups.flush();
        if (outcome.status !== 'created') {
          throw new Error('Forgeboard could not create the requested backup.');
        }
        const backup = outcome.backup;
        try {
          store.appendAudit('backup', 'create', 'allowed', {
            sizeBytes: backup.sizeBytes,
            sha256Prefix: backup.sha256.slice(0, 12),
          });
        } catch (error) {
          process.stderr.write(
            `Forgeboard created a backup but could not record its audit event: ${error instanceof Error ? error.message : 'unknown error'}\n`,
          );
        }
        return backup;
      }),
  );
  handle(IPC_CHANNELS.storageBackupHealth, z.tuple([]), async () =>
    BackupHealthSchema.parse(await runDataOperation(() => store.getBackupHealth())),
  );
  handle(
    IPC_CHANNELS.privacyDelete,
    z.tuple([z.literal('DELETE ALL LOCAL DATA')]),
    async (confirmation) => {
      if (confirmation !== 'DELETE ALL LOCAL DATA') throw new Error('Deletion was not confirmed.');
      await dataOperations.beginMutation('delete');
      try {
        return await performPrivacyDeletion({
          pauseBackups: async () => await backups.pause(),
          listMissingBackupIds: async () => await store.listMissingRecordedBackupIds(),
          confirmForgetMissingBackups: async (count) => {
            const decision = await dialog.showMessageBox({
              type: 'warning',
              title: 'Recorded backups are unavailable',
              message: `${count} recorded backup ${count === 1 ? 'file is' : 'files are'} unavailable.`,
              detail:
                'Forgeboard cannot prove that these backup copies were deleted. Reconnect their folders and cancel, or explicitly forget the missing records and continue. Forgotten copies may still exist on a detached drive or network location and will no longer be tracked by Delete Local Data.',
              buttons: ['Cancel deletion', 'Forget missing backups and continue'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            });
            return decision.response === 1;
          },
          resetDataServices: async () => {
            await awaitDataServices([
              runs.resetForPrivacy(),
              previews.resetForPrivacy(),
              extensions.resetForPrivacy(),
              git.resetForPrivacy(),
              checks.resetForPrivacy(),
              docker.pauseForShutdown(),
              recovery.pauseForExternalDataMutation(),
            ]);
          },
          deleteData: async (approvedMissingBackupIds) =>
            await store.deleteAllLocalData({ approvedMissingBackupIds }),
        });
      } finally {
        recovery.clearPendingPlans();
        resumeAfterDataMutation();
      }
    },
  );

  settings.registerIpcHandlers();
  runs.registerIpcHandlers();
  previews.registerIpcHandlers();
  extensions.registerIpcHandlers();
  docker.registerIpcHandlers();
  git.registerIpcHandlers();
  checks.registerIpcHandlers();
  recovery.registerIpcHandlers();
  return {
    settings,
    docker,
    runs,
    previews,
    extensions,
    git,
    checks,
    recovery,
    prepareToQuit: async () => {
      await prepareReversibleQuitBackup({
        beginExclusive: async () => await dataOperations.beginMutation('quit'),
        pauseAdmissions: pauseForShutdown,
        prepareBackup: async () => {
          const outcome = await backups.prepareShutdown();
          return outcome.status === 'missing-destination' ? 'missing-destination' : 'ready';
        },
        resumeAfterFailure: resumeAfterDataMutation,
      });
    },
    dispose: async () => {
      dataOperations.beginShutdown();
      settings.dispose();
      await recovery.dispose();
      if (dataOperations.mutationKind !== null && dataOperations.mutationKind !== 'quit') {
        await dataOperations.mutationCompletion;
      }
      if (!dataOperations.mutationInProgress) {
        await dataOperations.beginMutation('quit', { allowDuringShutdown: true });
      }
      if (!shutdownServicesPaused) {
        try {
          await pauseForShutdown(false);
        } catch (error) {
          process.stderr.write(
            `Forgeboard could not fully pause services before shutdown: ${error instanceof Error ? error.message : 'unknown error'}\n`,
          );
        }
      }
      const stopped = await Promise.allSettled([
        docker.dispose(),
        checks.dispose(),
        previews.dispose(),
        runs.dispose(),
        extensions.dispose(),
        git.dispose(),
      ]);
      for (const result of stopped) {
        if (result.status !== 'rejected') continue;
        process.stderr.write(
          `Forgeboard service shutdown failed: ${result.reason instanceof Error ? result.reason.message : 'unknown error'}\n`,
        );
      }
      unsubscribeBackupChanges();
      try {
        await backups.shutdown();
      } catch (error) {
        process.stderr.write(
          `Forgeboard shutdown backup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
        );
      }
    },
  };
}

function handle<Args extends unknown[], Output>(
  channel: string,
  schema: z.ZodType<Args>,
  operation: (...args: Args) => Output | Promise<Output>,
): void {
  ipcMain.handle(channel, async (_event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
    try {
      const args = schema.parse(rawArgs);
      return { ok: true, value: await operation(...args) };
    } catch (error) {
      const validation = error instanceof z.ZodError;
      return {
        ok: false,
        error: {
          code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message: validation
            ? 'Forgeboard rejected an invalid request.'
            : error instanceof Error
              ? error.message
              : 'The operation failed.',
        },
      };
    }
  });
}
