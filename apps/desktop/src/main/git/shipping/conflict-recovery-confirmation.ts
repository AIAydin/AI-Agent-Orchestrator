import type { MessageBoxOptions } from 'electron';

import { displayLiteral } from '../../../shared/text/display-literal.js';
import type { PendingConflictRecoveryPlan } from './conflict-recovery-service.js';

export function conflictRecoveryConfirmation(plan: PendingConflictRecoveryPlan): MessageBoxOptions {
  const continuing = plan.action === 'continue';
  return {
    type: 'warning',
    title: continuing ? `Continue ${plan.operation}?` : `Abort ${plan.operation}?`,
    message: continuing
      ? `Continue the exact reviewed ${plan.operation} operation?`
      : `Abort the exact reviewed ${plan.operation} operation?`,
    detail: [
      `Workspace: ${plan.target.kind === 'primary' ? 'primary checkout' : 'managed agent worktree'}`,
      `Current commit: ${plan.expectedHead}`,
      `Conflicted files (${String(plan.conflictedPaths.length)}):`,
      ...plan.conflictedPaths.map((path) => `• ${displayLiteral(path)}`),
      `Staged files (${String(plan.stagedPaths.length)}):`,
      ...plan.stagedPaths.map((path) => `• ${displayLiteral(path)}`),
      '',
      continuing
        ? 'Artemis will refuse to continue if the operation, commit, paths, staged resolution, or unstaged content changed after this review.'
        : 'Aborting restores Git’s pre-operation state. Artemis will refuse if the operation or any reviewed conflict content changed.',
    ].join('\n'),
    buttons: ['Cancel', continuing ? `Continue ${plan.operation}` : `Abort ${plan.operation}`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
