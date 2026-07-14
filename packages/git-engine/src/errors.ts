export type GitEngineErrorCode =
  | 'ABORTED'
  | 'APPROVAL_MISMATCH'
  | 'COMMAND_FAILED'
  | 'DIRTY_WORKTREE'
  | 'INVALID_ARGUMENT'
  | 'INVALID_MANAGED_ROOT'
  | 'INVALID_PATCH'
  | 'NOT_A_REPOSITORY'
  | 'NOT_MERGED'
  | 'OUTPUT_LIMIT'
  | 'OWNERSHIP_MISMATCH'
  | 'STALE_APPROVAL'
  | 'TIMEOUT';

export class GitEngineError extends Error {
  public readonly code: GitEngineErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: GitEngineErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitEngineError';
    this.code = code;
    this.details = details;
  }
}
