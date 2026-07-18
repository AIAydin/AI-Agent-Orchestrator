import { describe, expect, it } from 'vitest';

import {
  CollaborationInviteCreateInputSchema,
  CollaborationInviteHistoryPageSchema,
  CollaborationInviteHistoryViewSchema,
  CollaborationInviteLinkSchema,
  CollaborationManagementUrlSchema,
  CollaborationInviteRedeemResponseSchema,
  CollaborationInviteSessionBindingSchema,
  CollaborationInviteSchema,
  collaborationInviteTokenFromLink,
} from './contracts.js';

const TOKEN = 'signed.invite.token';
const LINK = `forgeboard://collaboration/invite#token=${TOKEN}`;

describe('collaboration invite contracts', () => {
  it('does not require an opaque direct access token to contain a decodable expiry', () => {
    expect(
      CollaborationInviteSessionBindingSchema.parse({
        serverUrl: 'wss://collab.example/socket',
        managementBaseUrl: 'https://collab.example/control/',
        roomId: 'room-1',
        subject: 'owner-1',
        role: 'owner',
        accessToken: 'opaque-access-token',
      }),
    ).not.toHaveProperty('expiresAt');
  });

  it('requires an explicit secure management base and preserves a reverse-proxy path', () => {
    expect(CollaborationManagementUrlSchema.parse('https://collab.example/control')).toBe(
      'https://collab.example/control/',
    );
    expect(CollaborationManagementUrlSchema.parse('http://127.0.0.1:1234')).toBe(
      'http://127.0.0.1:1234/',
    );
    for (const value of [
      'http://collab.example',
      'ws://127.0.0.1:1234',
      'https://user:secret@collab.example',
      'https://collab.example/control?token=x',
      'https://collab.example/control#token=x',
    ]) {
      expect(CollaborationManagementUrlSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('accepts the exact roles and server-supported create bounds', () => {
    for (const role of ['editor', 'reviewer', 'viewer']) {
      expect(
        CollaborationInviteCreateInputSchema.parse({
          role,
          expiresInSeconds: 300,
          maxUses: 1,
        }),
      ).toMatchObject({ role });
    }
    for (const invalid of [
      { role: 'owner', expiresInSeconds: 300, maxUses: 1 },
      { role: 'viewer', expiresInSeconds: 299, maxUses: 1 },
      { role: 'viewer', expiresInSeconds: 2_592_001, maxUses: 1 },
      { role: 'viewer', expiresInSeconds: 300, maxUses: 0 },
      { role: 'viewer', expiresInSeconds: 300, maxUses: 101 },
      { role: 'viewer', expiresInSeconds: 300, maxUses: 1, extra: true },
    ]) {
      expect(CollaborationInviteCreateInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('extracts one token from a credential-free fragment-only invite link', () => {
    expect(collaborationInviteTokenFromLink(LINK)).toBe(TOKEN);
    expect(collaborationInviteTokenFromLink(`https://collab.example/join#token=${TOKEN}`)).toBe(
      TOKEN,
    );
    expect(collaborationInviteTokenFromLink(`http://127.0.0.1/join#token=${TOKEN}`)).toBe(TOKEN);
  });

  it('rejects ambiguous, exposed, credentialed, and unsupported invite links', () => {
    const invalid = [
      'ftp://collab.example/invite#token=value',
      'https://user:secret@collab.example/invite#token=value',
      'https://collab.example/invite?token=value#token=value',
      'https://collab.example/invite',
      'https://collab.example/invite#token=',
      'https://collab.example/invite#token=one&token=two',
      'https://collab.example/invite#token=value&room=secret',
      `https://collab.example/invite#token=${'a'.repeat(8_193)}`,
    ];
    for (const value of invalid) {
      expect(CollaborationInviteLinkSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('returns validation failures rather than throwing for malformed invite-link input', () => {
    for (const value of ['', '%', '://', 'forgeboard://%', 'not a URL', '\0']) {
      expect(() => CollaborationInviteLinkSchema.safeParse(value), value).not.toThrow();
      expect(CollaborationInviteLinkSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('binds a created invite link to the exact returned token and room metadata', () => {
    const base = {
      id: '95c8589e-b738-4506-9ea9-7578f062f294',
      roomId: 'room-1',
      role: 'reviewer',
      expiresAt: '2026-07-18T12:00:00.000Z',
      maxUses: 2,
      token: TOKEN,
      url: LINK,
    };
    expect(CollaborationInviteSchema.parse(base)).toEqual(base);
    expect(
      CollaborationInviteSchema.safeParse({
        ...base,
        url: 'forgeboard://collaboration/invite#token=different',
      }).success,
    ).toBe(false);
  });

  it('accepts strict redemption, including a server-preserved existing owner membership', () => {
    const response = {
      room: { id: 'room-1' },
      membership: {
        subject: 'user-1',
        displayName: 'User One',
        role: 'editor',
      },
      accessToken: 'signed.access.token',
      expiresAt: '2026-07-18T12:00:00.000Z',
    };
    expect(CollaborationInviteRedeemResponseSchema.parse(response)).toEqual(response);
    expect(
      CollaborationInviteRedeemResponseSchema.parse({
        ...response,
        membership: { ...response.membership, role: 'owner' },
      }).membership.role,
    ).toBe('owner');
    expect(
      CollaborationInviteRedeemResponseSchema.safeParse({
        ...response,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('preserves core invite and pagination invariants at the desktop boundary', () => {
    const invite = {
      id: '95c8589e-b738-4506-9ea9-7578f062f294',
      roomId: 'room-1',
      role: 'reviewer' as const,
      createdAt: '2026-07-18T11:00:00.000Z',
      expiresAt: '2026-07-18T12:00:00.000Z',
      maxUses: 2,
      useCount: 0,
      revokedAt: null,
      status: 'active' as const,
      copyAvailable: true,
    };
    expect(CollaborationInviteHistoryViewSchema.parse(invite)).toEqual(invite);

    for (const hostile of [
      { ...invite, status: 'revoked' },
      { ...invite, revokedAt: invite.expiresAt },
      { ...invite, useCount: 3 },
      { ...invite, status: 'expired', copyAvailable: true },
      { ...invite, status: 'exhausted', useCount: 2, copyAvailable: true },
      { ...invite, status: 'invalidated', copyAvailable: true },
      { ...invite, token: 'must-not-cross' },
      { ...invite, url: 'forgeboard://collaboration/invite#token=secret' },
      { ...invite, signingAuthority: 'must-not-cross' },
    ]) {
      expect(CollaborationInviteHistoryViewSchema.safeParse(hostile).success).toBe(false);
    }

    const page = { invites: [invite], nextCursor: null, hasMore: false };
    expect(CollaborationInviteHistoryPageSchema.parse(page)).toEqual(page);
    for (const hostile of [
      { ...page, hasMore: true },
      { ...page, nextCursor: 'Y3Vyc29y' },
      { invites: [], nextCursor: 'Y3Vyc29y', hasMore: true },
    ]) {
      expect(CollaborationInviteHistoryPageSchema.safeParse(hostile).success).toBe(false);
    }
  });
});
