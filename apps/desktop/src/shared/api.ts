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
  PrepareRunContinuationInput,
  PreviewEventEnvelope,
  PreviewNavigateInput,
  PreviewNodeKey,
  PreviewSessionSnapshot,
  PreviewStartInput,
  Project,
  ProjectRecoveryAssessment,
  RunApprovalView,
  RunEventEnvelope,
} from './application/contracts.js';
import type { AgentReadinessRequest, AgentReadinessResult } from './readiness/contracts.js';
import type {
  ProviderConnectionCancelResult,
  ProviderConnectionGetInput,
  ProviderConnectionPlan,
  ProviderConnectionPlanInput,
  ProviderConnectionPrepareInput,
  ProviderConnectionStatus,
} from './provider-connections/index.js';
import type {
  CommandReadinessRequest,
  CommandReadinessResult,
} from './command-readiness/contracts.js';
import type { PreviewSurfaceApi } from './preview/surface/index.js';
import type { PreviewTargetListInput, PreviewTargetView } from './preview/targets.js';
import type {
  ApprovalListInput,
  ApprovalRevocationInput,
  ApprovalView,
} from './approvals/contracts.js';
import type {
  CheckCancelInput,
  CheckEventEnvelope,
  CheckExecutionView,
  CheckListInput,
  CheckPlanConfirmationInput,
  CheckPlanView,
  CheckPrepareInput,
} from './checks/contracts.js';
import type {
  CollaborationConnection,
  CollaborationCreateCommentInput,
  CollaborationCreateCommentResult,
  CollaborationEvent,
  CollaborationJoinInput,
  CollaborationJoinResult,
  CollaborationMetadataSnapshot,
  CollaborationPublishInput,
  CollaborationPublishReceipt,
  CollaborationSyncCheckpointInput,
  CollaborationDiscardRejectedCommentInput,
  CollaborationSyncRecoverInput,
  CollaborationSyncRecovery,
  CollaborationUpdateAwarenessInput,
} from './collaboration/index.js';
import type {
  DockerPullResult,
  DockerReadiness,
  DockerReadinessInput,
} from './docker/contracts.js';
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
} from './git/contracts.js';
import type {
  GitShippingPlanInput,
  GitShippingPlanView,
  GitShippingResultView,
} from './git/shipping-contracts.js';
import type {
  GitDeliveryReadinessApproveInput,
  GitDeliveryReadinessApproveView,
  GitDeliveryReadinessGetInput,
  GitDeliveryReadinessGetView,
  GitDeliveryReadinessPrepareInput,
  GitDeliveryReadinessPrepareView,
  GitDeliveryReadinessRunInput,
  GitDeliveryReadinessRunView,
} from './git/readiness/index.js';
import type {
  GitConnectionConfirmInput,
  GitConnectionMutationPlanView,
  GitConnectionPlanCancelResult,
  GitConnectionPlanConfirmationInput,
  GitConnectionPrepareLocalInput,
  GitConnectionPrepareNetworkInput,
  GitConnectionPrepareRemoveInput,
  GitConnectionProjectInput,
  GitConnectionsView,
  GitHubCliSelectionPlanView,
  GitHubCliStatusView,
} from './git/connections/index.js';
import type {
  GitRemotePlanCancelInput,
  GitRemotePlanCancelResult,
  GitHubCiPlanView,
  GitHubCiPrepareInput,
  GitHubCiResultView,
  GitHubPullRequestPlanView,
  GitHubPullRequestPrepareInput,
  GitHubPullRequestResultView,
  GitHubStatusPlanView,
  GitHubStatusPrepareInput,
  GitHubStatusResultView,
  GitRemoteInspectInput,
  GitRemoteInspectView,
  GitRemotePlanConfirmationInput,
  GitRemotePushPlanView,
  GitRemotePushPrepareInput,
  GitRemotePushResultView,
} from './git/remote/index.js';
import type {
  GitWorktreeCleanupConfirmationInput,
  GitWorktreeCleanupPrepareOutcome,
  GitWorktreeCleanupResultView,
  GitWorktreeCleanupTargetInput,
} from './git/lifecycle/contracts.js';
import type {
  GitReviewNoteCreateInput,
  GitReviewNoteDeleteInput,
  GitReviewNotesListInput,
  GitReviewNotesView,
  GitReviewNoteUpdateInput,
} from './git/reviews/contracts.js';
import type {
  FileDocument,
  FileOpenExternalInput,
  FileReadInput,
  FileRevealInput,
  FileRevertInput,
  FileSaveInput,
  FileSearchInput,
  FileSearchResult,
  FileTreeInput,
  FileTreeResult,
} from './files/contracts.js';
import type { IntegrityCheckInput, IntegrityCheckResult } from './integrity/contracts.js';
import type { RunHistoryListInput, RunHistorySummary } from './runs/contracts.js';
import type {
  TerminalChooseExecutableInput,
  TerminalEvent,
  TerminalExecutableSelectionView,
  TerminalInput,
  TerminalLaunchPlanCancelResult,
  TerminalLaunchPlanConfirmationInput,
  TerminalLaunchPlanView,
  TerminalPrepareLaunchInput,
  TerminalReplayInput,
  TerminalReplayView,
  TerminalResizeInput,
  TerminalSessionListInput,
  TerminalSessionTargetInput,
  TerminalSessionView,
} from './terminal/index.js';
import type { FolderReadinessRequest, FolderReadinessResult } from './settings/folder-readiness.js';
import type { SettingsRepairEvidence, SettingsRepairSummary } from './settings/repair/contracts.js';
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
} from './recovery/contracts.js';
import type {
  WorkflowApproveHumanDecisionInput,
  WorkflowApproveNodeInput,
  WorkflowArtifactActionInput,
  WorkflowCancelInput,
  WorkflowCancelNodeInput,
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
} from './workflow/contracts.js';

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
    listRepairs(): Promise<IpcResult<SettingsRepairSummary[]>>;
    getRepair(repairId: string): Promise<IpcResult<SettingsRepairEvidence>>;
    exportRepair(repairId: string): Promise<IpcResult<string | null>>;
    checkFolderReadiness(input: FolderReadinessRequest): Promise<IpcResult<FolderReadinessResult>>;
  };
  agents: {
    detect(): Promise<IpcResult<AgentDetection[]>>;
    checkReadiness(input: AgentReadinessRequest): Promise<IpcResult<AgentReadinessResult | null>>;
    connections: {
      get(input: ProviderConnectionGetInput): Promise<IpcResult<ProviderConnectionStatus>>;
      prepare(input: ProviderConnectionPrepareInput): Promise<IpcResult<ProviderConnectionPlan>>;
      confirm(
        input: ProviderConnectionPlanInput,
      ): Promise<IpcResult<ProviderConnectionStatus | null>>;
      cancel(
        input: ProviderConnectionPlanInput,
      ): Promise<IpcResult<ProviderConnectionCancelResult>>;
    };
  };
  commands: {
    checkReadiness(input: CommandReadinessRequest): Promise<IpcResult<CommandReadinessResult>>;
  };
  approvals: {
    list(input: ApprovalListInput): Promise<IpcResult<ApprovalView[]>>;
    revoke(input: ApprovalRevocationInput): Promise<IpcResult<ApprovalView>>;
  };
  docker: {
    check(input: DockerReadinessInput): Promise<IpcResult<DockerReadiness | null>>;
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
    clone(input: {
      remoteUrl: string;
      destinationPath: string;
    }): Promise<IpcResult<Project | null>>;
    demo(): Promise<IpcResult<Project>>;
    initializeGit(projectId: string): Promise<IpcResult<Project | null>>;
  };
  canvas: {
    load(projectId: string): Promise<IpcResult<CanvasDocument>>;
    save(document: CanvasDocument): Promise<IpcResult<CanvasDocument>>;
  };
  files: {
    tree(input: FileTreeInput): Promise<FileTreeResult>;
    search(input: FileSearchInput): Promise<FileSearchResult>;
    read(input: FileReadInput): Promise<FileDocument>;
    save(input: FileSaveInput): Promise<FileDocument>;
    revert(input: FileRevertInput): Promise<FileDocument>;
    reveal(input: FileRevealInput): Promise<void>;
    openExternal(input: FileOpenExternalInput): Promise<void>;
  };
  collaboration: {
    get(): Promise<IpcResult<CollaborationConnection | null>>;
    snapshot(): Promise<IpcResult<CollaborationMetadataSnapshot | null>>;
    join(input: CollaborationJoinInput): Promise<CollaborationJoinResult>;
    leave(): Promise<IpcResult<CollaborationConnection | null>>;
    publish(
      input: CollaborationPublishInput,
    ): Promise<IpcResult<CollaborationPublishReceipt | null>>;
    recover(
      input: CollaborationSyncRecoverInput,
    ): Promise<IpcResult<CollaborationSyncRecovery | null>>;
    checkpoint(input: CollaborationSyncCheckpointInput): Promise<IpcResult<boolean>>;
    discardRejectedComment(
      input: CollaborationDiscardRejectedCommentInput,
    ): Promise<IpcResult<CollaborationSyncRecovery | null>>;
    createComment(
      input: CollaborationCreateCommentInput,
    ): Promise<IpcResult<CollaborationCreateCommentResult | null>>;
    updateAwareness(input: CollaborationUpdateAwarenessInput): Promise<IpcResult<boolean>>;
    onEvent(listener: (event: CollaborationEvent) => void): () => void;
  };
  runs: {
    list(input: RunHistoryListInput): Promise<IpcResult<RunHistorySummary[]>>;
    prepare(input: PrepareRunInput): Promise<IpcResult<RunApprovalView | null>>;
    resume(input: PrepareRunContinuationInput): Promise<IpcResult<RunApprovalView | null>>;
    retry(input: PrepareRunContinuationInput): Promise<IpcResult<RunApprovalView | null>>;
    approve(runId: string): Promise<IpcResult<boolean>>;
    sendInput(runId: string, data: string): Promise<IpcResult<boolean>>;
    interrupt(runId: string): Promise<IpcResult<boolean>>;
    terminate(runId: string): Promise<IpcResult<boolean>>;
    onEvent(listener: (event: RunEventEnvelope) => void): () => void;
  };
  terminal: {
    chooseExecutable(
      input: TerminalChooseExecutableInput,
    ): Promise<IpcResult<TerminalExecutableSelectionView | null>>;
    prepareLaunch(input: TerminalPrepareLaunchInput): Promise<IpcResult<TerminalLaunchPlanView>>;
    cancelLaunch(
      input: TerminalLaunchPlanConfirmationInput,
    ): Promise<IpcResult<TerminalLaunchPlanCancelResult>>;
    confirmLaunch(
      input: TerminalLaunchPlanConfirmationInput,
    ): Promise<IpcResult<TerminalSessionView | null>>;
    getSession(input: TerminalSessionTargetInput): Promise<IpcResult<TerminalSessionView | null>>;
    listSessions(input: TerminalSessionListInput): Promise<IpcResult<TerminalSessionView[]>>;
    replay(input: TerminalReplayInput): Promise<IpcResult<TerminalReplayView | null>>;
    sendInput(input: TerminalInput): Promise<IpcResult<TerminalSessionView>>;
    resize(input: TerminalResizeInput): Promise<IpcResult<TerminalSessionView>>;
    interrupt(input: TerminalSessionTargetInput): Promise<IpcResult<TerminalSessionView>>;
    terminate(input: TerminalSessionTargetInput): Promise<IpcResult<TerminalSessionView>>;
    onEvent(listener: (event: TerminalEvent) => void): () => void;
  };
  previews: {
    listTargets(input: PreviewTargetListInput): Promise<IpcResult<PreviewTargetView[]>>;
    start(input: PreviewStartInput): Promise<IpcResult<PreviewSessionSnapshot | null>>;
    restart(input: PreviewStartInput): Promise<IpcResult<PreviewSessionSnapshot | null>>;
    stop(input: PreviewNodeKey): Promise<IpcResult<PreviewSessionSnapshot | null>>;
    get(input: PreviewNodeKey): Promise<IpcResult<PreviewSessionSnapshot | null>>;
    navigate(input: PreviewNavigateInput): Promise<IpcResult<string>>;
    onEvent(listener: (event: PreviewEventEnvelope) => void): () => void;
  };
  previewSurfaces: PreviewSurfaceApi;
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
    cancelNode(input: WorkflowCancelNodeInput): Promise<IpcResult<WorkflowExecutionView | null>>;
    revealArtifact(input: WorkflowArtifactActionInput): Promise<IpcResult<null>>;
    openArtifact(input: WorkflowArtifactActionInput): Promise<IpcResult<null>>;
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
    prepareShipping(input: GitShippingPlanInput): Promise<IpcResult<GitShippingPlanView>>;
    confirmShipping(
      input: GitPlanConfirmationInput,
    ): Promise<IpcResult<GitShippingResultView | null>>;
    readiness: {
      get(input: GitDeliveryReadinessGetInput): Promise<IpcResult<GitDeliveryReadinessGetView>>;
      prepare(
        input: GitDeliveryReadinessPrepareInput,
      ): Promise<IpcResult<GitDeliveryReadinessPrepareView>>;
      run(
        input: GitDeliveryReadinessRunInput,
      ): Promise<IpcResult<GitDeliveryReadinessRunView | null>>;
      approve(
        input: GitDeliveryReadinessApproveInput,
      ): Promise<IpcResult<GitDeliveryReadinessApproveView | null>>;
    };
    connections: {
      list(input: GitConnectionProjectInput): Promise<IpcResult<GitConnectionsView>>;
      prepareNetwork(
        input: GitConnectionPrepareNetworkInput,
      ): Promise<IpcResult<GitConnectionMutationPlanView>>;
      prepareLocal(
        input: GitConnectionPrepareLocalInput,
      ): Promise<IpcResult<GitConnectionMutationPlanView | null>>;
      prepareRemove(
        input: GitConnectionPrepareRemoveInput,
      ): Promise<IpcResult<GitConnectionMutationPlanView>>;
      confirm(input: GitConnectionConfirmInput): Promise<IpcResult<GitConnectionsView | null>>;
      cancelPlan(
        input: GitConnectionPlanConfirmationInput,
      ): Promise<IpcResult<GitConnectionPlanCancelResult>>;
      status(): Promise<IpcResult<GitHubCliStatusView>>;
      refresh(): Promise<IpcResult<GitHubCliStatusView>>;
      chooseGitHubCli(): Promise<IpcResult<GitHubCliSelectionPlanView | null>>;
      useAutomaticGitHubCli(): Promise<IpcResult<GitHubCliSelectionPlanView>>;
      confirmGitHubCli(
        input: GitConnectionPlanConfirmationInput,
      ): Promise<IpcResult<GitHubCliStatusView | null>>;
    };
    remote: {
      inspect(input: GitRemoteInspectInput): Promise<IpcResult<GitRemoteInspectView>>;
      cancelPlan(input: GitRemotePlanCancelInput): Promise<IpcResult<GitRemotePlanCancelResult>>;
      preparePush(input: GitRemotePushPrepareInput): Promise<IpcResult<GitRemotePushPlanView>>;
      confirmPush(
        input: GitRemotePlanConfirmationInput,
      ): Promise<IpcResult<GitRemotePushResultView | null>>;
      prepareGitHubStatus(
        input: GitHubStatusPrepareInput,
      ): Promise<IpcResult<GitHubStatusPlanView>>;
      confirmGitHubStatus(
        input: GitRemotePlanConfirmationInput,
      ): Promise<IpcResult<GitHubStatusResultView | null>>;
      preparePullRequest(
        input: GitHubPullRequestPrepareInput,
      ): Promise<IpcResult<GitHubPullRequestPlanView>>;
      confirmPullRequest(
        input: GitRemotePlanConfirmationInput,
      ): Promise<IpcResult<GitHubPullRequestResultView | null>>;
      prepareCi(input: GitHubCiPrepareInput): Promise<IpcResult<GitHubCiPlanView>>;
      confirmCi(
        input: GitRemotePlanConfirmationInput,
      ): Promise<IpcResult<GitHubCiResultView | null>>;
    };
    lifecycle: {
      prepareCleanup(
        input: GitWorktreeCleanupTargetInput,
      ): Promise<IpcResult<GitWorktreeCleanupPrepareOutcome>>;
      confirmCleanup(
        input: GitWorktreeCleanupConfirmationInput,
      ): Promise<IpcResult<GitWorktreeCleanupResultView | null>>;
    };
    reviewNotes: {
      list(input: GitReviewNotesListInput): Promise<IpcResult<GitReviewNotesView>>;
      create(input: GitReviewNoteCreateInput): Promise<IpcResult<GitReviewNotesView>>;
      update(input: GitReviewNoteUpdateInput): Promise<IpcResult<GitReviewNotesView>>;
      delete(input: GitReviewNoteDeleteInput): Promise<IpcResult<GitReviewNotesView>>;
    };
  };
  privacy: {
    export(): Promise<IpcResult<string | null>>;
    deleteAll(confirmation: string): Promise<IpcResult<boolean>>;
  };
  storage: {
    createBackup(): Promise<IpcResult<BackupResult>>;
    getBackupHealth(): Promise<IpcResult<BackupHealth>>;
    checkIntegrity(input: IntegrityCheckInput): Promise<IpcResult<IntegrityCheckResult>>;
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
