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

  it('establishes and renews exact owner access while preserving current invite records', () => {
    const authority = new CollaborationInviteSessionAuthority(() => NOW);
    const established = authority.establishOwnerAccess(
      'wss://collab.example/ws',
      'https://collab.example/control',
      ownerAccessResponse(),
    );
    expect(established).toEqual(binding({ accessToken: 'initial-owner-access' }));
    const lease = authority.ownerLease(
      'wss://collab.example/ws',
      'https://collab.example/control',
      'room-1',
    );
    authority.recordCreatedInvite(lease, invite());

    const renewedToken = ownerAccessToken({
      exp: timestamp('2026-07-19T12:00:00.000Z'),
    });
    const renewed = authority.renewOwnerAccess(lease, {
      ...ownerAccessResponse(),
      accessToken: renewedToken,
      expiresAt: '2026-07-19T12:00:00.000Z',
    });

    expect(renewed.accessToken).toBe(renewedToken);
    expect(renewed.expiresAt).toBe('2026-07-19T12:00:00.000Z');
    expect(authority.createdInviteCount).toBe(1);
    expect(() => authority.assertCurrent(lease)).toThrow('session changed');
    const current = authority.ownerLease(
      'wss://collab.example/ws',
      'https://collab.example/control',
      'room-1',
    );
    expect(authority.createdInviteViews(current)).toHaveLength(1);
  });

  it('rejects mismatched owner renewal without changing the current credential', () => {
    const authority = new CollaborationInviteSessionAuthority(() => NOW);
    authority.establishOwnerAccess(
      'wss://collab.example/ws',
      'https://collab.example/control',
      ownerAccessResponse(),
    );
    const lease = authority.ownerLease(
      'wss://collab.example/ws',
      'https://collab.example/control',
      'room-1',
    );
    expect(() =>
      authority.renewOwnerAccess(lease, {
        ...ownerAccessResponse(),
        room: { id: 'other-room' },
        accessToken: 'must-not-replace-current',
      }),
    ).toThrow('does not match');
    expect(authority.assertCurrent(lease).accessToken).toBe('initial-owner-access');
  });

  it('binds renewed credential claims, expiry, and token version to the response before renewal', () => {
    const authority = new CollaborationInviteSessionAuthority(() => NOW);
    authority.establishOwnerAccess(
      'wss://collab.example/ws',
      'https://collab.example/control',
      ownerAccessResponse(),
    );
    const lease = authority.ownerLease(
      'wss://collab.example/ws',
      'https://collab.example/control',
      'room-1',
    );
    const response = {
      ...ownerAccessResponse(),
      accessToken: ownerAccessToken(),
    };
    const mismatches = [
      { ...response, accessToken: ownerAccessToken({ roomId: 'other-room' }) },
      { ...response, accessToken: ownerAccessToken({ sub: 'other-owner' }) },
      { ...response, accessToken: ownerAccessToken({ role: 'editor' }) },
      { ...response, accessToken: ownerAccessToken({ ver: 1 }) },
      {
        ...response,
        accessToken: ownerAccessToken({
          exp: timestamp('2026-07-19T12:00:00.000Z'),
        }),
      },
      { ...response, accessToken: 'not-a-jwt' },
    ];

    for (const mismatch of mismatches) {
      expect(() => authority.assertOwnerAccessRenewal(lease, mismatch)).toThrow('does not match');
      expect(authority.assertCurrent(lease).accessToken).toBe('initial-owner-access');
    }
    expect(() => authority.assertOwnerAccessRenewal(lease, response)).not.toThrow();
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
      'Refresh invite history',
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

  it('authorizes listed historical revocation without recreating volatile copy authority', () => {
    const authority = new CollaborationInviteSessionAuthority(() => NOW);
    authority.establish(binding());
    const lease = authority.ownerLease(
      'wss://collab.example/ws',
      'https://collab.example/control',
      'room-1',
    );
    const historicalId = 'b2e65f4c-52b0-4645-a907-1aab06b1b933';
    const page = authority.recordListedPage(lease, {
      invites: [
        {
          id: historicalId,
          roomId: 'room-1',
          role: 'viewer',
          createdAt: '2026-07-18T10:00:00.000Z',
          expiresAt: '2026-07-18T12:00:00.000Z',
          maxUses: 2,
          useCount: 0,
          revokedAt: null,
          status: 'active',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });

    expect(page.invites[0]).toMatchObject({
      id: historicalId,
      copyAvailable: false,
    });
    expect(authority.authorizeRevoke(lease, historicalId)).toEqual(binding());
    expect(() => authority.inviteLinkForCopy(lease, historicalId)).toThrow('not created');
  });

  it('withholds current-session copy authority from every terminal server status', () => {
    const authority = new CollaborationInviteSessionAuthority(() => NOW);
    authority.establish(binding());
    const lease = authority.ownerLease(
      'wss://collab.example/ws',
      'https://collab.example/control',
      'room-1',
    );
    authority.recordCreatedInvite(lease, invite());

    const base = {
      id: invite().id,
      roomId: 'room-1',
      role: 'editor' as const,
      createdAt: '2026-07-17T10:00:00.000Z',
      expiresAt: invite().expiresAt,
      maxUses: 1,
      useCount: 0,
      revokedAt: null,
    };
    const cases = [
      { ...base, status: 'active' as const, expected: true },
      { ...base, status: 'expired' as const, expected: false },
      { ...base, status: 'exhausted' as const, useCount: 1, expected: false },
      {
        ...base,
        status: 'revoked' as const,
        revokedAt: '2026-07-17T11:00:00.000Z',
        expected: false,
      },
      { ...base, status: 'invalidated' as const, expected: false },
    ];

    for (const { expected, ...history } of cases) {
      const page = authority.recordListedPage(lease, {
        invites: [history],
        nextCursor: null,
        hasMore: false,
      });
      expect(page.invites[0]?.copyAvailable, history.status).toBe(expected);
      if (history.status === 'active') {
        expect(authority.authorizeRevoke(lease, history.id)).toEqual(binding());
      } else {
        expect(() => authority.authorizeRevoke(lease, history.id), history.status).toThrow(
          'Refresh invite history',
        );
      }
    }
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

function ownerAccessResponse() {
  return {
    room: { id: 'room-1' },
    membership: {
      subject: 'owner-1',
      displayName: 'Owner',
      role: 'owner' as const,
      tokenVersion: 0,
    },
    accessToken: 'initial-owner-access',
    expiresAt: '2026-07-18T12:00:00.000Z',
  };
}

function ownerAccessToken(overrides: Record<string, unknown> = {}): string {
  const payload = {
    iss: 'forgeboard-collab',
    aud: 'forgeboard-collab-client',
    typ: 'access',
    jti: '00000000-0000-4000-8000-000000000020',
    roomId: 'room-1',
    role: 'owner',
    sub: 'owner-1',
    ver: 0,
    iat: timestamp('2026-07-17T12:00:00.000Z'),
    exp: timestamp('2026-07-18T12:00:00.000Z'),
    ...overrides,
  };
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.TEST_SIGNATURE`;
}

function timestamp(value: string): number {
  return Math.floor(new Date(value).getTime() / 1_000);
}
