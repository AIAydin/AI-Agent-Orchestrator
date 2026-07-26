import { GitEngineError } from '../../model/errors.js';
import type { GitDelegatePlan } from './contracts.js';

export type GitDelegateBlockReason =
  | 'approval-cancelled'
  | 'approval-required'
  | 'configuration-missing'
  | 'partial-staging-unsupported'
  | 'plan-changed';

/** Stable typed failure consumed by desktop UI/native authorization boundaries. */
export class GitDelegateApprovalRequiredError extends GitEngineError {
  public readonly plan: GitDelegatePlan;
  public readonly reason: GitDelegateBlockReason;

  public constructor(plan: GitDelegatePlan, reason: GitDelegateBlockReason) {
    super('EXTERNAL_DRIVER_BLOCKED', blockMessage(reason), { reason, plan });
    this.name = 'GitDelegateApprovalRequiredError';
    this.plan = plan;
    this.reason = reason;
  }
}

function blockMessage(reason: GitDelegateBlockReason): string {
  if (reason === 'approval-cancelled') return 'Git filter execution was cancelled.';
  if (reason === 'configuration-missing') {
    return 'Artemis blocked filtered content because its declared Git filter has no executable configuration to reproduce the repository content safely.';
  }
  if (reason === 'plan-changed') {
    return 'The Git filter command, configuration, or affected paths changed after approval. Review the updated operation.';
  }
  if (reason === 'partial-staging-unsupported') {
    return 'Files with Git clean or process filters must be staged as whole files. Partial hunk staging was blocked before any filter or index update ran.';
  }
  return 'This repository operation requires explicit approval for its exact Git filter command.';
}
