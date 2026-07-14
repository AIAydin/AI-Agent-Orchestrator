import { contextBridge, ipcRenderer } from 'electron';
import type { z } from 'zod';

import type { ForgeboardApi } from '../shared/api.js';
import type { IpcResult } from '../shared/contracts.js';
import {
  IPC_CHANNELS,
  BackupResultSchema,
  ExtensionDiscoveryViewSchema,
  ExtensionInstallPlanViewSchema,
  LocalReferenceSelectionResultSchema,
  PreviewEventEnvelopeSchema,
  ProjectRecoveryAssessmentSchema,
  ProjectSchema,
  RunEventEnvelopeSchema,
  ipcResultSchema,
} from '../shared/contracts.js';
import { DockerPullResultSchema, DockerReadinessSchema } from '../shared/docker-contracts.js';

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
  privacy: {
    export: () => ipcRenderer.invoke(IPC_CHANNELS.privacyExport),
    deleteAll: (confirmation) => ipcRenderer.invoke(IPC_CHANNELS.privacyDelete, confirmation),
  },
  storage: {
    createBackup: () => invokeValidated(IPC_CHANNELS.storageCreateBackup, BackupResultSchema),
  },
};

contextBridge.exposeInMainWorld('forgeboard', Object.freeze(api));
