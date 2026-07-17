export { ChangeService, type PushExecutionOptions, type WorktreeDiffMode } from './diff/changes.js';
export { parseUnifiedDiff, patchSha256, selectDiffHunks } from './diff/parser.js';
export { GitEngineError, type GitEngineErrorCode } from './model/errors.js';
export {
  GitExecutor,
  type GitBinaryCommandResult,
  type GitCommandOptions,
  type GitCommandResult,
  type GitExecutorOptions,
} from './repository/executor.js';
export {
  assertExactPushDestination,
  assertNoMatchingPushUrlRewrites,
  assertNoPushTargetRemoteNameCollision,
  assertNoRepositoryPushOverrides,
  exactPushDestination,
  readExactRemotePushUrl,
} from './repository/push-security.js';
export {
  assertGitRemoteConfigurationName,
  classifyConfiguredRemoteTarget,
  resolveGitRemoteTarget,
  type ConfiguredRemoteTargetClassification,
} from './repository/remotes/identity.js';
export {
  inspectGitRemoteConfiguration,
  remoteEntryName,
  remoteEntryProperty,
} from './repository/remotes/inspection.js';
export { GitRemoteConfigurationService } from './repository/remotes/service.js';
export type * from './repository/remotes/contracts.js';
export type {
  GitActiveFilter,
  GitAttributeSource,
  GitDelegateAuthorization,
  GitDelegateAuthorizer,
  GitConfiguredDelegate,
  GitDelegateGuardInput,
  GitDelegateInspection,
  GitDelegateOperation,
  GitDelegatePlan,
  GitDelegatePlanDeclaration,
  GitDelegatePlanFilter,
} from './repository/delegates/contracts.js';
export {
  GitDelegateApprovalRequiredError,
  type GitDelegateBlockReason,
} from './repository/delegates/error.js';
export {
  GitHubCliExecutor,
  GitHubService,
  type CiStatusPlanInput,
  type GitHubCommandOptions,
  type GitHubCommandResult,
  type GitHubCommandRunner,
  type GitHubExecutionOptions,
  type PullRequestPlanInput,
  type RemoteSnapshotInput,
} from './github/client.js';
export {
  assertGitBranchName,
  assertGitHubRepositoryIdentity,
  assertGitHubResultUrl,
  parseGitHubRemoteIdentity,
  type GitHubRemoteIdentity,
} from './github/remote-identity.js';
export {
  assertPathUnderManagedRoot,
  canonicalDirectory,
  isPathInside,
  prepareManagedRoot,
  safeSlug,
} from './repository/path-safety.js';
export { RepositoryService } from './repository/service.js';
export {
  parseAheadBehind,
  parseGitStatus,
  parseRemotes,
  parseSubmodules,
} from './repository/status-parser.js';
export type * from './model/types.js';
export type * from './repository/worktree-recovery/contracts.js';
export { WorktreeService } from './repository/worktrees.js';

export const GIT_ENGINE_PACKAGE_VERSION = '0.1.0';
