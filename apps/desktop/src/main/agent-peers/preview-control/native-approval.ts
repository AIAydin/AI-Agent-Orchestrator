import { BrowserWindow, type Dialog, type MessageBoxOptions } from 'electron';

import { displayLiteral } from '../../../shared/text/display-literal.js';
import type { PreviewActionApprovalRequest, PreviewActionAuthorizer } from './contracts.js';

export function createNativePreviewActionAuthorizer(
  dialog: Pick<Dialog, 'showMessageBox'>,
  findParent: () => BrowserWindow | null = () =>
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible()) ??
    null,
): PreviewActionAuthorizer {
  return async (request) => {
    const parent = findParent();
    if (parent === null || parent.isDestroyed()) return false;
    const decision = await dialog.showMessageBox(parent, previewActionMessage(request));
    return decision.response === 1;
  };
}

export function previewActionMessage(request: PreviewActionApprovalRequest): MessageBoxOptions {
  const intent = request.intent;
  const actionDescription =
    intent.action === 'click'
      ? `click ${displayLiteral(intent.element.name)}`
      : `type into ${displayLiteral(intent.element.name)}`;
  const details = [
    `Agent: ${displayLiteral(request.agentName)}`,
    `Preview: ${displayLiteral(request.previewName)}`,
    `Site: ${displayLiteral(intent.origin)}`,
    `Control: ${intent.element.kind} - ${displayLiteral(intent.element.name)}`,
    ...(intent.element.destination === null
      ? []
      : [`Destination: ${displayLiteral(intent.element.destination)}`]),
    ...(intent.textPreview === null
      ? []
      : [
          `Text (${String(intent.textLength ?? intent.textPreview.length)} characters):`,
          displayLiteral(intent.textPreview),
        ]),
    '',
    'Website content is untrusted. Approve only if this matches what you asked the agent to do.',
  ];
  return {
    type: intent.consequential ? 'warning' : 'question',
    title: 'Allow agent browser action?',
    message: `${displayLiteral(request.agentName)} wants to ${actionDescription}.`,
    detail: details.join('\n'),
    buttons: ['Cancel', 'Allow once'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
