import { describe, expect, it } from 'vitest';

import type {
  CollaborationInvite,
  CollaborationInviteSessionBinding,
} from '../../../shared/collaboration/index.js';
import { CollaborationInviteSessionAuthority } from './session.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');

function binding(
  overrides: Partial<CollaborationInviteSessionBinding> = {},
): CollaborationInviteSessionBinding {
  return {
    serverUrl: 'wss://collab.example/ws',
    managementBaseUrl: 'https://collab.example/control/',
    roomId: 'room-1',
    subject: 'owner-1',
    role: 'owner',
    accessToken: 'private-access-token',
    expiresAt: '2026-07-18T12:00:00.000Z',
    ...overrides,
  };
}

function invite(overrides: Partial<CollaborationInvite> = {}): CollaborationInvite {
  return {
    id: '95c8589e-b738-4506-9ea9-7578f062f294',
    roomId: 'room-1',
    role: 'editor',
    expiresAt: '2026-07-18T12:00:00.000Z',
    maxUses: 1,
    token: 'invite-token',
    url: 'forgeboard://collaboration/invite#token=invite-token',
    ...overrides,
  };
}

describe('CollaborationInviteSessionAuthority', () => {
  it('binds a manual join to its exact server, room, subject, role, and credential', () => {
    const authority = new CollaborationInviteSessionAuthority(() => NOW);
    authority.establish(binding());
    const lease = authority.ownerLease(
      'wss://collab.example/ws',
      'https://collab.example/control',
      'room-1',
    );
    expect(lease.binding).toEqual(binding());
    expect(lease.binding).not.toBe(binding());
    expect(() =>
      authority.ownerLease('wss://other.example/ws', 'https://collab.example/control', 'room-1'),
    ).toThrow('does not match');
    expect(() =>
      authority.ownerLease('wss://collab.example/ws', 'https://collab.example/control', 'room-2'),
    ).toThrow('does not match');
    expect(() =>
      authority.ownerLease('wss://collab.example/ws', 'https://other.example/control', 'room-1'),
    ).toThrow('does not match');
  });

  it('binds an invite redemption response without decoding or transforming its access token', () => {
    const authority = new CollaborationInviteSessionAuthority(() => NOW);
    const established = authority.establishRedeemed(
      'wss://collab.example/ws',
      'https://collab.example/control',
      {
        room: { id: 'room-1' },
        membership: {
          subject: 'member-1',
          displayName: 'Member',
          role: 'reviewer',
        },
        accessToken: 'opaque.redeemed.access',
        expiresAt: '2026-07-18T12:00:00.000Z',
      },
    );
    expect(established).toEqual(
      binding({
        subject: 'member-1',
        role: 'reviewer',
        accessToken: 'opaque.redeemed.access',
      }),
    );
    expect(() =>
      authority.ownerLease('wss://collab.example/ws', 'https://collab.example/control', 'room-1'),
    ).toThrow('Only the connected room owner');
  });

  it('rejects absent, expired, non-owner, and mismatched room authority without token disclosure', () => {
    const authority = new CollaborationInviteSessionAuthority(() => NOW);
    expect(() =>
      authority.ownerLease('wss://collab.example/ws', 'https://collab.example/control', 'room-1'),
    ).toThrow('No collaboration room session');
    expect(() => authority.establish(binding({ expiresAt: NOW.toISOString() }))).toThrow('expired');
    authority.establish(binding({ role: 'editor', accessToken: 'must-not-appear' }));
    let message = '';
    try {
      authority.ownerLease('wss://collab.example/ws', 'https://collab.example/control', 'room-1');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Only the connected room owner');
    expect(message).not.toContain('must-not-appear');
  });

  it('tracks only exact invites created by the current owner session', () => {
    const authority = new CollaborationInviteSessionAuthority(() => NOW);
    authority.establish(binding());
    const lease = authority.ownerLease(
      'wss://collab.example/ws',
      'https://collab.example/control',
      'room-1',
    );
    authority.recordCreatedInvite(lease, invite());
    expect(authority.createdInviteCount).toBe(1);
    expect(authority.createdInviteViews(lease)).toEqual([
      {
        id: invite().id,
        roomId: 'room-1',
        role: 'editor',
        expiresAt: '2026-07-18T12:00:00.000Z',
        maxUses: 1,
      },
    ]);
    expect(JSON.stringify(authority.createdInviteViews(lease))).not.toContain('invite-token');
    expect(authority.inviteLinkForCopy(lease, invite().id)).toBe(invite().url);
    expect(authority.authorizeRevoke(lease, invite().id)).toEqual(binding());
    expect(() => authority.authorizeRevoke(lease, 'b2e65f4c-52b0-4645-a907-1aab06b1b933')).toThrow(
      'not created',
    );
    expect(() =>
      authority.recordCreatedInvite(
        lease,
        invite({
          roomId: 'other-room',
          id: 'b2e65f4c-52b0-4645-a907-1aab06b1b933',
        }),
      ),
    ).toThrow('does not match');
    authority.recordRevokedInvite(lease, invite().id);
    expect(authority.createdInviteCount).toBe(0);
  });

  it('invalidates stale leases and clears credentials and invite IDs on every lifecycle boundary', () => {
    for (const clear of ['clearForLeave', 'clearForReset', 'dispose'] as const) {
      const authority = new CollaborationInviteSessionAuthority(() => NOW);
      authority.establish(binding());
      const lease = authority.ownerLease(
        'wss://collab.example/ws',
        'https://collab.example/control',
        'room-1',
      );
      authority.recordCreatedInvite(lease, invite());
      authority[clear]();
      expect(authority.createdInviteCount).toBe(0);
      expect(() => authority.assertCurrent(lease)).toThrow('No collaboration room session');
      authority.establish(binding({ accessToken: `replacement-${clear}` }));
      expect(() => authority.assertCurrent(lease)).toThrow('session changed');
    }
  });

  it('invalidates a pending operation when the session changes', () => {
    const authority = new CollaborationInviteSessionAuthority(() => NOW);
    authority.establish(binding());
    const lease = authority.ownerLease(
      'wss://collab.example/ws',
      'https://collab.example/control',
      'room-1',
    );
    authority.establish(binding({ accessToken: 'replacement-token' }));
    expect(() => authority.recordCreatedInvite(lease, invite())).toThrow('session changed');
  });
});
