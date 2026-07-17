import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { PRODUCT } from '@forgeboard/core';
import { GitRemoteConfigurationService } from '@forgeboard/git-engine';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';

import {
  ApprovalListInputSchema,
  ApprovalRevocationInputSchema,
  ApprovalViewSchema,
} from '../shared/approvals/contracts.js';
import {
  AuditListInputSchema,
  BackupHealthSchema,
  CanvasDocumentSchema,
  ConfirmProjectRecoveryInputSchema,
  CreateProjectInputSchema,
  IPC_CHANNELS,
  LocalReferenceSelectionInputSchema,
  LocateProjectRecoveryInputSchema,
  type AppSettings,
  type IpcResult,
} from '../shared/application/contracts.js';
import { CommandReadinessRequestSchema } from '../shared/command-readiness/contracts.js';
import { IntegrityCheckInputSchema } from '../shared/integrity/contracts.js';
import { MachineSpecificValueSchema } from '../shared/settings/values.js';
import { ApprovalService } from './approvals/approval-service.js';
import { AutomaticBackupCoordinator } from './backups/automatic-backup-coordinator.js';
import { CheckIpcService } from './checks/check-ipc.js';
import { CheckRuntime } from './checks/check-runtime.js';
import { CommandReadinessService } from './command-readiness/service.js';
import { CollaborationIpcService } from './collaboration/ipc.js';
import { detectAgents, ProjectService } from './projects/project-service.js';
import { DockerIpcService } from './docker/docker-ipc.js';
import { ExtensionIpcService } from './extensions/extension-ipc.js';
import { FileIpcService } from './file-domain/ipc.js';
import { ProjectFileService } from './file-domain/service.js';
import { GitIpcService } from './git/git-ipc.js';
import { GitConnectionsIpcService, GitConnectionsService } from './git/connections/index.js';
import { GitConnectionsMutationCoordinator } from './git/connections/mutation-coordinator.js';
import { GitHubCliRuntimeService } from './git/github-cli/runtime.js';
import { GitTargetResolver } from './git/git-target-resolver.js';
import { GitDeliveryReadinessIpcService } from './git/readiness/ipc.js';
import { DeliveryReadinessService } from './git/readiness/service.js';
import { DeliveryReadinessShippingAuthority } from './git/readiness/shipping-authority.js';
import { GitRemoteDeliveryIpcService, GitRemoteDeliveryService } from './git/remote/index.js';
import { createNativeGitDelegateAuthorizer } from './git/delegates/native-confirmation.js';
import { createBundledGitRepositoryService } from './git/git-runtime.js';
import { IntegrityService } from './integrity/service.js';
import { DataOperationGate } from './lifecycle/data-operation-gate.js';
import { createProcessQuiescenceAdmission } from './lifecycle/process-quiescence.js';
import { performPrivacyDeletion } from './lifecycle/privacy-deletion.js';
import { OutboundActionGate } from './outbound/outbound-action-gate.js';
import { createGitHubCliCommandRunner } from './outbound/git/executors.js';
import { PreviewIpcService } from './previews/preview-ipc.js';
import { ProjectCloneIpcService } from './projects/project-clone-ipc.js';
import { AgentReadinessIpcService } from './readiness/ipc.js';
import { AgentReadinessService } from './readiness/service.js';
import { prepareReversibleQuitBackup } from './backups/quit-backup-preparation.js';
import { RecoveryIpcService } from './recovery/recovery-ipc.js';
import { RunService } from './runs/run-service.js';
import { SettingsIpcService } from './settings/settings-ipc.js';
import { SettingsPersistenceReadinessVerifier } from './settings/persistence-readiness.js';
import { FolderReadinessIpcService } from './settings/folder-readiness/ipc.js';
import { FolderReadinessService } from './settings/folder-readiness/service.js';
import type { LocalStore } from './storage.js';
import { TerminalIpcService } from './terminal/ipc.js';
import { TerminalService } from './terminal/service.js';
import { createWorkflowRuntimeComposition } from './workflow/host/composition.js';
import { WorkflowIpcService } from './workflow/host/ipc.js';
import { ExactCheckExecutor } from './workflow/exact-check/executor.js';
import { ExactCheckResolver } from './workflow/exact-check/resolution.js';
import { WorkflowArtifactActionResolver } from './workflow/exact-check/runtime/artifact-actions.js';
import { assertLiveMainFrame } from './security/ipc-authority.js';

const PathSchema = z.string().min(1).max(32_768);
const ProjectIdSchema = z.string().uuid();

export function createDefaultSettings(): AppSettings {
  const documents = app.getPath('documents');
  const platformShell = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh';
  const environmentShell = MachineSpecificValueSchema.safeParse(process.env.SHELL);
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
    customPermissionProfile: {
      runtime: 'host',
      filesystem: 'assigned-worktree-read-only',
      readPaths: ['.'],
      writePaths: [],
      ignoredFileRead: 'deny',
      sensitiveFileRead: 'deny',
      executablePolicy: 'selected-agent-only',
      allowedExecutables: [],
      forgeboardManagedActions: {
        developmentServers: 'deny',
        tests: 'deny',
      },
      requireReviewBeforePrimary: true,
      docker: {
        network: 'disabled',
        cpuLimit: 2,
        memoryMb: 4_096,
        mountHostCredentials: false,
      },
    },
    worktreeRoot: join(documents, PRODUCT.dataDirectoryName, PRODUCT.worktreeDirectoryName),
    worktreeCleanupPolicy: 'manual',
    branchPrefix: 'forgeboard/',
    gitIdentityName: '',
    gitIdentityEmail: '',
    gitRemote: 'origin',
    terminalShell: environmentShell.success ? environmentShell.data : platformShell,
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
    collaborationSubject: 'local-user',
    collaborationColor: '#6d5efc',
    collaborationRoom: 'default',
    collaborationReconnect: true,
    updateChannel: 'stable',
    automaticUpdateDownloads: false,
  };
}

export interface ApplicationServices {
  settings: SettingsIpcService;
  folderReadiness: FolderReadinessIpcService;
  readiness: AgentReadinessIpcService;
  projectClones: ProjectCloneIpcService;
  docker: DockerIpcService;
  runs: RunService;
  terminal: TerminalIpcService;
  previews: PreviewIpcService;
  extensions: ExtensionIpcService;
  files: FileIpcService;
  git: GitIpcService;
  deliveryReadiness: GitDeliveryReadinessIpcService;
  gitRemote: GitRemoteDeliveryIpcService;
  gitConnections: GitConnectionsIpcService;
  checks: CheckIpcService;
  collaboration: CollaborationIpcService;
  workflows: WorkflowIpcService;
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
  const withProjectGitAuthorization = async <Output>(
    event: IpcMainInvokeEvent,
    operation: (authority: {
      readonly parent: BrowserWindow;
      assertCurrent(): void;
    }) => Promise<Output>,
  ): Promise<Output> => {
    const authority = requireIpcWindowAuthority(event, 'project operation');
    const value = await repositories.git.withDelegateAuthorization(
      createNativeGitDelegateAuthorizer({
        assertCurrent: () => authority.assertCurrent(),
        show: async (options) => (await dialog.showMessageBox(authority.parent, options)).response,
      }),
      async () => await operation(authority),
    );
    authority.assertCurrent();
    return value;
  };
  const projects = new ProjectService(app, dialog, store, repositories);
  const projectFiles = new ProjectFileService(store);
  const files = new FileIpcService(projectFiles, shell, runDataOperation);
  const outbound = new OutboundActionGate(store);
  const collaboration = new CollaborationIpcService(dialog, outbound, {
    store,
  });
  const projectClones = new ProjectCloneIpcService(dialog, projects, outbound, runDataOperation);
  const transcripts = join(app.getPath('userData'), 'transcripts');
  const terminal = new TerminalIpcService(
    dialog,
    new TerminalService(store, join(transcripts, 'terminal'), () =>
      store.getSettings(createDefaultSettings()),
    ),
    undefined,
    (event) => collaboration.assertTerminalMutationAuthorized(event.sender),
  );
  const testAgentPath = app.isPackaged
    ? join(process.resourcesPath, 'test-agent', 'cli.js')
    : resolve(process.cwd(), '../../packages/test-agent/dist/cli.js');
  const agentReadiness = new AgentReadinessService(testAgentPath);
  const readiness = new AgentReadinessIpcService(dialog, agentReadiness, store, runDataOperation);
  const commandReadiness = new CommandReadinessService(store, app.getPath('home'));
  const folderReadinessService = new FolderReadinessService();
  const settingsPersistenceReadiness = new SettingsPersistenceReadinessVerifier(
    agentReadiness,
    folderReadinessService,
    commandReadiness,
  );
  const integrity = new IntegrityService(store);
  const approvals = new ApprovalService(store);
  const extensions = new ExtensionIpcService(app, dialog, store);
  const docker = new DockerIpcService(dialog, store, undefined, outbound);
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
    async (current, next) => await settingsPersistenceReadiness.verify(current, next),
    () => backups.refreshSchedule(),
    runDataOperation,
  );
  const folderReadiness = new FolderReadinessIpcService(folderReadinessService, runDataOperation);
  const runs = new RunService(
    store,
    () => store.getSettings(createDefaultSettings()),
    async (adapterId) =>
      (await extensions.listActiveAgentAdapters()).find((adapter) => adapter.id === adapterId),
    async (adapterId, expectedManifest, launch) =>
      await extensions.launchTrustedAdapter(adapterId, expectedManifest, launch),
    repositories,
    undefined,
    dialog,
  );
  const previews = new PreviewIpcService(dialog, store, () =>
    store.getSettings(createDefaultSettings()),
  );
  const checks = new CheckIpcService(
    dialog,
    store,
    (emit) => new CheckRuntime(store, () => store.getSettings(createDefaultSettings()), emit),
    approvals,
  );
  const workflowRuntime = createWorkflowRuntimeComposition({
    store,
    runs,
    repositories,
    getSettings: () => store.getSettings(createDefaultSettings()),
  });
  const workflowArtifactResolver = new WorkflowArtifactActionResolver(
    store,
    new GitTargetResolver(store, repositories, () => store.getSettings(createDefaultSettings())),
    join(app.getPath('userData'), 'verified-test-artifacts'),
  );
  const workflows = new WorkflowIpcService(dialog, store, workflowRuntime.createHost, {
    resetRuntime: workflowRuntime.resetForPrivacy,
    disposeRuntime: workflowRuntime.dispose,
    withGitDelegateAuthorization: async (authorize, operation) =>
      await repositories.git.withDelegateAuthorization(authorize, operation),
    authorizeMutation: (event) => collaboration.assertWorkflowMutationAuthorized(event.sender),
    resolveArtifact: async (input, action) => await workflowArtifactResolver.resolve(input, action),
    nativeShell: shell,
  });
  const deliveryTargets = new GitTargetResolver(store, repositories, () =>
    store.getSettings(createDefaultSettings()),
  );
  const deliveryExactResolver = new ExactCheckResolver(store, deliveryTargets, () =>
    store.getSettings(createDefaultSettings()),
  );
  const deliveryExactExecutor = new ExactCheckExecutor(store, deliveryTargets, () =>
    store.getSettings(createDefaultSettings()),
  );
  const deliveryAuthority = new DeliveryReadinessService(
    store,
    deliveryTargets,
    repositories,
    () => store.getSettings(createDefaultSettings()),
    deliveryExactResolver,
    deliveryExactExecutor,
    { audit: store, ownsExactExecutor: true },
  );
  const deliveryReadiness = new GitDeliveryReadinessIpcService(dialog, deliveryAuthority, store);
  const shippingReadiness = new DeliveryReadinessShippingAuthority(deliveryAuthority);
  const githubCli = new GitHubCliRuntimeService(store, {
    createRunner: (executable, beforeSpawn) =>
      createGitHubCliCommandRunner(executable, {
        ...(beforeSpawn === undefined ? {} : { beforeSpawn }),
      }),
    createValidationRunner: (executable, beforeSpawn) =>
      createGitHubCliCommandRunner(executable, {
        environment: gitHubCliValidationEnvironment(),
        ...(beforeSpawn === undefined ? {} : { beforeSpawn }),
        inheritEnvironment: false,
      }),
  });
  const gitRemote = new GitRemoteDeliveryIpcService(
    dialog,
    new GitRemoteDeliveryService(
      deliveryTargets,
      repositories,
      deliveryAuthority,
      shippingReadiness,
      outbound,
      store,
      {
        defaultRemote: () => store.getSettings(createDefaultSettings()).gitRemote,
        githubCliRuntime: githubCli,
      },
    ),
    store,
  );
  const gitConnectionsMutations = new GitConnectionsMutationCoordinator(gitRemote);
  const gitConnections = new GitConnectionsIpcService(
    dialog,
    new GitConnectionsService(store, new GitRemoteConfigurationService(repositories), {
      withMutationAdmission: async (operation) =>
        await gitConnectionsMutations.withRemoteConfigurationMutation(operation),
    }),
    githubCli,
    store,
    runDataOperation,
    () => gitRemote.invalidateGitHubRuntime(),
    undefined,
    async (operation) => await gitConnectionsMutations.withGitHubCliMutation(operation),
  );
  const git = new GitIpcService(
    dialog,
    store,
    repositories,
    () => store.getSettings(createDefaultSettings()),
    undefined,
    {
      withCleanupAdmission: createProcessQuiescenceAdmission(dataOperations, [
        workflows,
        runs,
        terminal,
        previews,
        checks,
        deliveryReadiness,
        gitRemote,
        gitConnections,
      ]),
      shippingReadiness,
    },
  );
  const resumeDataServices = (): void => {
    recovery.resumeAfterExternalDataMutation();
    readiness.resume();
    projectClones.resume();
    docker.resumeAfterShutdownPause();
    git.resumeAfterPrivacyReset();
    deliveryReadiness.resumeAfterPrivacyReset();
    gitRemote.resumeAfterPrivacyReset();
    gitConnections.resumeAfterPrivacyReset();
    extensions.resumeAfterPrivacyReset();
    previews.resumeAfterPrivacyReset();
    runs.resumeAfterPrivacyReset();
    terminal.resumeAfterPrivacyReset();
    checks.resumeAfterPrivacyReset();
    collaboration.resume();
    workflows.resumeAfterPrivacyReset();
    shutdownServicesPaused = false;
  };
  const resumeAfterDataMutation = (): void => {
    resumeDataServices();
    dataOperations.finishMutation();
    backups.resume();
  };
  const pauseForShutdown = async (includeRecovery = true): Promise<void> => {
    if (shutdownServicesPaused) return;
    await workflows.pauseForShutdown();
    // Git connection changes can temporarily pause remote delivery; drain them before pausing the
    // delivery service itself so a finishing local mutation cannot reopen shutdown admissions.
    await gitConnections.pauseForShutdown();
    const operations = [
      runs.pauseForShutdown(),
      terminal.pauseForShutdown(),
      previews.pauseForShutdown(),
      checks.pauseForShutdown(),
      readiness.pauseForShutdown(),
      projectClones.pauseForShutdown(),
      docker.pauseForShutdown(),
      extensions.pauseForShutdown(),
      git.pauseForShutdown(),
      deliveryReadiness.pauseForShutdown(),
      gitRemote.pauseForShutdown(),
      collaboration.pauseForShutdown(),
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
        await workflows.resetForPrivacy();
        await awaitDataServices([
          runs.resetForPrivacy(),
          terminal.resetForPrivacy(),
          previews.resetForPrivacy(),
          checks.resetForPrivacy(),
          extensions.pauseForDataMutation(),
          git.resetForPrivacy(),
          deliveryReadiness.resetForPrivacy(),
          gitRemote.resetForPrivacy(),
          gitConnections.resetForPrivacy(),
          collaboration.resetForPrivacy(),
        ]);
      } else {
        await workflows.pauseForDataMutation();
        runs.pauseForDataMutation();
        previews.pauseForDataMutation();
        checks.pauseForDataMutation();
        deliveryReadiness.pauseForDataMutation();
        await awaitDataServices([
          terminal.pauseForDataMutation(),
          extensions.pauseForDataMutation(),
          git.resetForPrivacy(),
          gitRemote.resetForPrivacy(),
          gitConnections.pauseForDataMutation(),
          collaboration.pauseForDataMutation(),
        ]);
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
    store.appendAudit('retention', 'startup', 'allowed', {
      ...startupRetention,
    });
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
  handleWithEvent(
    IPC_CHANNELS.commandsCheckReadiness,
    z.tuple([CommandReadinessRequestSchema]),
    async (event, input) =>
      await runDataOperation(async () => {
        const authority = requireIpcWindowAuthority(event, 'Command readiness check');
        const result = await commandReadiness.check(input);
        authority.assertCurrent();
        if (result.ready) commandReadiness.recordVerifiedSettingsReadiness(result);
        return result;
      }),
  );
  handle(
    IPC_CHANNELS.approvalsList,
    z.tuple([ApprovalListInputSchema]),
    async (input) =>
      await runDataOperation(() => ApprovalViewSchema.array().parse(approvals.list(input))),
  );
  handleWithEvent(
    IPC_CHANNELS.approvalsRevoke,
    z.tuple([ApprovalRevocationInputSchema]),
    async (event, input) =>
      await runDataOperation(() => {
        requireIpcWindowAuthority(event, 'Saved approval revocation').assertCurrent();
        const revoked = ApprovalViewSchema.parse(approvals.revoke(input));
        store.appendAudit('permission', 'saved-approval-revoke', 'allowed', {
          approvalId: revoked.record.id,
          projectId: revoked.record.scope.projectId,
          action: revoked.record.scope.action,
          resourceFingerprint: revoked.record.scope.resourceFingerprint,
        });
        return revoked;
      }),
  );
  handleWithEvent(
    IPC_CHANNELS.projectsRecent,
    z.tuple([]),
    async (event) =>
      await withProjectGitAuthorization(
        event,
        async (authority) =>
          await runDataOperation(() => projects.refreshRecentProjects(authority)),
      ),
  );
  handleWithEvent(
    IPC_CHANNELS.projectsPick,
    z.tuple([]),
    async (event) =>
      await withProjectGitAuthorization(
        event,
        async (authority) =>
          await runDataOperation(async () => await projects.pickRepository(authority)),
      ),
  );
  handleWithEvent(
    IPC_CHANNELS.projectsPickParent,
    z.tuple([]),
    async (event) =>
      await withProjectGitAuthorization(
        event,
        async (authority) =>
          await runDataOperation(async () => await projects.pickParent(authority)),
      ),
  );
  handleWithEvent(
    IPC_CHANNELS.projectsPickExecutable,
    z.tuple([]),
    async (event) =>
      await withProjectGitAuthorization(
        event,
        async (authority) =>
          await runDataOperation(async () => await projects.pickExecutable(authority)),
      ),
  );
  handleWithEvent(
    IPC_CHANNELS.projectsPickReferences,
    z.tuple([LocalReferenceSelectionInputSchema]),
    async (event, input) =>
      await withProjectGitAuthorization(
        event,
        async (authority) =>
          await runDataOperation(async () => await projects.pickReferences(input, authority)),
      ),
  );
  handleWithEvent(
    IPC_CHANNELS.projectsLocateMoved,
    z.tuple([LocateProjectRecoveryInputSchema]),
    async (event, input) =>
      await withProjectGitAuthorization(
        event,
        async (authority) =>
          await runDataOperation(
            async () => await projects.selectMovedProject(input.projectId, authority),
          ),
      ),
  );
  handleWithEvent(
    IPC_CHANNELS.projectsConfirmMoved,
    z.tuple([ConfirmProjectRecoveryInputSchema]),
    async (event, input) =>
      await withProjectGitAuthorization(
        event,
        async (authority) =>
          await runDataOperation(async () => await projects.confirmMovedProject(input, authority)),
      ),
  );
  handleWithEvent(
    IPC_CHANNELS.projectsOpen,
    z.tuple([PathSchema]),
    async (event, path) =>
      await withProjectGitAuthorization(
        event,
        async (authority) =>
          await runDataOperation(async () => await projects.open(path, authority)),
      ),
  );
  handleWithEvent(
    IPC_CHANNELS.projectsCreate,
    z.tuple([CreateProjectInputSchema]),
    async (event, input) =>
      await withProjectGitAuthorization(
        event,
        async (authority) =>
          await runDataOperation(
            async () =>
              await projects.create(input.parentPath, input.name, input.initializeGit, authority),
          ),
      ),
  );
  handleWithEvent(
    IPC_CHANNELS.projectsDemo,
    z.tuple([]),
    async (event) =>
      await withProjectGitAuthorization(
        event,
        async (authority) =>
          await runDataOperation(async () => await projects.createDemo(authority)),
      ),
  );
  handleWithEvent(
    IPC_CHANNELS.projectsInitializeGit,
    z.tuple([z.string().uuid()]),
    async (event, projectId) =>
      await withProjectGitAuthorization(
        event,
        async (authority) =>
          await runDataOperation(async () => await projects.initializeGit(projectId, authority)),
      ),
  );

  handleWithEvent(
    IPC_CHANNELS.canvasLoad,
    z.tuple([ProjectIdSchema]),
    async (event, projectId) =>
      await runDataOperation(() => {
        requireIpcWindowAuthority(event, 'Canvas load').assertCurrent();
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
  handleWithEvent(
    IPC_CHANNELS.canvasSave,
    z.tuple([CanvasDocumentSchema]),
    async (event, document) =>
      await runDataOperation(() => {
        requireIpcWindowAuthority(event, 'Canvas save').assertCurrent();
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

  handleWithEvent(
    IPC_CHANNELS.privacyExport,
    z.tuple([]),
    async (event) =>
      await runDataOperation(async () => {
        const authority = requireIpcWindowAuthority(event, 'Local-data export');
        const selection = await dialog.showSaveDialog(authority.parent, {
          title: 'Export portable Forgeboard data',
          defaultPath: 'forgeboard-local-data.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        authority.assertCurrent();
        if (selection.canceled || !selection.filePath) return null;
        await writeFile(selection.filePath, `${JSON.stringify(store.exportData(), null, 2)}\n`, {
          mode: 0o600,
        });
        authority.assertCurrent();
        store.appendAudit('export', 'local-data', 'allowed', {
          fileName: 'forgeboard-local-data.json',
        });
        return selection.filePath;
      }),
  );
  handleWithEvent(
    IPC_CHANNELS.storageCreateBackup,
    z.tuple([]),
    async (event) =>
      await runDataOperation(async () => {
        const authority = requireIpcWindowAuthority(event, 'Manual backup');
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
        authority.assertCurrent();
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
    IPC_CHANNELS.storageCheckIntegrity,
    z.tuple([IntegrityCheckInputSchema]),
    async (input) => await runDataOperation(() => integrity.check(input)),
  );
  handleWithEvent(
    IPC_CHANNELS.privacyDelete,
    z.tuple([z.literal('DELETE ALL LOCAL DATA')]),
    async (event, confirmation) => {
      const authority = requireIpcWindowAuthority(event, 'Local-data deletion');
      if (confirmation !== 'DELETE ALL LOCAL DATA') throw new Error('Deletion was not confirmed.');
      await dataOperations.beginMutation('delete');
      try {
        authority.assertCurrent();
        return await performPrivacyDeletion({
          pauseBackups: async () => await backups.pause(),
          listMissingBackupIds: async () => await store.listMissingRecordedBackupIds(),
          confirmForgetMissingBackups: async (count) => {
            authority.assertCurrent();
            const decision = await dialog.showMessageBox(authority.parent, {
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
            authority.assertCurrent();
            return decision.response === 1;
          },
          resetDataServices: async () => {
            agentReadiness.clearVerifiedSettingsReadiness();
            commandReadiness.clearVerifiedSettingsReadiness();
            await workflows.resetForPrivacy();
            await awaitDataServices([
              runs.resetForPrivacy(),
              terminal.resetForPrivacy(),
              previews.resetForPrivacy(),
              extensions.resetForPrivacy(),
              git.resetForPrivacy(),
              deliveryReadiness.resetForPrivacy(),
              gitRemote.resetForPrivacy(),
              gitConnections.resetForPrivacy(),
              checks.resetForPrivacy(),
              docker.pauseForShutdown(),
              recovery.pauseForExternalDataMutation(),
              collaboration.resetForPrivacy(),
            ]);
          },
          deleteData: async (approvedMissingBackupIds) => {
            authority.assertCurrent();
            const outcome = await store.deleteAllLocalData({
              approvedMissingBackupIds,
            });
            authority.assertCurrent();
            return outcome;
          },
        });
      } finally {
        recovery.clearPendingPlans();
        resumeAfterDataMutation();
      }
    },
  );

  settings.registerIpcHandlers();
  folderReadiness.registerIpcHandler();
  readiness.registerIpcHandler();
  projectClones.registerIpcHandler();
  runs.registerIpcHandlers();
  terminal.registerIpcHandlers();
  previews.registerIpcHandlers();
  extensions.registerIpcHandlers();
  files.registerIpcHandlers();
  docker.registerIpcHandlers();
  git.registerIpcHandlers();
  deliveryReadiness.registerIpcHandlers();
  gitRemote.registerIpcHandlers();
  gitConnections.registerIpcHandlers();
  checks.registerIpcHandlers();
  collaboration.registerIpcHandlers();
  workflows.registerIpcHandlers();
  recovery.registerIpcHandlers();
  return {
    settings,
    folderReadiness,
    readiness,
    projectClones,
    docker,
    runs,
    terminal,
    previews,
    extensions,
    files,
    git,
    deliveryReadiness,
    gitRemote,
    gitConnections,
    checks,
    collaboration,
    workflows,
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
      folderReadiness.dispose();
      await files.dispose();
      await recovery.dispose();
      if (dataOperations.mutationKind !== null && dataOperations.mutationKind !== 'quit') {
        await dataOperations.mutationCompletion;
      }
      if (!dataOperations.mutationInProgress) {
        await dataOperations.beginMutation('quit', {
          allowDuringShutdown: true,
        });
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
      const workflowStopped = await Promise.allSettled([workflows.dispose()]);
      const stopped = await Promise.allSettled([
        docker.dispose(),
        projectClones.dispose(),
        checks.dispose(),
        readiness.dispose(),
        previews.dispose(),
        runs.dispose(),
        terminal.dispose(),
        extensions.dispose(),
        git.dispose(),
        deliveryReadiness.dispose(),
        gitRemote.dispose(),
        gitConnections.dispose(),
        collaboration.dispose(),
      ]);
      for (const result of [...workflowStopped, ...stopped]) {
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
  ipcMain.handle(channel, async (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
    try {
      const authority = requireIpcWindowAuthority(event, 'Forgeboard request');
      const args = schema.parse(rawArgs);
      const value = await operation(...args);
      authority.assertCurrent();
      return { ok: true, value };
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

function handleWithEvent<Args extends unknown[], Output>(
  channel: string,
  schema: z.ZodType<Args>,
  operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
): void {
  ipcMain.handle(channel, async (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
    try {
      const authority = requireIpcWindowAuthority(event, 'Forgeboard request');
      const args = schema.parse(rawArgs);
      const value = await operation(event, ...args);
      authority.assertCurrent();
      return { ok: true, value };
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

function requireIpcWindowAuthority(
  event: IpcMainInvokeEvent,
  operation: string,
): {
  readonly parent: BrowserWindow;
  assertCurrent(): void;
} {
  assertLiveMainFrame(event, operation);
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (parent === null || parent.isDestroyed()) {
    throw new Error(`${operation} requires a live Forgeboard window.`);
  }
  const assertCurrent = (): void => {
    assertLiveMainFrame(event, operation);
    if (parent.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== parent) {
      throw new Error('The originating Forgeboard window changed or closed.');
    }
  };
  return { parent, assertCurrent };
}

/** Environment needed to resolve and start a local executable, intentionally excluding auth data. */
function gitHubCliValidationEnvironment(): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string> = {};
  const allowedNames = [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TEMP',
    'TMP',
  ] as const;
  for (const name of allowedNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
