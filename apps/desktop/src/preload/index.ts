import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';

import type { ForgeboardApi } from '../shared/api.js';
import { AgentReadinessResultSchema } from '../shared/readiness/contracts.js';
import { CommandReadinessResultSchema } from '../shared/command-readiness/contracts.js';
import { ApprovalViewSchema } from '../shared/approvals/contracts.js';
import {
  CheckEventEnvelopeSchema,
  CheckExecutionViewSchema,
  CheckPlanViewSchema,
} from '../shared/checks/contracts.js';
import {
  COLLABORATION_IPC_CHANNELS,
  CollaborationConnectionSchema,
  CollaborationCreateCommentInputSchema,
  CollaborationCreateCommentResultSchema,
  CollaborationEventSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinResultSchema,
  CollaborationMetadataSnapshotSchema,
  CollaborationPublishInputSchema,
  CollaborationPublishReceiptSchema,
  CollaborationSyncCheckpointInputSchema,
  CollaborationDiscardRejectedCommentInputSchema,
  CollaborationSyncRecoverInputSchema,
  CollaborationSyncRecoverySchema,
  CollaborationUpdateAwarenessInputSchema,
} from '../shared/collaboration/index.js';
import type { IpcResult } from '../shared/application/contracts.js';
import {
  AppCloseRequestSchema,
  AppCloseResponseSchema,
  BackupHealthSchema,
  BackupResultSchema,
  ExtensionDiscoveryViewSchema,
  ExtensionInstallPlanViewSchema,
  IPC_CHANNELS,
  LocalReferenceSelectionResultSchema,
  PreviewEventEnvelopeSchema,
  ProjectRecoveryAssessmentSchema,
  ProjectSchema,
  RunEventEnvelopeSchema,
  ipcResultSchema,
} from '../shared/application/contracts.js';
import {
  SettingsRepairEvidenceSchema,
  SettingsRepairSummarySchema,
} from '../shared/settings/repair/contracts.js';
import { DockerPullResultSchema, DockerReadinessSchema } from '../shared/docker/contracts.js';
import {
  GitCommitPlanViewSchema,
  GitCommitResultViewSchema,
  GitDiscardPlanViewSchema,
  GitReviewViewSchema,
} from '../shared/git/contracts.js';
import {
  GitShippingPlanViewSchema,
  GitShippingResultViewSchema,
} from '../shared/git/shipping-contracts.js';
import { IntegrityCheckResultSchema } from '../shared/integrity/contracts.js';
import { PREVIEW_TARGET_IPC_CHANNELS, PreviewTargetListSchema } from '../shared/preview/targets.js';
import {
  RECOVERY_IPC_CHANNELS,
  RecoveryImportCountsSchema,
  RecoveryImportPlanSchema,
  RecoveryRestoredCanvasSchema,
  RecoverySnapshotRestorePlanSchema,
  RecoverySnapshotSummarySchema,
} from '../shared/recovery/contracts.js';
import {
  WORKFLOW_IPC_CHANNELS,
  WorkflowApproveHumanDecisionInputSchema,
  WorkflowApproveNodeInputSchema,
  WorkflowArtifactActionInputSchema,
  WorkflowCancelInputSchema,
  WorkflowCancelNodeInputSchema,
  WorkflowEventEnvelopeSchema,
  WorkflowExecutionViewSchema,
  WorkflowGetInputSchema,
  WorkflowInteractionEventEnvelopeSchema,
  WorkflowListInputSchema,
  WorkflowNodeInputSchema,
  WorkflowNodeInterruptSchema,
  WorkflowResolveRevisionEscapeInputSchema,
  WorkflowReviewDecisionInputSchema,
  WorkflowStartInputSchema,
} from '../shared/workflow/contracts.js';
import { createFileApi } from './files.js';
import { createGitConnectionsApi } from './git/connections/index.js';
import { createGitLifecycleApi } from './git/lifecycle/cleanup.js';
import { createGitDeliveryReadinessApi } from './git/readiness/bridge.js';
import { createGitRemoteDeliveryApi } from './git/remote/index.js';
import { createGitReviewNotesApi } from './git-review-notes.js';
import { createRunHistoryApi } from './runs/history.js';
import { createRunContinuationApi } from './runs/continuation.js';
import { checkSettingsFolderReadiness } from './settings-folder-readiness.js';
import { createTerminalApi } from './terminal/index.js';
import { createPreviewSurfaceApi } from './preview/surface/index.js';
import { createProviderConnectionsApi } from './provider-connections/index.js';

async function invokeValidated<Schema extends z.ZodTypeAny>(
  channel: string,
  schema: Schema,
  ...args: unknown[]
): Promise<IpcResult<z.output<Schema>>> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args);
  return ipcResultSchema(schema).parse(result);
}

const api: ForgeboardApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
    onCloseRequested: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        const request = AppCloseRequestSchema.safeParse(payload);
        if (!request.success) return;
        void (async () => {
          let saved = false;
          try {
            saved = (await listener()) === true;
          } catch {
            saved = false;
          }
          const response = AppCloseResponseSchema.parse({
            requestId: request.data.requestId,
            saved,
          });
          ipcRenderer.send(IPC_CHANNELS.appCloseResponse, response);
        })();
      };
      ipcRenderer.on(IPC_CHANNELS.appCloseRequested, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.appCloseRequested, handler);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    update: (settings) => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, settings),
    reset: () => ipcRenderer.invoke(IPC_CHANNELS.settingsReset),
    export: () => ipcRenderer.invoke(IPC_CHANNELS.settingsExport),
    import: () => ipcRenderer.invoke(IPC_CHANNELS.settingsImport),
    listRepairs: () =>
      invokeValidated(IPC_CHANNELS.settingsRepairList, SettingsRepairSummarySchema.array()),
    getRepair: (repairId) =>
      invokeValidated(IPC_CHANNELS.settingsRepairGet, SettingsRepairEvidenceSchema, repairId),
    exportRepair: (repairId) =>
      invokeValidated(IPC_CHANNELS.settingsRepairExport, z.string().nullable(), repairId),
    checkFolderReadiness: (input) =>
      checkSettingsFolderReadiness(async (channel, ...args) => {
        const result: unknown = await ipcRenderer.invoke(channel, ...args);
        return result;
      }, input),
  },
  agents: {
    detect: () => ipcRenderer.invoke(IPC_CHANNELS.agentsDetect),
    checkReadiness: (input) =>
      invokeValidated(
        IPC_CHANNELS.agentsCheckReadiness,
        AgentReadinessResultSchema.nullable(),
        input,
      ),
    connections: createProviderConnectionsApi((channel, ...args) =>
      ipcRenderer.invoke(channel, ...args),
    ),
  },
  commands: {
    checkReadiness: (input) =>
      invokeValidated(IPC_CHANNELS.commandsCheckReadiness, CommandReadinessResultSchema, input),
  },
  approvals: {
    list: (input) => invokeValidated(IPC_CHANNELS.approvalsList, ApprovalViewSchema.array(), input),
    revoke: (input) => invokeValidated(IPC_CHANNELS.approvalsRevoke, ApprovalViewSchema, input),
  },
  docker: {
    check: (input) =>
      invokeValidated(IPC_CHANNELS.dockerCheck, DockerReadinessSchema.nullable(), input),
    pull: (input) => invokeValidated(IPC_CHANNELS.dockerPull, DockerPullResultSchema, input),
  },
  projects: {
    recent: () => ipcRenderer.invoke(IPC_CHANNELS.projectsRecent),
    pick: () => ipcRenderer.invoke(IPC_CHANNELS.projectsPick),
    pickParent: () => ipcRenderer.invoke(IPC_CHANNELS.projectsPickParent),
    pickExecutable: () => ipcRenderer.invoke(IPC_CHANNELS.projectsPickExecutable),
    pickReferences: (input) =>
      invokeValidated(
        IPC_CHANNELS.projectsPickReferences,
        LocalReferenceSelectionResultSchema,
        input,
      ),
    locateMoved: (input) =>
      invokeValidated(
        IPC_CHANNELS.projectsLocateMoved,
        ProjectRecoveryAssessmentSchema.nullable(),
        input,
      ),
    confirmMoved: (input) =>
      invokeValidated(IPC_CHANNELS.projectsConfirmMoved, ProjectSchema, input),
    open: (path) => ipcRenderer.invoke(IPC_CHANNELS.projectsOpen, path),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectsCreate, input),
    clone: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectsClone, input),
    demo: () => ipcRenderer.invoke(IPC_CHANNELS.projectsDemo),
    initializeGit: (projectId) =>
      invokeValidated(IPC_CHANNELS.projectsInitializeGit, ProjectSchema.nullable(), projectId),
  },
  canvas: {
    load: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.canvasLoad, projectId),
    save: (document) => ipcRenderer.invoke(IPC_CHANNELS.canvasSave, document),
  },
  files: createFileApi(async (channel, ...args) => {
    const result: unknown = await ipcRenderer.invoke(channel, ...args);
    return result;
  }),
  collaboration: {
    get: () =>
      invokeValidated(COLLABORATION_IPC_CHANNELS.get, CollaborationConnectionSchema.nullable()),
    snapshot: () =>
      invokeValidated(
        COLLABORATION_IPC_CHANNELS.snapshot,
        CollaborationMetadataSnapshotSchema.nullable(),
      ),
    join: async (input) => {
      const result: unknown = await ipcRenderer.invoke(
        COLLABORATION_IPC_CHANNELS.join,
        CollaborationJoinInputSchema.parse(input),
      );
      return CollaborationJoinResultSchema.parse(result);
    },
    leave: () =>
      invokeValidated(COLLABORATION_IPC_CHANNELS.leave, CollaborationConnectionSchema.nullable()),
    publish: (input) =>
      invokeValidated(
        COLLABORATION_IPC_CHANNELS.publish,
        CollaborationPublishReceiptSchema.nullable(),
        CollaborationPublishInputSchema.parse(input),
      ),
    recover: (input) =>
      invokeValidated(
        COLLABORATION_IPC_CHANNELS.recover,
        CollaborationSyncRecoverySchema.nullable(),
        CollaborationSyncRecoverInputSchema.parse(input),
      ),
    checkpoint: (input) =>
      invokeValidated(
        COLLABORATION_IPC_CHANNELS.checkpoint,
        z.boolean(),
        CollaborationSyncCheckpointInputSchema.parse(input),
      ),
    discardRejectedComment: (input) =>
      invokeValidated(
        COLLABORATION_IPC_CHANNELS.discardRejectedComment,
        CollaborationSyncRecoverySchema.nullable(),
        CollaborationDiscardRejectedCommentInputSchema.parse(input),
      ),
    createComment: (input) =>
      invokeValidated(
        COLLABORATION_IPC_CHANNELS.createComment,
        CollaborationCreateCommentResultSchema.nullable(),
        CollaborationCreateCommentInputSchema.parse(input),
      ),
    updateAwareness: (input) =>
      invokeValidated(
        COLLABORATION_IPC_CHANNELS.updateAwareness,
        z.boolean(),
        CollaborationUpdateAwarenessInputSchema.parse(input),
      ),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        const event = CollaborationEventSchema.safeParse(payload);
        if (event.success) listener(event.data);
      };
      ipcRenderer.on(COLLABORATION_IPC_CHANNELS.event, handler);
      return () => ipcRenderer.removeListener(COLLABORATION_IPC_CHANNELS.event, handler);
    },
  },
  runs: {
    ...createRunHistoryApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
    ...createRunContinuationApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
    approve: (runId) => ipcRenderer.invoke(IPC_CHANNELS.runsApprove, runId),
    sendInput: (runId, data) => ipcRenderer.invoke(IPC_CHANNELS.runsInput, runId, data),
    interrupt: (runId) => ipcRenderer.invoke(IPC_CHANNELS.runsInterrupt, runId),
    terminate: (runId) => ipcRenderer.invoke(IPC_CHANNELS.runsTerminate, runId),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        listener(RunEventEnvelopeSchema.parse(payload));
      };
      ipcRenderer.on(IPC_CHANNELS.runsEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.runsEvent, handler);
    },
  },
  terminal: createTerminalApi(
    (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    (channel, listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        listener(payload);
      };
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  ),
  previews: {
    listTargets: (input) =>
      invokeValidated(PREVIEW_TARGET_IPC_CHANNELS.list, PreviewTargetListSchema, input),
    start: (input) => ipcRenderer.invoke(IPC_CHANNELS.previewsStart, input),
    restart: (input) => ipcRenderer.invoke(IPC_CHANNELS.previewsRestart, input),
    stop: (input) => ipcRenderer.invoke(IPC_CHANNELS.previewsStop, input),
    get: (input) => ipcRenderer.invoke(IPC_CHANNELS.previewsGet, input),
    navigate: (input) => ipcRenderer.invoke(IPC_CHANNELS.previewsNavigate, input),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        listener(PreviewEventEnvelopeSchema.parse(payload));
      };
      ipcRenderer.on(IPC_CHANNELS.previewsEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.previewsEvent, handler);
    },
  },
  previewSurfaces: createPreviewSurfaceApi(ipcRenderer),
  checks: {
    prepare: (input) => invokeValidated(IPC_CHANNELS.checksPrepare, CheckPlanViewSchema, input),
    confirm: (input) =>
      invokeValidated(IPC_CHANNELS.checksConfirm, CheckExecutionViewSchema.nullable(), input),
    list: (input) =>
      invokeValidated(IPC_CHANNELS.checksList, CheckExecutionViewSchema.array(), input),
    cancel: (input) => invokeValidated(IPC_CHANNELS.checksCancel, CheckExecutionViewSchema, input),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        listener(CheckEventEnvelopeSchema.parse(payload));
      };
      ipcRenderer.on(IPC_CHANNELS.checksEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.checksEvent, handler);
    },
  },
  workflows: {
    start: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.start,
        WorkflowExecutionViewSchema,
        WorkflowStartInputSchema.parse(input),
      ),
    get: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.get,
        WorkflowExecutionViewSchema,
        WorkflowGetInputSchema.parse(input),
      ),
    list: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.list,
        WorkflowExecutionViewSchema.array(),
        WorkflowListInputSchema.parse(input),
      ),
    approveNode: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.approveNode,
        WorkflowExecutionViewSchema.nullable(),
        WorkflowApproveNodeInputSchema.parse(input),
      ),
    approveHuman: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.approveHuman,
        WorkflowExecutionViewSchema.nullable(),
        WorkflowApproveHumanDecisionInputSchema.parse(input),
      ),
    decideReview: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.decideReview,
        WorkflowExecutionViewSchema.nullable(),
        WorkflowReviewDecisionInputSchema.parse(input),
      ),
    resolveRevisionEscape: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.resolveRevisionEscape,
        WorkflowExecutionViewSchema.nullable(),
        WorkflowResolveRevisionEscapeInputSchema.parse(input),
      ),
    cancel: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.cancel,
        WorkflowExecutionViewSchema.nullable(),
        WorkflowCancelInputSchema.parse(input),
      ),
    cancelNode: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.cancelNode,
        WorkflowExecutionViewSchema.nullable(),
        WorkflowCancelNodeInputSchema.parse(input),
      ),
    revealArtifact: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.revealArtifact,
        z.null(),
        WorkflowArtifactActionInputSchema.parse(input),
      ),
    openArtifact: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.openArtifact,
        z.null(),
        WorkflowArtifactActionInputSchema.parse(input),
      ),
    sendInput: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.sendInput,
        z.boolean(),
        WorkflowNodeInputSchema.parse(input),
      ),
    interrupt: (input) =>
      invokeValidated(
        WORKFLOW_IPC_CHANNELS.interrupt,
        z.boolean(),
        WorkflowNodeInterruptSchema.parse(input),
      ),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        listener(WorkflowEventEnvelopeSchema.parse(payload));
      };
      ipcRenderer.on(WORKFLOW_IPC_CHANNELS.event, handler);
      return () => ipcRenderer.removeListener(WORKFLOW_IPC_CHANNELS.event, handler);
    },
    onInteractionEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        const parsed = WorkflowInteractionEventEnvelopeSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(WORKFLOW_IPC_CHANNELS.interactionEvent, handler);
      return () => ipcRenderer.removeListener(WORKFLOW_IPC_CHANNELS.interactionEvent, handler);
    },
  },
  audit: {
    list: (input) => ipcRenderer.invoke(IPC_CHANNELS.auditList, input),
  },
  extensions: {
    list: () => invokeValidated(IPC_CHANNELS.extensionsList, ExtensionDiscoveryViewSchema),
    choose: (kind) =>
      invokeValidated(
        IPC_CHANNELS.extensionsChoose,
        ExtensionInstallPlanViewSchema.nullable(),
        kind,
      ),
    approve: (input) =>
      invokeValidated(IPC_CHANNELS.extensionsApprove, ExtensionDiscoveryViewSchema, input),
    remove: (input) =>
      invokeValidated(IPC_CHANNELS.extensionsRemove, ExtensionDiscoveryViewSchema, input),
  },
  git: {
    review: (input) => invokeValidated(IPC_CHANNELS.gitReview, GitReviewViewSchema, input),
    stagePaths: (input) => invokeValidated(IPC_CHANNELS.gitStagePaths, GitReviewViewSchema, input),
    stageHunks: (input) => invokeValidated(IPC_CHANNELS.gitStageHunks, GitReviewViewSchema, input),
    unstagePaths: (input) =>
      invokeValidated(IPC_CHANNELS.gitUnstagePaths, GitReviewViewSchema, input),
    unstageHunks: (input) =>
      invokeValidated(IPC_CHANNELS.gitUnstageHunks, GitReviewViewSchema, input),
    prepareDiscard: (input) =>
      invokeValidated(IPC_CHANNELS.gitPrepareDiscard, GitDiscardPlanViewSchema, input),
    confirmDiscard: (input) =>
      invokeValidated(IPC_CHANNELS.gitConfirmDiscard, GitReviewViewSchema.nullable(), input),
    prepareCommit: (input) =>
      invokeValidated(IPC_CHANNELS.gitPrepareCommit, GitCommitPlanViewSchema, input),
    confirmCommit: (input) =>
      invokeValidated(IPC_CHANNELS.gitConfirmCommit, GitCommitResultViewSchema.nullable(), input),
    prepareShipping: (input) =>
      invokeValidated(IPC_CHANNELS.gitPrepareShipping, GitShippingPlanViewSchema, input),
    confirmShipping: (input) =>
      invokeValidated(
        IPC_CHANNELS.gitConfirmShipping,
        GitShippingResultViewSchema.nullable(),
        input,
      ),
    readiness: createGitDeliveryReadinessApi((channel, ...args) =>
      ipcRenderer.invoke(channel, ...args),
    ),
    connections: createGitConnectionsApi((channel, ...args) =>
      ipcRenderer.invoke(channel, ...args),
    ),
    remote: createGitRemoteDeliveryApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
    lifecycle: createGitLifecycleApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
    reviewNotes: createGitReviewNotesApi(async (channel, ...args) => {
      const result: unknown = await ipcRenderer.invoke(channel, ...args);
      return result;
    }),
  },
  privacy: {
    export: () => ipcRenderer.invoke(IPC_CHANNELS.privacyExport),
    deleteAll: (confirmation) => ipcRenderer.invoke(IPC_CHANNELS.privacyDelete, confirmation),
  },
  storage: {
    createBackup: () => invokeValidated(IPC_CHANNELS.storageCreateBackup, BackupResultSchema),
    getBackupHealth: () => invokeValidated(IPC_CHANNELS.storageBackupHealth, BackupHealthSchema),
    checkIntegrity: (input) =>
      invokeValidated(IPC_CHANNELS.storageCheckIntegrity, IntegrityCheckResultSchema, input),
  },
  recovery: {
    listSnapshots: (input) =>
      invokeValidated(
        RECOVERY_IPC_CHANNELS.snapshotsList,
        RecoverySnapshotSummarySchema.array(),
        input,
      ),
    createSnapshot: (input) =>
      invokeValidated(RECOVERY_IPC_CHANNELS.snapshotsCreate, RecoverySnapshotSummarySchema, input),
    prepareSnapshotRestore: (input) =>
      invokeValidated(
        RECOVERY_IPC_CHANNELS.snapshotsPrepareRestore,
        RecoverySnapshotRestorePlanSchema,
        input,
      ),
    confirmSnapshotRestore: (input) =>
      invokeValidated(
        RECOVERY_IPC_CHANNELS.snapshotsConfirmRestore,
        RecoveryRestoredCanvasSchema.nullable(),
        input,
      ),
    chooseImport: (input) =>
      invokeValidated(
        RECOVERY_IPC_CHANNELS.importChoose,
        RecoveryImportPlanSchema.nullable(),
        input,
      ),
    confirmImport: (input) =>
      invokeValidated(
        RECOVERY_IPC_CHANNELS.importConfirm,
        RecoveryImportCountsSchema.nullable(),
        input,
      ),
  },
};

contextBridge.exposeInMainWorld('forgeboard', Object.freeze(api));
