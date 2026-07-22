import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';

import { displayEscapedText, displayLiteral } from '../../shared/text/display-literal.js';
import type { TerminalLaunchNativeReview } from './service.js';

export interface TerminalLaunchConfirmation {
  readonly decision: 'approved' | 'denied';
  readonly remember: boolean;
}

export async function confirmTerminalLaunch(
  dialog: Pick<Dialog, 'showMessageBox'>,
  parent: BrowserWindow,
  review: TerminalLaunchNativeReview,
  assertCurrent: () => void,
): Promise<TerminalLaunchConfirmation> {
  assertCurrent();
  const response = await dialog.showMessageBox(parent, terminalLaunchMessage(review));
  assertCurrent();
  return response.response === 1
    ? { decision: 'approved', remember: response.checkboxChecked }
    : { decision: 'denied', remember: false };
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
      `Program: ${displayLiteral(exact.executable)}`,
      `Folder to run in: ${displayLiteral(exact.cwd)}`,
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
      'Runs as: your user account on this computer (not sandboxed).',
      'The folder it runs in and the environment settings do not limit what this program can access. It can reach anything your user account can reach, and it can use the network.',
      '',
      `This one-time launch approval expires at ${view.expiresAt}. Forgeboard rechecks the exact program identity, project, and folder immediately before starting it.`,
      'If you trust this exact launch for 30 days, Forgeboard will still recheck its program, arguments, project folder, and environment-variable names before every start. Any change requires another native approval.',
    ].join('\n'),
    buttons: ['Cancel', 'Launch terminal'],
    checkboxLabel: 'Trust this exact launch for this project for 30 days',
    checkboxChecked: false,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
