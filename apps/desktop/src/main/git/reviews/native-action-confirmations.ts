import type { MessageBoxOptions } from 'electron';

import type { GitReviewTargetView } from '../../../shared/git/contracts.js';
import { displayEscapedText } from '../../../shared/text/display-literal.js';
import type { PendingCommitPlan, PendingDiscardPlan } from '../git-ipc.js';

export function commitConfirmation(plan: PendingCommitPlan): MessageBoxOptions {
  return {
    type: 'question',
    title: 'Commit staged changes?',
    message: `Commit ${String(plan.stagedPaths.length)} staged file${plan.stagedPaths.length === 1 ? '' : 's'}?`,
    detail: [
      `Where: ${targetDisclosure(plan.target)}`,
      `Branch: ${plan.branch === null ? 'no branch checked out' : displayBoundedLiteral(plan.branch, 4_096)}`,
      `Commit author: ${displayBoundedLiteral(plan.identity.name, 512)} <${displayBoundedLiteral(plan.identity.email, 512)}>`,
      `Commit message: ${displayBoundedLiteral(plan.message, 2_048)}`,
      `Changes: +${String(plan.additions)} / -${String(plan.deletions)}`,
      '',
      ...boundedPathDisclosure(plan.stagedPaths),
      '',
      'Artemis commits only the exact staged snapshot you reviewed. If the latest commit on the branch or the staged content changed, the commit is refused.',
      'Repository hooks (custom scripts) and commit signing are skipped for this commit.',
    ].join('\n'),
    buttons: ['Cancel', 'Commit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export function discardConfirmation(plan: PendingDiscardPlan): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Discard uncommitted changes?',
    message: `Permanently discard ${String(plan.hunkIds.length)} selected change block${plan.hunkIds.length === 1 ? '' : 's'}?`,
    detail: [
      `Where: ${targetDisclosure(plan.target)}`,
      `Branch: ${plan.branch === null ? 'no branch checked out' : displayBoundedLiteral(plan.branch, 4_096)}`,
      `Changes removed: +${String(plan.additions)} / -${String(plan.deletions)}`,
      '',
      ...boundedPathDisclosure(plan.paths),
      '',
      'This rewrites files in your workspace and cannot be undone by Artemis. It applies only to the exact change blocks you reviewed and fails if anything changed.',
    ].join('\n'),
    buttons: ['Cancel', 'Discard selected changes'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export function externalOpenConfirmation(
  target: GitReviewTargetView,
  branch: string | null,
  application: {
    readonly kind: 'executable' | 'macos-app-bundle';
    readonly applicationPath: string;
    readonly workspacePath: string;
  } | null,
): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Open workspace in an external application?',
    message: `Open the ${target.kind === 'primary' ? 'main project workspace' : 'agent workspace'} outside Artemis?`,
    detail: [
      `Where: ${targetDisclosure(target)}`,
      `Branch: ${branch === null ? 'no branch checked out' : displayBoundedLiteral(branch, 4_096)}`,
      ...(application === null
        ? ['Application: operating-system default']
        : application.kind === 'macos-app-bundle'
          ? [
              `macOS application bundle: ${displayBoundedLiteral(application.applicationPath, 32_768)}`,
              'Launcher: /usr/bin/open -a (no shell)',
              `Literal workspace: ${displayBoundedLiteral(application.workspacePath, 32_768)}`,
            ]
          : [
              `Executable: ${displayBoundedLiteral(application.applicationPath, 32_768)}`,
              `Literal argument: ${displayBoundedLiteral(application.workspacePath, 32_768)}`,
            ]),
      '',
      application === null
        ? 'Your operating system chooses the registered application. It runs outside Artemis’s sandbox and may read or change any file in this workspace.'
        : application.kind === 'macos-app-bundle'
          ? 'macOS Launch Services opens the reviewed application bundle outside Artemis’s sandbox. The application may read or change any file in this workspace. The exact bundle path and workspace are passed to /usr/bin/open without a shell.'
          : 'The selected executable runs directly, outside Artemis’s sandbox, and may read or change any file in this workspace. No shell or additional arguments are used.',
      'Artemis passes only the main-owned workspace path after revalidating the selected project or agent run. The path is never accepted from the renderer.',
    ].join('\n'),
    buttons: ['Cancel', 'Open externally'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function boundedPathDisclosure(paths: readonly string[]): string[] {
  const shown = paths.slice(0, 20).map((path) => `• ${displayBoundedLiteral(path, 512)}`);
  return paths.length > shown.length
    ? [...shown, `• …and ${String(paths.length - shown.length)} more`]
    : shown;
}

function displayBoundedLiteral(value: string, maxLength: number): string {
  const encoded = displayEscapedText(value);
  return encoded.length > maxLength ? `${encoded.slice(0, maxLength)}…` : encoded;
}

function targetDisclosure(target: GitReviewTargetView): string {
  return target.kind === 'primary'
    ? 'primary checkout'
    : `agent workspace for run ${target.runId.slice(0, 12)} (base ${target.baseCommit.slice(0, 12)})`;
}
