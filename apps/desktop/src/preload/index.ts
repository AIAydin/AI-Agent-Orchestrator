import { contextBridge, ipcRenderer } from 'electron';
import type { z } from 'zod';

import type { ForgeboardApi } from '../shared/api.js';
import {
  CheckEventEnvelopeSchema,
  CheckExecutionViewSchema,
  CheckPlanViewSchema,
} from '../shared/check-contracts.js';
import type { IpcResult } from '../shared/contracts.js';
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
} from '../shared/contracts.js';
import { DockerPullResultSchema, DockerReadinessSchema } from '../shared/docker-contracts.js';
import {
  GitCommitPlanViewSchema,
  GitCommitResultViewSchema,
  GitDiscardPlanViewSchema,
  GitReviewViewSchema,
} from '../shared/git-contracts.js';
import {
  RECOVERY_IPC_CHANNELS,
  RecoveryImportCountsSchema,
  RecoveryImportPlanSchema,
  RecoveryRestoredCanvasSchema,
  RecoverySnapshotRestorePlanSchema,
  RecoverySnapshotSummarySchema,
} from '../shared/recovery-contracts.js';

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
  },
  agents: {
    detect: () => ipcRenderer.invoke(IPC_CHANNELS.agentsDetect),
  },
  docker: {
    check: (input) => invokeValidated(IPC_CHANNELS.dockerCheck, DockerReadinessSchema, input),
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
  },
  canvas: {
    load: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.canvasLoad, projectId),
    save: (document) => ipcRenderer.invoke(IPC_CHANNELS.canvasSave, document),
  },
  runs: {
    prepare: (input) => ipcRenderer.invoke(IPC_CHANNELS.runsPrepare, input),
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
  previews: {
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
  },
  privacy: {
    export: () => ipcRenderer.invoke(IPC_CHANNELS.privacyExport),
    deleteAll: (confirmation) => ipcRenderer.invoke(IPC_CHANNELS.privacyDelete, confirmation),
  },
  storage: {
    createBackup: () => invokeValidated(IPC_CHANNELS.storageCreateBackup, BackupResultSchema),
    getBackupHealth: () => invokeValidated(IPC_CHANNELS.storageBackupHealth, BackupHealthSchema),
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
