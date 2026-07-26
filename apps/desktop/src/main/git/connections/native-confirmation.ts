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
    `Current location: ${targetDescription(plan.before?.target ?? null)}`,
    `New location: ${targetDescription(plan.target)}`,
    configurationImpact(review),
    '',
    'This change is local only — nothing is fetched, pushed, or sent over the network, and Artemis does not check that the location works.',
  ];
  if (plan.removal !== null) {
    details.push('', `Remote settings to remove (${String(plan.before?.entries.length ?? 0)}):`);
    details.push(
      plan.before?.entries.length === 0
        ? '(none)'
        : (plan.before?.entries.map((entry) => `${entry.scope}: ${entry.key}`).join('\n') ??
            '(none)'),
    );
    details.push(
      '',
      `Saved branch copies to remove (${String(plan.removal.trackingRefs.length)}):`,
    );
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
    `Source: ${automatic ? 'found automatically on this computer' : 'file you chose'}`,
    `Program file: ${review.executablePath ?? '(none found)'}`,
    `File name: ${candidate?.filename ?? '(none)'}`,
    `Size: ${candidate === null ? '(none)' : `${String(candidate.sizeBytes)} bytes`}`,
    `Fingerprint (SHA-256): ${candidate?.sha256 ?? '(none)'}`,
    `Version check: ${
      review.executablePath === null ? '(none)' : `${review.executablePath} --version`
    }`,
    '',
    candidate === null
      ? 'No GitHub CLI program was found on this computer. Confirming removes your saved custom choice, and GitHub features stay unavailable until the gh program is installed.'
      : 'If you confirm, Artemis runs only the exact program file above, with just the --version flag, and applies the change only if the file is unchanged and answers as the GitHub CLI.',
    '',
    'This check stays on this computer: Artemis sends no repository data or sign-in tokens to the version command. The program you choose is trusted local code and runs with your permissions.',
  ];
  return {
    type: 'warning',
    buttons: ['Cancel', action],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Change GitHub CLI setup?',
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
  if (target === null) return '(none, or an advanced setup)';
  if (target.kind === 'local-filesystem') return `Local repository at ${target.resource}`;
  return `${target.transport.toUpperCase()} ${target.exactUrl}`;
}

function configurationImpact(review: GitConnectionNativeReview): string {
  const plan = review.exactPlan;
  if (plan.kind === 'add') {
    return 'What changes: adds one remote URL and the standard setting that fetches its branches.';
  }
  if (plan.kind === 'replace') {
    return `What changes: replaces one URL. The ${String(
      plan.before?.entries.length ?? 0,
    )} reviewed settings otherwise stay unchanged, and every saved branch copy is kept.`;
  }
  return `What changes: removes the ${String(
    plan.removal?.configurationEntryCount ?? 0,
  )} remote settings listed below and the saved copies of its branches. Setting values are hidden because remote URLs can contain sign-in details. Your local branches, commits, other remotes, and files stay untouched.`;
}
