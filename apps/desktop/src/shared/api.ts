import type {
  AgentDetection,
  AppInfo,
  AppSettings,
  AuditEvent,
  AuditListInput,
  CanvasDocument,
  IpcResult,
  PrepareRunInput,
  Project,
  RunDisclosure,
  RunEventEnvelope,
} from './contracts.js';

export interface ForgeboardApi {
  app: { getInfo(): Promise<IpcResult<AppInfo>> };
  settings: {
    get(): Promise<IpcResult<AppSettings>>;
    update(settings: AppSettings): Promise<IpcResult<AppSettings>>;
    reset(): Promise<IpcResult<AppSettings>>;
    export(): Promise<IpcResult<string | null>>;
    import(): Promise<IpcResult<AppSettings | null>>;
  };
  agents: { detect(): Promise<IpcResult<AgentDetection[]>> };
  projects: {
    recent(): Promise<IpcResult<Project[]>>;
    pick(): Promise<IpcResult<Project | null>>;
    pickParent(): Promise<IpcResult<string | null>>;
    pickExecutable(): Promise<IpcResult<string | null>>;
    open(path: string): Promise<IpcResult<Project>>;
    create(input: {
      parentPath: string;
      name: string;
      initializeGit: boolean;
    }): Promise<IpcResult<Project>>;
    clone(input: { remoteUrl: string; destinationPath: string }): Promise<IpcResult<Project>>;
    demo(): Promise<IpcResult<Project>>;
  };
  canvas: {
    load(projectId: string): Promise<IpcResult<CanvasDocument>>;
    save(document: CanvasDocument): Promise<IpcResult<CanvasDocument>>;
  };
  runs: {
    prepare(input: PrepareRunInput): Promise<IpcResult<RunDisclosure>>;
    approve(runId: string): Promise<IpcResult<boolean>>;
    sendInput(runId: string, data: string): Promise<IpcResult<boolean>>;
    interrupt(runId: string): Promise<IpcResult<boolean>>;
    terminate(runId: string): Promise<IpcResult<boolean>>;
    onEvent(listener: (event: RunEventEnvelope) => void): () => void;
  };
  audit: {
    list(input: AuditListInput): Promise<IpcResult<AuditEvent[]>>;
  };
  privacy: {
    export(): Promise<IpcResult<string | null>>;
    deleteAll(confirmation: string): Promise<IpcResult<boolean>>;
  };
}
