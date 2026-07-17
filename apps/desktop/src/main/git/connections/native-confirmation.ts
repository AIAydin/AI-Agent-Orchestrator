import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';

import type { GitHubCliSelectionReview } from '../github-cli/runtime.js';
import type { GitConnectionNativeReview } from './service.js';

export async function confirmGitConnectionMutation(
  dialog: Pick<Dialog, 'showMessageBox'>,
  parent: BrowserWindow,
  review: GitConnectionNativeReview,
  assertCurrent: () => void,
): Promise<'approved' | 'denied'> {
  assertCurrent();
  const response = await dialog.showMessageBox(parent, gitConnectionMessage(review));
  assertCurrent();
  return response.response === 1 ? 'approved' : 'denied';
}

export async function confirmGitHubCliSelection(
  dialog: Pick<Dialog, 'showMessageBox'>,
  parent: BrowserWindow,
  review: GitHubCliSelectionReview,
  assertCurrent: () => void,
): Promise<'approved' | 'denied'> {
  assertCurrent();
  const response = await dialog.showMessageBox(parent, gitHubCliMessage(review));
  assertCurrent();
  return response.response === 1 ? 'approved' : 'denied';
}

function gitConnectionMessage(review: GitConnectionNativeReview): MessageBoxOptions {
  const { exactPlan: plan, view } = review;
  const action = actionLabel(plan.kind);
  const details = [
    `Project: ${view.projectName}`,
    `Remote: ${plan.name}`,
    `Action: ${action}`,
    `Current target: ${targetDescription(plan.before?.target ?? null)}`,
    `New target: ${targetDescription(plan.target)}`,
    configurationImpact(review),
    '',
    'Network access: None. This action changes only local Git configuration and the disclosed local remote-tracking references. It does not fetch, push, authenticate, or test reachability.',
  ];
  if (plan.removal !== null) {
    details.push('', `Configuration keys (${String(plan.before?.entries.length ?? 0)}):`);
    details.push(
      plan.before?.entries.length === 0
        ? '(none)'
        : (plan.before?.entries.map((entry) => `${entry.scope}: ${entry.key}`).join('\n') ??
            '(none)'),
    );
    details.push('', `Remote-tracking references (${String(plan.removal.trackingRefs.length)}):`);
    details.push(
      plan.removal.trackingRefs.length === 0
        ? '(none)'
        : plan.removal.trackingRefs.map((ref) => ref.name).join('\n'),
    );
  }
  return {
    type: 'warning',
    buttons: ['Cancel', `${action} remote`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: `${action} Git remote?`,
    message: `${action} ${plan.name} for ${view.projectName}?`,
    detail: details.join('\n'),
  };
}

function gitHubCliMessage(review: GitHubCliSelectionReview): MessageBoxOptions {
  const automatic = review.source === 'automatic';
  const candidate = review.candidate;
  const action = automatic ? 'Use automatic GitHub CLI' : 'Use selected GitHub CLI';
  const details = [
    `Source: ${automatic ? 'Automatic desktop PATH discovery' : 'Custom executable'}`,
    `Executable: ${review.executablePath ?? '(none currently detected)'}`,
    `Filename: ${candidate?.filename ?? '(none)'}`,
    `Size: ${candidate === null ? '(none)' : `${String(candidate.sizeBytes)} bytes`}`,
    `SHA-256: ${candidate?.sha256 ?? '(none)'}`,
    `Validation command: ${
      review.executablePath === null ? '(none)' : `${review.executablePath} --version`
    }`,
    '',
    candidate === null
      ? 'No executable is currently detected. Confirming clears the saved custom selection and leaves GitHub CLI features unavailable until gh appears on the desktop PATH.'
      : 'After approval, Forgeboard starts only the exact executable above with the literal --version argument. It accepts the change only if the file identity still matches and the output identifies GitHub CLI.',
    '',
    'Network access: None requested by Forgeboard for this validation. The selected executable is trusted local code; Forgeboard does not pass repository data or tokens to the version command.',
  ];
  return {
    type: 'warning',
    buttons: ['Cancel', action],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Change GitHub CLI configuration?',
    message: `${action}?`,
    detail: details.join('\n'),
  };
}

function actionLabel(kind: 'add' | 'replace' | 'remove'): 'Add' | 'Replace' | 'Remove' {
  if (kind === 'add') return 'Add';
  if (kind === 'replace') return 'Replace';
  return 'Remove';
}

function targetDescription(target: GitConnectionNativeReview['exactPlan']['target']): string {
  if (target === null) return '(none or advanced configuration)';
  if (target.kind === 'local-filesystem') return `Local repository at ${target.resource}`;
  return `${target.transport.toUpperCase()} ${target.exactUrl}`;
}

function configurationImpact(review: GitConnectionNativeReview): string {
  const plan = review.exactPlan;
  if (plan.kind === 'add') {
    return 'Configuration impact: add one remote URL and its standard fetch refspec.';
  }
  if (plan.kind === 'replace') {
    return `Configuration impact: change one URL value while preserving the other reviewed configuration entries, the reviewed entry count (${String(
      plan.before?.entries.length ?? 0,
    )}), and every remote-tracking reference.`;
  }
  return `Configuration impact: remove ${String(
    plan.removal?.configurationEntryCount ?? 0,
  )} remote configuration entries identified by scope and key below, plus the exact references listed below. Values are omitted because remote URLs can contain credentials. Local branches, commits, other remotes, and worktree files remain.`;
}
