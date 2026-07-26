import type { MessageBoxOptions } from 'electron';

import { displayLiteral } from '../../../shared/text/display-literal.js';
import type { PendingWorktreeMetadataPlan } from '../git-ipc.js';

export function worktreeMetadataConfirmation(plan: PendingWorktreeMetadataPlan): MessageBoxOptions {
  if (plan.kind === 'rename-worktree-branch') {
    return {
      type: 'warning',
      title: 'Rename this managed branch?',
      message: `Rename ${displayLiteral(plan.branch)} to ${displayLiteral(plan.newBranch)}?`,
      detail: [
        `Current branch: ${displayLiteral(plan.branch)}`,
        `New branch: ${displayLiteral(plan.newBranch)}`,
        `Current branch commit: ${plan.expectedBranchOid}`,
        `Uncommitted paths retained: ${String(plan.dirtyPaths.length)}`,
        '',
        'Artemis will rename only this managed branch and update every saved attempt that owns the same worktree. It will not change files, commits, the primary checkout, or any remote.',
        'The operation is refused if the branch, worktree ownership, commit, or uncommitted paths changed after review.',
      ].join('\n'),
      buttons: ['Cancel', 'Rename branch'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
  }
  if (plan.kind === 'archive-worktree')
    return {
      type: 'warning',
      title: 'Archive this managed worktree?',
      message: `Archive ${displayLiteral(plan.branch)} in Artemis?`,
      detail: [
        `Branch retained: ${displayLiteral(plan.branch)}`,
        `Current branch commit: ${plan.expectedBranchOid ?? 'branch unavailable'}`,
        `Uncommitted paths retained: ${String(plan.dirtyPaths.length)}`,
        '',
        'Archiving hides this worktree from active Artemis Git actions. Its folder, files, uncommitted work, commits, and branch remain on this computer.',
        'Nothing is deleted, reset, cleaned, merged, or pushed. The operation is refused if ownership or Git state changed after review.',
      ].join('\n'),
      buttons: ['Cancel', 'Archive worktree'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
  return {
    type: 'warning',
    title: 'Restore this archived worktree?',
    message: `Restore ${displayLiteral(plan.branch)} to active Artemis Git actions?`,
    detail: [
      `Branch retained: ${displayLiteral(plan.branch)}`,
      `Current branch commit: ${plan.expectedBranchOid ?? 'branch unavailable'}`,
      `Uncommitted paths retained: ${String(plan.dirtyPaths.length)}`,
      '',
      'Restoring makes the existing worktree available for review again. It does not change its folder, files, commits, branch, primary checkout, or any remote.',
      'The operation is refused if ownership or Git state changed after review.',
    ].join('\n'),
    buttons: ['Cancel', 'Restore worktree'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
