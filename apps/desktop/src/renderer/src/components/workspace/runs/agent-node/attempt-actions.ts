import type { RunAdapterId } from '../../../../../../shared/application/contracts.js';
import type { PermissionProfile } from '../../../../../../shared/permissions/contracts.js';
import type { RunHistorySummary } from '../../../../../../shared/runs/contracts.js';

export type AgentContinuationAction = 'resume' | 'retry';

export interface SelectedAgentAuthority {
  readonly adapterId: RunAdapterId;
  readonly model: string | null;
  readonly permissionProfile: PermissionProfile;
}

const RETRYABLE_STATUSES = new Set<RunHistorySummary['status']>([
  'failed',
  'interrupted',
  'terminated',
  'lost',
]);

export function continuationUnavailableReason(
  attempt: RunHistorySummary,
  action: AgentContinuationAction,
  selected: SelectedAgentAuthority,
): string | null {
  if (
    attempt.adapterId !== selected.adapterId ||
    attempt.model !== selected.model ||
    attempt.permissionProfile !== selected.permissionProfile
  ) {
    return 'Restore this attempt’s adapter, model, and permission profile before continuing it.';
  }
  if (attempt.supersededByNewerAttempt) {
    return 'A newer resumed attempt already owns this continuation target.';
  }
  if (action === 'retry') {
    return RETRYABLE_STATUSES.has(attempt.status)
      ? null
      : 'Only a failed, interrupted, terminated, or lost attempt can be retried.';
  }
  if (attempt.status !== 'interrupted') {
    return 'Only an interrupted provider attempt can be resumed.';
  }
  if (!attempt.providerSessionAvailable || !attempt.resumeSupported) {
    return 'This attempt did not expose both a provider session and declared or probed resume support.';
  }
  if (attempt.worktreeState !== 'none' && !attempt.worktreeAvailable) {
    return 'The saved worktree authority is no longer available for resume.';
  }
  return null;
}
