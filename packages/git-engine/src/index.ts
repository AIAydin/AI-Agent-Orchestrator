export { ChangeService, type WorktreeDiffMode } from './changes.js';
export { parseUnifiedDiff, patchSha256, selectDiffHunks } from './diff-parser.js';
export { GitEngineError, type GitEngineErrorCode } from './errors.js';
export {
  GitExecutor,
  type GitCommandOptions,
  type GitCommandResult,
  type GitExecutorOptions,
} from './executor.js';
export {
  assertPathUnderManagedRoot,
  canonicalDirectory,
  isPathInside,
  prepareManagedRoot,
  safeSlug,
} from './path-safety.js';
export { RepositoryService } from './repository.js';
export {
  parseAheadBehind,
  parseGitStatus,
  parseRemotes,
  parseSubmodules,
} from './status-parser.js';
export type * from './types.js';
export { WorktreeService } from './worktrees.js';

export const GIT_ENGINE_PACKAGE_VERSION = '0.1.0';
