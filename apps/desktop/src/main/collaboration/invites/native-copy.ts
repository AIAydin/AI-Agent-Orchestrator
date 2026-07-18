import type { BrowserWindow, Dialog } from 'electron';

import {
  CollaborationInviteSafeViewSchema,
  type CollaborationInviteSafeView,
} from '../../../shared/collaboration/index.js';
import { displayEscapedText } from '../../../shared/text/display-literal.js';

export async function confirmInviteLinkCopy(input: {
  readonly dialog: Pick<Dialog, 'showMessageBox'>;
  readonly parent: BrowserWindow;
  readonly invite: CollaborationInviteSafeView;
  readonly assertCurrent: () => void;
}): Promise<boolean> {
  const invite = CollaborationInviteSafeViewSchema.parse(input.invite);
  input.assertCurrent();
  const decision = await input.dialog.showMessageBox(input.parent, {
    type: 'warning',
    title: 'Copy collaboration invite?',
    message: `Copy the ${displayEscapedText(invite.role)} invite link?`,
    detail: [
      `Room: ${displayEscapedText(invite.roomId)}`,
      `Invite ID: ${displayEscapedText(invite.id)}`,
      `Expires: ${displayEscapedText(invite.expiresAt)}`,
      `Maximum uses: ${String(invite.maxUses)}`,
      '',
      'Anyone with the copied link can redeem it until it expires, is revoked, or reaches its use limit.',
    ].join('\n'),
    buttons: ['Cancel', 'Copy invite'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  input.assertCurrent();
  return decision.response === 1;
}
