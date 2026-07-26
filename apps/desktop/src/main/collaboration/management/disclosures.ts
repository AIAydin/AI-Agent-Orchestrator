import type { OutboundActionDisclosure } from '../../outbound/outbound-action-gate.js';
import type { CollaborationInviteSessionLease } from '../invites/session.js';

interface EndpointTarget {
  readonly managementBaseUrl: string;
  readonly roomId: string;
}

export function roomBootstrapDisclosure(
  input: EndpointTarget & {
    readonly subject: string;
    readonly displayName: string;
    readonly serverUrl: string;
    readonly adminAuthorized: boolean;
  },
): OutboundActionDisclosure {
  return disclosure(
    'collaboration-room-bootstrap',
    'Create collaboration room?',
    `Artemis will create room ${JSON.stringify(input.roomId)} and connect as its owner.`,
    'Create and connect',
    input,
    [
      { label: 'Owner identity', value: `${input.displayName} (${input.subject})` },
      { label: 'WebSocket server', value: input.serverUrl },
      {
        label: 'Administrator authorization',
        value: input.adminAuthorized ? 'Provided' : 'Not provided',
      },
    ],
    'The returned owner credential stays only in volatile main-process memory.',
  );
}

export function ownerRecoverDisclosure(
  input: EndpointTarget & {
    readonly subject: string;
    readonly serverUrl: string;
    readonly adminAuthorized: boolean;
  },
): OutboundActionDisclosure {
  return disclosure(
    'collaboration-owner-recover',
    'Recover room ownership?',
    `Artemis will rotate the owner credential for room ${JSON.stringify(input.roomId)}.`,
    'Recover and connect',
    input,
    [
      { label: 'Owner ID', value: input.subject },
      { label: 'WebSocket server', value: input.serverUrl },
      {
        label: 'Administrator authorization',
        value: input.adminAuthorized ? 'Provided' : 'Not provided',
      },
    ],
    'Recovery invalidates earlier owner credentials. The replacement stays only in volatile main-process memory.',
  );
}

export function ownerRefreshDisclosure(lease: CollaborationInviteSessionLease) {
  return disclosure(
    'collaboration-owner-refresh',
    'Renew owner session?',
    `Artemis will request a fresh expiry for room ${JSON.stringify(lease.binding.roomId)}.`,
    'Renew session',
    target(lease),
    [{ label: 'Owner ID', value: lease.binding.subject }],
    'The renewed credential stays only in volatile main-process memory.',
  );
}

export function membersListDisclosure(lease: CollaborationInviteSessionLease, after?: string) {
  return disclosure(
    'collaboration-members-list',
    'Load collaboration members?',
    `Artemis will read a member page for room ${JSON.stringify(lease.binding.roomId)}.`,
    'Load members',
    target(lease),
    [{ label: 'Page cursor', value: after ?? 'First page' }],
    'Member identities, roles, and concurrency versions will be shown in this Artemis window.',
  );
}

export function memberUpdateDisclosure(
  lease: CollaborationInviteSessionLease,
  input: { readonly subject: string; readonly role: string; readonly expectedTokenVersion: number },
) {
  return disclosure(
    'collaboration-member-update',
    'Change collaboration member role?',
    `Artemis will change ${JSON.stringify(input.subject)} to ${input.role}.`,
    'Change role',
    target(lease),
    [
      { label: 'Member ID', value: input.subject },
      { label: 'Expected version', value: String(input.expectedTokenVersion) },
    ],
    'The server will reject this change if the member changed since it was loaded.',
  );
}

export function memberRevokeDisclosure(
  lease: CollaborationInviteSessionLease,
  input: { readonly subject: string; readonly expectedTokenVersion: number },
) {
  return disclosure(
    'collaboration-member-revoke',
    'Revoke collaboration member?',
    `Artemis will revoke access for ${JSON.stringify(input.subject)}.`,
    'Revoke member',
    target(lease),
    [
      { label: 'Member ID', value: input.subject },
      { label: 'Expected version', value: String(input.expectedTokenVersion) },
    ],
    'The server will reject this revocation if the member changed since it was loaded.',
  );
}

export function auditListDisclosure(lease: CollaborationInviteSessionLease, after: number) {
  return disclosure(
    'collaboration-audit-list',
    'Load collaboration audit history?',
    `Artemis will read audit events for room ${JSON.stringify(lease.binding.roomId)}.`,
    'Load audit history',
    target(lease),
    [{ label: 'After sequence', value: String(after) }],
    'Audit events can contain bounded room, actor, target, route, and outcome metadata.',
  );
}

function target(lease: CollaborationInviteSessionLease): EndpointTarget {
  return { managementBaseUrl: lease.binding.managementBaseUrl, roomId: lease.binding.roomId };
}

function disclosure(
  action: OutboundActionDisclosure['action'],
  title: string,
  summary: string,
  confirmLabel: string,
  input: EndpointTarget,
  details: OutboundActionDisclosure['details'],
  warning: string,
): OutboundActionDisclosure {
  return {
    action,
    title,
    summary,
    confirmLabel,
    destination: {
      kind: 'collaboration-server',
      endpoint: input.managementBaseUrl,
      resource: input.roomId,
      transport: input.managementBaseUrl.startsWith('https:') ? 'HTTPS' : 'HTTP loopback',
    },
    details,
    warning,
  };
}
