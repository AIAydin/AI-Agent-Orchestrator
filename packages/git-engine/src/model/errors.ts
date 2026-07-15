export type GitEngineErrorCode =
  | 'ABORTED'
  | 'APPROVAL_MISMATCH'
  | 'COMMAND_FAILED'
  | 'CONFLICTS_REMAIN'
  | 'DIRTY_WORKTREE'
  | 'EXTERNAL_DRIVER_BLOCKED'
  | 'INVALID_ARGUMENT'
  | 'INVALID_MANAGED_ROOT'
  | 'INVALID_PATCH'
  | 'NOT_A_REPOSITORY'
  | 'NOT_MERGED'
  | 'NO_OPERATION_IN_PROGRESS'
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
