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

export type GitApproval =
  | CommitApproval
  | MergeApproval
  | CherryPickApproval
  | RebaseApproval
  | PushApproval
  | CleanupApproval
  | DiscardHunksApproval;

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
