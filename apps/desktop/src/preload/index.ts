import { contextBridge, ipcRenderer } from 'electron';

import type { ForgeboardApi } from '../shared/api.js';
import { IPC_CHANNELS, RunEventEnvelopeSchema } from '../shared/contracts.js';

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
  projects: {
    recent: () => ipcRenderer.invoke(IPC_CHANNELS.projectsRecent),
    pick: () => ipcRenderer.invoke(IPC_CHANNELS.projectsPick),
    pickParent: () => ipcRenderer.invoke(IPC_CHANNELS.projectsPickParent),
    pickExecutable: () => ipcRenderer.invoke(IPC_CHANNELS.projectsPickExecutable),
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
  audit: {
    list: (input) => ipcRenderer.invoke(IPC_CHANNELS.auditList, input),
  },
  privacy: {
    export: () => ipcRenderer.invoke(IPC_CHANNELS.privacyExport),
    deleteAll: (confirmation) => ipcRenderer.invoke(IPC_CHANNELS.privacyDelete, confirmation),
  },
};

contextBridge.exposeInMainWorld('forgeboard', Object.freeze(api));
