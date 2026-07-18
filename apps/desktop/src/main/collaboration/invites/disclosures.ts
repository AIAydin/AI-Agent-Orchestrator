import { createHash } from 'node:crypto';

import {
  CollaborationInviteCreateInputSchema,
  CollaborationInviteIdSchema,
  CollaborationJoinInviteInputSchema,
  type CollaborationInviteCreateInput,
  type CollaborationJoinInviteInput,
} from '../../../shared/collaboration/index.js';
import type { OutboundActionDisclosure } from '../../outbound/outbound-action-gate.js';
import type { CollaborationInviteSessionLease } from './session.js';

export function inviteCreateDisclosure(
  lease: CollaborationInviteSessionLease,
  rawInput: CollaborationInviteCreateInput,
): OutboundActionDisclosure {
  const input = CollaborationInviteCreateInputSchema.parse(rawInput);
  return {
    action: 'collaboration-invite-create',
    title: 'Create collaboration invite?',
    summary: `Forgeboard will create a ${input.role} invite for room ${JSON.stringify(lease.binding.roomId)}.`,
    confirmLabel: 'Create invite',
    destination: destination(lease.binding.managementBaseUrl, lease.binding.roomId),
    details: [
      { label: 'Role', value: input.role },
      { label: 'Lifetime', value: `${String(input.expiresInSeconds)} seconds` },
      { label: 'Maximum uses', value: String(input.maxUses) },
    ],
    warning:
      'The generated invite is a credential. Forgeboard retains its link only in volatile memory for this connected owner session.',
  };
}

export function inviteRedeemDisclosure(
  rawInput: CollaborationJoinInviteInput,
): OutboundActionDisclosure {
  const input = CollaborationJoinInviteInputSchema.parse(rawInput);
  return {
    action: 'collaboration-invite-redeem',
    title: 'Redeem invite and join collaboration?',
    summary: `Forgeboard will redeem the selected invite for ${JSON.stringify(input.displayName)} and join its authorized room.`,
    confirmLabel: 'Redeem and join',
    destination: destination(input.managementBaseUrl, 'invite redemption'),
    details: [
      {
        label: 'Display identity',
        value: `${input.displayName} (${input.subject})`,
      },
      { label: 'WebSocket server', value: input.serverUrl },
      { label: 'Invite fingerprint', value: sha256(input.inviteLink) },
      { label: 'Reconnect', value: input.reconnect ? 'Enabled' : 'Disabled' },
    ],
    warning:
      'The invite and returned access credential remain in volatile main-process memory. Forgeboard sends only allowlisted collaboration metadata after joining.',
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function inviteRevokeDisclosure(
  lease: CollaborationInviteSessionLease,
  rawInviteId: string,
): OutboundActionDisclosure {
  const inviteId = CollaborationInviteIdSchema.parse(rawInviteId);
  return {
    action: 'collaboration-invite-revoke',
    title: 'Revoke collaboration invite?',
    summary: `Forgeboard will revoke the selected invite for room ${JSON.stringify(lease.binding.roomId)}.`,
    confirmLabel: 'Revoke invite',
    destination: destination(lease.binding.managementBaseUrl, lease.binding.roomId),
    details: [{ label: 'Invite ID', value: inviteId }],
    warning:
      'Revocation prevents future redemption. It does not disconnect members who already redeemed the invite.',
  };
}

function destination(endpoint: string, resource: string) {
  return {
    kind: 'collaboration-server' as const,
    endpoint,
    resource,
    transport: endpoint.startsWith('https:') ? 'HTTPS' : 'HTTP loopback',
  };
}
