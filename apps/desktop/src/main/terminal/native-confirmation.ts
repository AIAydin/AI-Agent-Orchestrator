import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';

import { displayEscapedText, displayLiteral } from '../../shared/text/display-literal.js';
import type { TerminalLaunchNativeReview } from './service.js';

export async function confirmTerminalLaunch(
  dialog: Pick<Dialog, 'showMessageBox'>,
  parent: BrowserWindow,
  review: TerminalLaunchNativeReview,
  assertCurrent: () => void,
): Promise<'approved' | 'denied'> {
  assertCurrent();
  const response = await dialog.showMessageBox(parent, terminalLaunchMessage(review));
  assertCurrent();
  return response.response === 1 ? 'approved' : 'denied';
}

export function terminalLaunchMessage(review: TerminalLaunchNativeReview): MessageBoxOptions {
  const { exact, view } = review;
  const argumentsDisclosure =
    exact.arguments.length === 0
      ? '(none)'
      : exact.arguments
          .map((argument, index) => `${String(index + 1)}. ${displayLiteral(argument)}`)
          .join('\n');
  return {
    type: 'warning',
    title: 'Launch local terminal?',
    message: `Launch a terminal for ${displayEscapedText(view.projectName)}?`,
    detail: [
      `Project: ${displayEscapedText(view.projectName)}`,
      `Node: ${displayLiteral(view.nodeId)}`,
      `Executable: ${displayLiteral(exact.executable)}`,
      `Working directory: ${displayLiteral(exact.cwd)}`,
      `Columns × rows: ${String(view.columns)} × ${String(view.rows)}`,
      `Environment variable names: ${
        exact.environmentVariableNames.length === 0
          ? '(none)'
          : exact.environmentVariableNames.map(displayLiteral).join(', ')
      }`,
      '',
      `Arguments (${String(exact.arguments.length)}):`,
      argumentsDisclosure,
      '',
      'Permission: local operating-system user (not sandboxed).',
      'The working directory and environment allowlist do not prevent this executable from accessing anything your operating-system account can access. The executable can also use the network under your account permissions.',
      '',
      `This approval is single-use and expires at ${view.expiresAt}. Forgeboard rechecks the exact executable identity, project, and working directory immediately before spawning it.`,
    ].join('\n'),
    buttons: ['Cancel', 'Launch terminal'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
