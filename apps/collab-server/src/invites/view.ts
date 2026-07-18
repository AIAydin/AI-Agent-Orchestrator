import {
  CollaborationManagementInviteSchema,
  type CollaborationManagementInvite,
} from '@forgeboard/core/collaboration-management';

import type { InviteRecord } from '../store.js';

export function inviteHistoryView(
  invite: InviteRecord,
  signingAuthority: string,
  now = new Date(),
): CollaborationManagementInvite {
  const status =
    invite.revokedAt !== undefined
      ? 'revoked'
      : invite.signingAuthority !== signingAuthority
        ? 'invalidated'
        : new Date(invite.expiresAt).getTime() <= now.getTime()
          ? 'expired'
          : invite.useCount >= invite.maxUses
            ? 'exhausted'
            : 'active';
  return CollaborationManagementInviteSchema.parse({
    id: invite.id,
    roomId: invite.roomId,
    role: invite.role,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    maxUses: invite.maxUses,
    useCount: invite.useCount,
    revokedAt: invite.revokedAt ?? null,
    status,
  });
}
