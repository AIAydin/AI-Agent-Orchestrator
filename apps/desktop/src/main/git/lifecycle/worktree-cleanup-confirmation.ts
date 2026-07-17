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
        'Fresh recovery confirmation: a previous cleanup stopped before Forgeboard could record a complete result.',
        'Only the remaining parts of this exact managed worktree, branch, and ownership metadata will be removed.',
        '',
      ]
    : [];
  return {
    type: 'warning',
    title: plan.recovery ? 'Continue interrupted worktree cleanup' : 'Clean up agent worktree',
    message: plan.recovery
      ? 'Continue removing the remaining exact worktree cleanup target?'
      : 'Permanently remove this worktree and its managed branch?',
    detail: [
      ...recoveryDetail,
      `Branch: ${boundedLiteral(plan.branch, 4_096)}`,
      `Base: ${boundedLiteral(plan.baseRef, 4_096)}`,
      `Worktree directory: ${boundedLiteral(impact.ownership.worktreePath, 8_192)}`,
      `Branch commit: ${abbreviatedOid(impact.branchOid)}`,
      `Recorded base commit: ${abbreviatedOid(impact.ownership.baseCommit)}`,
      `Current primary HEAD: ${abbreviatedOid(impact.expectedHead)}`,
      `Working tree: ${plan.clean ? 'clean' : `${String(plan.dirtyPathCount)} changed path(s)`}`,
      `Merged into base: ${plan.mergedIntoBase ? 'yes' : 'no'}`,
      ...(paths.length === 0 ? [] : ['', ...paths]),
      '',
      plan.recovery
        ? 'Forgeboard will continue only this freshly reviewed interrupted cleanup. It may remove the remaining exact worktree, managed branch, and ownership metadata. Cleanup is refused if the target changed or any Forgeboard-managed process could still be using a project directory.'
        : 'Forgeboard will remove only the exact managed worktree reviewed in this plan and delete its managed branch. Cleanup is refused if the worktree is dirty, the branch is unmerged, the target changed, or any Forgeboard-managed process could still be using a project directory.',
      'This cannot be undone by Forgeboard.',
    ].join('\n'),
    buttons: [
      'Cancel',
      plan.recovery ? 'Continue interrupted cleanup' : 'Clean up worktree and branch',
    ],
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
