import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { PRODUCT } from '@forgeboard/core';
import { app, dialog, ipcMain } from 'electron';
import { z } from 'zod';

import {
  AuditListInputSchema,
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
import { detectAgents, ProjectService } from './project-service.js';
import { DockerIpcService } from './docker-ipc.js';
import { ExtensionIpcService } from './extension-ipc.js';
import { GitIpcService } from './git-ipc.js';
import { createBundledGitRepositoryService } from './git-runtime.js';
import { PreviewIpcService } from './preview-ipc.js';
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
  dispose(): void;
}

export function registerIpcHandlers(store: LocalStore): ApplicationServices {
  const repositories = createBundledGitRepositoryService();
  const projects = new ProjectService(app, dialog, store, repositories);
  const transcripts = join(app.getPath('userData'), 'transcripts');
  const testAgentPath = app.isPackaged
    ? join(process.resourcesPath, 'test-agent', 'cli.js')
    : resolve(process.cwd(), '../../packages/test-agent/dist/cli.js');
  const extensions = new ExtensionIpcService(app, dialog, store);
  const docker = new DockerIpcService(dialog, store);
  const settings = new SettingsIpcService(dialog, store, createDefaultSettings);
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
  let dataDeletionInProgress = false;
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
    const settings = store.getSettings(createDefaultSettings());
    return detectAgents(
      testAgentPath,
      await extensions.listActiveAgentAdapters(),
      settings.agentExecutableOverrides,
      settings.customAgent,
    );
  });
  handle(IPC_CHANNELS.projectsRecent, z.tuple([]), () => projects.refreshRecentProjects());
  handle(IPC_CHANNELS.projectsPick, z.tuple([]), async () => projects.pickRepository());
  handle(IPC_CHANNELS.projectsPickParent, z.tuple([]), async () => projects.pickParent());
  handle(IPC_CHANNELS.projectsPickExecutable, z.tuple([]), async () => projects.pickExecutable());
  handle(
    IPC_CHANNELS.projectsPickReferences,
    z.tuple([LocalReferenceSelectionInputSchema]),
    async (input) => projects.pickReferences(input),
  );
  handle(
    IPC_CHANNELS.projectsLocateMoved,
    z.tuple([LocateProjectRecoveryInputSchema]),
    async (input) => projects.selectMovedProject(input.projectId),
  );
  handle(
    IPC_CHANNELS.projectsConfirmMoved,
    z.tuple([ConfirmProjectRecoveryInputSchema]),
    async (input) => projects.confirmMovedProject(input),
  );
  handle(IPC_CHANNELS.projectsOpen, z.tuple([PathSchema]), async (path) => projects.open(path));
  handle(IPC_CHANNELS.projectsCreate, z.tuple([CreateProjectInputSchema]), async (input) =>
    projects.create(input.parentPath, input.name, input.initializeGit),
  );
  handle(IPC_CHANNELS.projectsClone, z.tuple([CloneProjectInputSchema]), async (input) =>
    projects.clone(input.remoteUrl, input.destinationPath),
  );
  handle(IPC_CHANNELS.projectsDemo, z.tuple([]), async () => projects.createDemo());

  handle(IPC_CHANNELS.canvasLoad, z.tuple([ProjectIdSchema]), (projectId) => {
    if (dataDeletionInProgress) throw new Error('Local data deletion is in progress.');
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
  });
  handle(IPC_CHANNELS.canvasSave, z.tuple([CanvasDocumentSchema]), (document) => {
    if (dataDeletionInProgress) throw new Error('Local data deletion is in progress.');
    if (
      !store.listProjects().some((project) => project.id === document.projectId && !project.missing)
    ) {
      throw new Error('The selected project is no longer available.');
    }
    return store.saveCanvas(document);
  });

  handle(IPC_CHANNELS.auditList, z.tuple([AuditListInputSchema]), (input) =>
    store.listAuditEvents(input.limit),
  );

  handle(IPC_CHANNELS.privacyExport, z.tuple([]), async () => {
    const selection = await dialog.showSaveDialog({
      title: 'Export all local Forgeboard data',
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
  });
  handle(IPC_CHANNELS.storageCreateBackup, z.tuple([]), async () => {
    if (dataDeletionInProgress) throw new Error('Local data deletion is in progress.');
    const settings = store.getSettings(createDefaultSettings());
    if (!settings.backupsEnabled) throw new Error('Enable local backups in Settings first.');
    const destination = settings.backupDirectory.trim();
    if (destination === '') throw new Error('Choose a backup directory in Settings first.');
    const backup = await store.createBackup(destination);
    store.appendAudit('backup', 'create', 'allowed', {
      sizeBytes: backup.sizeBytes,
      sha256Prefix: backup.sha256.slice(0, 12),
    });
    return backup;
  });
  handle(
    IPC_CHANNELS.privacyDelete,
    z.tuple([z.literal('DELETE ALL LOCAL DATA')]),
    async (confirmation) => {
      if (confirmation !== 'DELETE ALL LOCAL DATA') throw new Error('Deletion was not confirmed.');
      if (dataDeletionInProgress) throw new Error('Local data deletion is already in progress.');
      dataDeletionInProgress = true;
      try {
        await runs.resetForPrivacy();
        await previews.resetForPrivacy();
        await extensions.resetForPrivacy();
        await git.resetForPrivacy();
        await store.deleteAllLocalData();
        return true;
      } finally {
        git.resumeAfterPrivacyReset();
        extensions.resumeAfterPrivacyReset();
        previews.resumeAfterPrivacyReset();
        runs.resumeAfterPrivacyReset();
        dataDeletionInProgress = false;
      }
    },
  );

  settings.registerIpcHandlers();
  runs.registerIpcHandlers();
  previews.registerIpcHandlers();
  extensions.registerIpcHandlers();
  docker.registerIpcHandlers();
  git.registerIpcHandlers();
  return {
    settings,
    docker,
    runs,
    previews,
    extensions,
    git,
    dispose: () => {
      settings.dispose();
      docker.dispose();
      extensions.dispose();
      previews.dispose();
      runs.dispose();
      git.dispose();
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
