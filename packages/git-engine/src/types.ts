export type GitFileState = '.' | 'A' | 'C' | 'D' | 'M' | 'R' | 'T' | 'U' | '?' | '!';

export type GitStatusEntryKind =
  | 'ordinary'
  | 'renamed-or-copied'
  | 'unmerged'
  | 'untracked'
  | 'ignored';

export interface GitStatusEntry {
  readonly kind: GitStatusEntryKind;
  readonly path: string;
  readonly originalPath?: string;
  readonly index: GitFileState;
  readonly worktree: GitFileState;
  readonly submodule?: string;
  readonly score?: string;
}

export interface GitStatus {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly headOid: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly entries: readonly GitStatusEntry[];
  readonly dirty: boolean;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly conflicted: boolean;
}

export interface GitRemote {
  readonly name: string;
  readonly fetchUrl: string | null;
  readonly pushUrl: string | null;
  readonly hasRedactedCredentials: boolean;
}

export interface GitSubmodule {
  readonly path: string;
  readonly commit: string;
  readonly state: 'current' | 'uninitialized' | 'different' | 'conflicted';
  readonly description: string | null;
}

export type PackageManagerName = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';

export interface ArgumentArrayCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export type DetectedScriptCategory =
  | 'dev'
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'build'
  | 'start'
  | 'custom';

export interface DetectedScript {
  readonly name: string;
  readonly category: DetectedScriptCategory;
  /** The package-manager invocation Forgeboard may present to the user. */
  readonly command: ArgumentArrayCommand;
  /** Display-only package.json script. It is never passed to a shell by this package. */
  readonly declaration: string;
}

export interface SensitivePathWarning {
  readonly path: string;
  readonly reason: string;
  readonly tracked: boolean;
}

export interface RepositoryHealth {
  readonly repositoryRoot: string;
  readonly gitVersion: string;
  readonly status: GitStatus;
  readonly remotes: readonly GitRemote[];
  readonly submodules: readonly GitSubmodule[];
  readonly packageManager: PackageManagerName;
  readonly scripts: readonly DetectedScript[];
  readonly frameworks: readonly string[];
  readonly sensitivePaths: readonly SensitivePathWarning[];
}

export interface AheadBehind {
  readonly ahead: number;
  readonly behind: number;
}

export type DiffFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'binary'
  | 'unknown';

export type DiffLineKind = 'context' | 'addition' | 'deletion' | 'metadata';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly content: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

export interface DiffHunk {
  readonly id: string;
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
  readonly patch: string;
}

export interface DiffFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status: DiffFileStatus;
  readonly binary: boolean;
  readonly header: string;
  readonly hunks: readonly DiffHunk[];
}

export interface ParsedDiff {
  readonly raw: string;
  readonly files: readonly DiffFile[];
  readonly additions: number;
  readonly deletions: number;
}

export interface RefComparison {
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly aheadBehind: AheadBehind;
  readonly mergeBase: string;
  readonly commits: readonly string[];
  readonly diff: ParsedDiff;
}

export interface WorktreeDescriptor {
  readonly repositoryRoot: string;
  readonly commonDirectory: string;
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly headOid: string;
  readonly status: GitStatus;
}

export interface BaseComparison {
  readonly worktree: WorktreeDescriptor;
  readonly comparison: RefComparison;
}

export interface WorktreeComparison {
  readonly commonDirectory: string;
  readonly left: WorktreeDescriptor;
  readonly right: WorktreeDescriptor;
  /** Treats the left worktree as the base and the right worktree as the head. */
  readonly comparison: RefComparison;
}

export type WorktreeLifecycleStatus = 'active' | 'archived' | 'cleanup-pending';
export type WorktreeCleanupPolicy = 'manual' | 'after-merge' | 'on-success';

export interface WorktreeOwnership {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly repositoryRoot: string;
  readonly managedRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly agentId: string;
  readonly taskId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: WorktreeLifecycleStatus;
  readonly cleanupPolicy: WorktreeCleanupPolicy;
}

export interface ProvisionWorktreeInput {
  readonly repositoryPath: string;
  readonly managedRoot: string;
  readonly agentId: string;
  readonly taskId?: string;
  readonly baseRef?: string;
  readonly branchPrefix?: string;
  readonly cleanupPolicy?: WorktreeCleanupPolicy;
}

export interface ProvisionedWorktree {
  readonly ownership: WorktreeOwnership;
  readonly primaryWasDirty: boolean;
}

export interface ManagedWorktreeState {
  readonly ownership: WorktreeOwnership;
  readonly status: GitStatus | null;
  readonly branchExists: boolean;
  readonly branchOid: string | null;
  readonly mergedIntoBase: boolean;
  readonly missing: boolean;
}

export interface CleanupImpact extends ManagedWorktreeState {
  readonly expectedHead: string;
  readonly dirtyPaths: readonly string[];
}

export interface ManagedWorktreeSummary extends ManagedWorktreeState {
  readonly dirtyPaths: readonly string[];
  readonly comparison: RefComparison | null;
}

export interface BranchRenameImpact extends CleanupImpact {
  readonly oldBranch: string;
  readonly newBranch: string;
}

export interface ArchiveImpact extends CleanupImpact {
  readonly archiveStatus: 'archived';
}

export type MergeStrategy = 'fast-forward-only' | 'merge-commit' | 'squash';

interface ApprovalBase<Action extends string> {
  readonly action: Action;
  readonly approved: true;
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly repositoryRoot: string;
  readonly expectedHead: string;
}

export interface CommitApproval extends ApprovalBase<'commit'> {
  readonly message: string;
  readonly stagedPaths: readonly string[];
  readonly stagedPatchSha256: string;
}

export interface MergeApproval extends ApprovalBase<'merge'> {
  readonly sourceRef: string;
  readonly expectedSourceOid: string;
  readonly targetBranch: string;
  readonly strategy: MergeStrategy;
}

export interface CherryPickApproval extends ApprovalBase<'cherry-pick'> {
  readonly commits: readonly string[];
}

export interface RebaseApproval extends ApprovalBase<'rebase'> {
  readonly ontoRef: string;
  readonly expectedOntoOid: string;
  readonly branch: string;
}

export interface PushApproval extends ApprovalBase<'push'> {
  readonly remote: string;
  readonly sourceRef: string;
  readonly expectedSourceOid: string;
  readonly destinationRef: string;
  readonly forceWithLease: boolean;
  readonly expectedRemoteOid: string | null;
}

export interface CleanupApproval extends ApprovalBase<'cleanup-worktree'> {
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly expectedBranchOid: string | null;
  readonly dirtyPaths: readonly string[];
  readonly deleteBranch: boolean;
  readonly allowDirty: boolean;
  readonly allowUnmergedBranch: boolean;
}

export interface DiscardHunksApproval extends ApprovalBase<'discard-hunks'> {
  readonly patchSha256: string;
  readonly hunkIds: readonly string[];
}

export interface RenameManagedBranchApproval extends ApprovalBase<'rename-managed-branch'> {
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly oldBranch: string;
  readonly newBranch: string;
  readonly expectedBranchOid: string;
  readonly dirtyPaths: readonly string[];
}

export interface ArchiveWorktreeApproval extends ApprovalBase<'archive-worktree'> {
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly expectedBranchOid: string | null;
  readonly dirtyPaths: readonly string[];
}

export type InProgressGitOperation = 'merge' | 'rebase' | 'cherry-pick';

export interface GitContinuationState {
  readonly repositoryRoot: string;
  readonly expectedHead: string;
  readonly operation: InProgressGitOperation | null;
  readonly status: GitStatus;
  readonly conflictedPaths: readonly string[];
  readonly stagedPaths: readonly string[];
  readonly stagedPatchSha256: string;
  readonly unstagedPatchSha256: string;
  readonly canContinue: boolean;
  readonly canAbort: boolean;
}

interface ContinuationApprovalBase<Action extends string> extends ApprovalBase<Action> {
  readonly operation: InProgressGitOperation;
  readonly conflictedPaths: readonly string[];
  readonly stagedPaths: readonly string[];
  readonly stagedPatchSha256: string;
  readonly unstagedPatchSha256: string;
}

export type ContinueGitOperationApproval = ContinuationApprovalBase<'continue-git-operation'>;

export type AbortGitOperationApproval = ContinuationApprovalBase<'abort-git-operation'>;

export interface GitHubChangedFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status: DiffFileStatus;
}

export interface GitHubChangeDisclosure {
  readonly remote: string;
  readonly remoteUrl: string;
  readonly hostname: string;
  readonly ownerRepository: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly range: string;
  readonly commits: readonly string[];
  readonly files: readonly GitHubChangedFile[];
  readonly additions: number;
  readonly deletions: number;
  readonly diffSha256: string;
}

export interface GitHubPullRequestPlan {
  readonly kind: 'create-pull-request';
  readonly repositoryRoot: string;
  readonly expectedHead: string;
  readonly disclosure: GitHubChangeDisclosure;
  readonly title: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly draft: boolean;
  readonly command: ArgumentArrayCommand;
  readonly planSha256: string;
}

export interface GitHubCiStatusPlan {
  readonly kind: 'read-ci-status';
  readonly repositoryRoot: string;
  readonly disclosure: GitHubChangeDisclosure;
  readonly command: ArgumentArrayCommand;
  readonly planSha256: string;
}

export interface CreateGitHubPullRequestApproval
  extends ApprovalBase<'create-github-pull-request'> {
  readonly planSha256: string;
  readonly remote: string;
  readonly remoteUrl: string;
  readonly ownerRepository: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly range: string;
  readonly commits: readonly string[];
  readonly files: readonly GitHubChangedFile[];
  readonly title: string;
  readonly bodySha256: string;
  readonly draft: boolean;
}

export type GitApproval =
  | CommitApproval
  | MergeApproval
  | CherryPickApproval
  | RebaseApproval
  | PushApproval
  | CleanupApproval
  | DiscardHunksApproval
  | RenameManagedBranchApproval
  | ArchiveWorktreeApproval
  | ContinueGitOperationApproval
  | AbortGitOperationApproval
  | CreateGitHubPullRequestApproval;

export interface GitOperationResult {
  readonly state: 'completed' | 'conflicted';
  readonly headBefore: string;
  readonly headAfter: string;
  readonly status: GitStatus;
}

export interface CleanupResult {
  readonly worktreeRemoved: boolean;
  readonly branchDeleted: boolean;
  readonly metadataRemoved: boolean;
}

export interface HunkOperationResult {
  readonly status: GitStatus;
  readonly staged: ParsedDiff;
  readonly unstaged: ParsedDiff;
}

export interface PushResult {
  readonly remote: string;
  readonly sourceOid: string;
  readonly destinationRef: string;
  readonly forceWithLease: boolean;
}

export interface GitApprovalSnapshot {
  readonly repositoryRoot: string;
  readonly expectedHead: string;
  readonly branch: string | null;
  readonly stagedPaths: readonly string[];
  readonly stagedPatchSha256: string;
  readonly status: GitStatus;
}

export interface GitHubCliAvailability {
  readonly installed: boolean;
  readonly executable: string;
  readonly version: string | null;
}

export interface GitHubAuthStatus extends GitHubCliAvailability {
  readonly hostname: string;
  readonly authenticated: boolean;
}

export interface GitHubRepositoryStatus {
  readonly hostname: string;
  readonly ownerRepository: string;
  readonly url: string;
  readonly defaultBranch: string;
}

export interface GitHubPullRequestResult {
  readonly url: string;
  readonly ownerRepository: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly planSha256: string;
}

export interface GitHubCiRun {
  readonly databaseId: number;
  readonly name: string;
  readonly workflowName: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
  readonly headBranch: string;
  readonly headSha: string;
}
