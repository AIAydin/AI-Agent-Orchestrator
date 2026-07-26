import type { CleanupImpact } from '@forgeboard/git-engine';
import type { MessageBoxOptions } from 'electron';

import type { GitWorktreeCleanupPlanView } from '../../../shared/git/lifecycle/contracts.js';
import { displayEscapedText } from '../../../shared/text/display-literal.js';

const MAX_DISCLOSED_PATHS = 20;

export function cleanupConfirmation(
  plan: GitWorktreeCleanupPlanView,
  impact: CleanupImpact,
): MessageBoxOptions {
  const paths = plan.dirtyPaths.slice(0, MAX_DISCLOSED_PATHS).map((path) => {
    return `• ${boundedLiteral(path, 4_096)}`;
  });
  if (plan.dirtyPathCount > paths.length) {
    paths.push(`• …and ${String(plan.dirtyPathCount - paths.length)} more`);
  }
  const recoveryDetail = plan.recovery
    ? [
        'A previous cleanup was interrupted before Artemis could finish recording it. This is a fresh review of what remains.',
        "Only the leftover workspace folder, its branch, and Artemis's ownership records for it will be removed.",
        '',
      ]
    : [];
  return {
    type: 'warning',
    title: plan.recovery ? 'Continue the interrupted cleanup?' : 'Clean up the agent workspace?',
    message: plan.recovery
      ? 'Continue deleting what remains of this agent workspace?'
      : 'Permanently delete this agent workspace and its branch?',
    detail: [
      ...recoveryDetail,
      `Agent branch: ${boundedLiteral(plan.branch, 4_096)}`,
      `Recorded base branch: ${boundedLiteral(plan.baseRef, 4_096)}`,
      `Workspace folder: ${boundedLiteral(impact.ownership.worktreePath, 8_192)}`,
      `Latest branch commit: ${abbreviatedOid(impact.branchOid)}`,
      `Recorded base commit: ${abbreviatedOid(impact.ownership.baseCommit)}`,
      `Current primary commit: ${abbreviatedOid(impact.expectedHead)}`,
      `Unsaved changes: ${plan.clean ? 'none' : `${String(plan.dirtyPathCount)} file(s)`}`,
      `Merged into the base branch: ${plan.mergedIntoBase ? 'yes' : 'no'}`,
      ...(paths.length === 0 ? [] : ['', ...paths]),
      '',
      plan.recovery
        ? 'Artemis continues only the interrupted cleanup you just reviewed: it removes the leftover workspace folder, its branch, and its ownership records. Cleanup is refused if anything changed or if a Artemis-managed process could still be using a project folder.'
        : 'Artemis removes only the exact agent workspace you reviewed and deletes its branch. Cleanup is refused if the workspace has unsaved changes, the branch is not fully merged, anything changed, or a Artemis-managed process could still be using a project folder.',
      'This cannot be undone by Artemis.',
    ].join('\n'),
    buttons: ['Cancel', plan.recovery ? 'Continue cleanup' : 'Delete workspace and branch'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function abbreviatedOid(value: string | null): string {
  return value === null ? '(missing)' : boundedLiteral(value.slice(0, 12), 12);
}

function boundedLiteral(value: string, maxLength: number): string {
  const encoded = displayEscapedText(value);
  return encoded.length > maxLength ? `${encoded.slice(0, maxLength)}…` : encoded;
}
