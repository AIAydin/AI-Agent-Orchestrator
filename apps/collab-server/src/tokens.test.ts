import { describe, expect, it } from 'vitest';

import { CollaborationTokenService, TokenValidationError } from './tokens.js';

const service = new CollaborationTokenService('test-signing-key-with-at-least-thirty-two-bytes');
const now = new Date('2026-07-14T12:00:00.000Z');

describe('signed collaboration tokens', () => {
  it('issues scoped, expiring access tokens', () => {
    const issued = service.createAccessToken(
      {
        roomId: 'room-1',
        subject: 'owner-1',
        role: 'owner',
        tokenVersion: 0,
        expiresInSeconds: 600,
      },
      now,
    );
    expect(
      service.verifyAccessToken(issued.token, new Date('2026-07-14T12:05:00.000Z')),
    ).toMatchObject({
      roomId: 'room-1',
      sub: 'owner-1',
      role: 'owner',
      ver: 0,
    });
    expect(() =>
      service.verifyAccessToken(issued.token, new Date('2026-07-14T12:11:00.000Z')),
    ).toThrow(TokenValidationError);
  });

  it('rejects tampering and does not accept invite tokens as access tokens', () => {
    const invite = service.createInviteToken(
      {
        roomId: 'room-1',
        role: 'editor',
        invitedBy: 'owner-1',
        maxUses: 1,
        expiresInSeconds: 600,
      },
      now,
    );
    expect(() => service.verifyAccessToken(invite.token, now)).toThrow();
    const [header, payload, signature] = invite.token.split('.');
    expect(header && payload && signature).toBeTruthy();
    const replacement = signature?.startsWith('A') ? 'B' : 'A';
    expect(() =>
      service.verifyInviteToken(
        `${header}.${payload}.${replacement}${signature?.slice(1) ?? ''}`,
        now,
      ),
    ).toThrow(TokenValidationError);
  });
});
