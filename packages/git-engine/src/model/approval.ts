import { GitEngineError } from './errors.js';
import type { GitApproval } from './types.js';

export function assertExplicitApproval(
  approval: GitApproval,
  expectedAction: GitApproval['action'],
): void {
  if (
    approval.approved !== true ||
    approval.action !== expectedAction ||
    approval.approvalId.trim() === '' ||
    !Number.isFinite(Date.parse(approval.approvedAt))
  ) {
    throw new GitEngineError('APPROVAL_MISMATCH', 'A valid, explicit Git approval is required.', {
      expectedAction,
    });
  }
}

export function assertSameStrings(
  actual: readonly string[],
  approved: readonly string[],
  label: string,
): void {
  const normalizedActual = [...new Set(actual)].sort();
  const normalizedApproved = [...new Set(approved)].sort();
  if (
    normalizedActual.length !== actual.length ||
    normalizedApproved.length !== approved.length ||
    normalizedActual.length !== normalizedApproved.length ||
    normalizedActual.some((value, index) => value !== normalizedApproved[index])
  ) {
    throw new GitEngineError('APPROVAL_MISMATCH', `Approved ${label} no longer match.`, {
      actual: normalizedActual,
      approved: normalizedApproved,
    });
  }
}
