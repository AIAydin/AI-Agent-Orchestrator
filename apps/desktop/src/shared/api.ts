import type {
  AgentDetection,
  AppInfo,
  AppSettings,
  AuditEvent,
  AuditListInput,
  BackupHealth,
  BackupResult,
  CanvasDocument,
  ConfirmProjectRecoveryInput,
  ExtensionApproveInput,
  ExtensionDiscoveryView,
  ExtensionInstallPlanView,
  ExtensionRemoveInput,
  ExtensionSelectionKind,
  IpcResult,
  LocalReferenceSelectionInput,
  LocateProjectRecoveryInput,
  PrepareRunInput,
  PreviewEventEnvelope,
  PreviewNavigateInput,
  PreviewNodeKey,
  PreviewSessionSnapshot,
  PreviewStartInput,
  Project,
  ProjectRecoveryAssessment,
  RunDisclosure,
  RunEventEnvelope,
} from './contracts.js';
import type {
  CheckCancelInput,
  CheckEventEnvelope,
  CheckExecutionView,
  CheckListInput,
  CheckPlanConfirmationInput,
  CheckPlanView,
  CheckPrepareInput,
} from './check-contracts.js';
import type {
  DockerPullResult,
  DockerReadiness,
  DockerReadinessInput,
} from './docker-contracts.js';
import type {
  GitCommitPlanInput,
  GitCommitPlanView,
  GitCommitResultView,
  GitDiscardPlanView,
  GitHunkSelectionInput,
  GitPathSelectionInput,
  GitPlanConfirmationInput,
  GitReviewView,
  GitTargetInput,
} from './git-contracts.js';
import type {
  RecoveryImportChooseInput,
  RecoveryImportCounts,
  RecoveryImportPlan,
  RecoveryPlanConfirmationInput,
  RecoveryRestoredCanvas,
  RecoverySnapshotCreateInput,
  RecoverySnapshotListInput,
  RecoverySnapshotPrepareRestoreInput,
  RecoverySnapshotRestorePlan,
  RecoverySnapshotSummary,
} from './recovery-contracts.js';
import type {
  WorkflowApproveHumanDecisionInput,
  WorkflowApproveNodeInput,
  WorkflowCancelInput,
  WorkflowEventEnvelope,
  WorkflowExecutionView,
  WorkflowGetInput,
  WorkflowInteractionEventEnvelope,
  WorkflowListInput,
  WorkflowNodeInput,
  WorkflowNodeInterrupt,
  WorkflowResolveRevisionEscapeInput,
  WorkflowReviewDecisionInput,
  WorkflowStartInput,
} from './workflow-contracts.js';

export interface ForgeboardApi {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>;
    onCloseRequested(listener: () => boolean | Promise<boolean>): () => void;
  };
  settings: {
    get(): Promise<IpcResult<AppSettings>>;
    update(settings: AppSettings): Promise<IpcResult<AppSettings>>;
    reset(): Promise<IpcResult<AppSettings>>;
    export(): Promise<IpcResult<string | null>>;
    import(): Promise<IpcResult<AppSettings | null>>;
  };
  agents: { detect(): Promise<IpcResult<AgentDetection[]>> };
  docker: {
    check(input: DockerReadinessInput): Promise<IpcResult<DockerReadiness>>;
    pull(input: DockerReadinessInput): Promise<IpcResult<DockerPullResult>>;
  };
  projects: {
    recent(): Promise<IpcResult<Project[]>>;
    pick(): Promise<IpcResult<Project | null>>;
    pickParent(): Promise<IpcResult<string | null>>;
    pickExecutable(): Promise<IpcResult<string | null>>;
    pickReferences(input: LocalReferenceSelectionInput): Promise<IpcResult<string[]>>;
    locateMoved(
      input: LocateProjectRecoveryInput,
    ): Promise<IpcResult<ProjectRecoveryAssessment | null>>;
    confirmMoved(input: ConfirmProjectRecoveryInput): Promise<IpcResult<Project>>;
    open(path: string): Promise<IpcResult<Project>>;
    create(input: {
      parentPath: string;
      name: string;
      initializeGit: boolean;
    }): Promise<IpcResult<Project>>;
    clone(input: { remoteUrl: string; destinationPath: string }): Promise<IpcResult<Project>>;
    demo(): Promise<IpcResult<Project>>;
    initializeGit(projectId: string): Promise<IpcResult<Project | null>>;
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
  previews: {
    start(input: PreviewStartInput): Promise<IpcResult<PreviewSessionSnapshot>>;
    restart(input: PreviewStartInput): Promise<IpcResult<PreviewSessionSnapshot>>;
    stop(input: PreviewNodeKey): Promise<IpcResult<PreviewSessionSnapshot | null>>;
    get(input: PreviewNodeKey): Promise<IpcResult<PreviewSessionSnapshot | null>>;
    navigate(input: PreviewNavigateInput): Promise<IpcResult<string>>;
    onEvent(listener: (event: PreviewEventEnvelope) => void): () => void;
  };
  checks: {
    prepare(input: CheckPrepareInput): Promise<IpcResult<CheckPlanView>>;
    confirm(input: CheckPlanConfirmationInput): Promise<IpcResult<CheckExecutionView | null>>;
    list(input: CheckListInput): Promise<IpcResult<CheckExecutionView[]>>;
    cancel(input: CheckCancelInput): Promise<IpcResult<CheckExecutionView>>;
    onEvent(listener: (event: CheckEventEnvelope) => void): () => void;
  };
  workflows: {
    start(input: WorkflowStartInput): Promise<IpcResult<WorkflowExecutionView>>;
    get(input: WorkflowGetInput): Promise<IpcResult<WorkflowExecutionView>>;
    list(input: WorkflowListInput): Promise<IpcResult<WorkflowExecutionView[]>>;
    approveNode(input: WorkflowApproveNodeInput): Promise<IpcResult<WorkflowExecutionView | null>>;
    approveHuman(
      input: WorkflowApproveHumanDecisionInput,
    ): Promise<IpcResult<WorkflowExecutionView | null>>;
    decideReview(
      input: WorkflowReviewDecisionInput,
    ): Promise<IpcResult<WorkflowExecutionView | null>>;
    resolveRevisionEscape(
      input: WorkflowResolveRevisionEscapeInput,
    ): Promise<IpcResult<WorkflowExecutionView | null>>;
    cancel(input: WorkflowCancelInput): Promise<IpcResult<WorkflowExecutionView | null>>;
    sendInput(input: WorkflowNodeInput): Promise<IpcResult<boolean>>;
    interrupt(input: WorkflowNodeInterrupt): Promise<IpcResult<boolean>>;
    onEvent(listener: (event: WorkflowEventEnvelope) => void): () => void;
    onInteractionEvent(listener: (event: WorkflowInteractionEventEnvelope) => void): () => void;
  };
  audit: {
    list(input: AuditListInput): Promise<IpcResult<AuditEvent[]>>;
  };
  extensions: {
    list(): Promise<IpcResult<ExtensionDiscoveryView>>;
    choose(kind: ExtensionSelectionKind): Promise<IpcResult<ExtensionInstallPlanView | null>>;
    approve(input: ExtensionApproveInput): Promise<IpcResult<ExtensionDiscoveryView>>;
    remove(input: ExtensionRemoveInput): Promise<IpcResult<ExtensionDiscoveryView>>;
  };
  git: {
    review(input: GitTargetInput): Promise<IpcResult<GitReviewView>>;
    stagePaths(input: GitPathSelectionInput): Promise<IpcResult<GitReviewView>>;
    stageHunks(input: GitHunkSelectionInput): Promise<IpcResult<GitReviewView>>;
    unstagePaths(input: GitPathSelectionInput): Promise<IpcResult<GitReviewView>>;
    unstageHunks(input: GitHunkSelectionInput): Promise<IpcResult<GitReviewView>>;
    prepareDiscard(input: GitHunkSelectionInput): Promise<IpcResult<GitDiscardPlanView>>;
    confirmDiscard(input: GitPlanConfirmationInput): Promise<IpcResult<GitReviewView | null>>;
    prepareCommit(input: GitCommitPlanInput): Promise<IpcResult<GitCommitPlanView>>;
    confirmCommit(input: GitPlanConfirmationInput): Promise<IpcResult<GitCommitResultView | null>>;
  };
  privacy: {
    export(): Promise<IpcResult<string | null>>;
    deleteAll(confirmation: string): Promise<IpcResult<boolean>>;
  };
  storage: {
    createBackup(): Promise<IpcResult<BackupResult>>;
    getBackupHealth(): Promise<IpcResult<BackupHealth>>;
  };
  recovery: {
    listSnapshots(input: RecoverySnapshotListInput): Promise<IpcResult<RecoverySnapshotSummary[]>>;
    createSnapshot(input: RecoverySnapshotCreateInput): Promise<IpcResult<RecoverySnapshotSummary>>;
    prepareSnapshotRestore(
      input: RecoverySnapshotPrepareRestoreInput,
    ): Promise<IpcResult<RecoverySnapshotRestorePlan>>;
    confirmSnapshotRestore(
      input: RecoveryPlanConfirmationInput,
    ): Promise<IpcResult<RecoveryRestoredCanvas | null>>;
    chooseImport(input: RecoveryImportChooseInput): Promise<IpcResult<RecoveryImportPlan | null>>;
    confirmImport(
      input: RecoveryPlanConfirmationInput,
    ): Promise<IpcResult<RecoveryImportCounts | null>>;
  };
}
