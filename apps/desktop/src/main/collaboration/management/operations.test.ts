import { describe, expect, it, vi } from 'vitest';

import type {
  CollaborationConnection,
  CollaborationJoinInput,
} from '../../../shared/collaboration/index.js';
import { OutboundActionGate } from '../../outbound/outbound-action-gate.js';
import { CollaborationInviteSessionAuthority } from '../invites/session.js';
import { CollaborationManagementOperations } from './operations.js';

const ADMIN_TOKEN = 'private-administrator-token';
const ACCESS_TOKEN = 'private-owner-access-token';
const RENEWED_TOKEN = ownerAccessToken();
const FIRST_ID = '95c8589e-b738-4506-9ea9-7578f062f294';

function ownerResponse(accessToken = ACCESS_TOKEN, tokenVersion = 0) {
  return {
    room: { id: 'room-1' },
    membership: {
      subject: 'owner-1',
      displayName: 'Owner',
      role: 'owner' as const,
      tokenVersion,
    },
    accessToken,
    expiresAt: '2099-12-31T23:59:59.000Z',
  };
}

function ownerConnection(): CollaborationConnection {
  return {
    connectionId: '00000000-0000-4000-8000-000000000010',
    serverUrl: 'wss://collab.example/socket',
    managementBaseUrl: 'https://collab.example/control/',
    roomId: 'room-1',
    subject: 'owner-1',
    displayName: 'Owner',
    color: '#6d5efc',
    role: 'owner',
    status: 'connected',
    reconnect: true,
    reconnectAttempt: 0,
    connectedAt: '2099-01-01T00:00:00.000Z',
    lastTransitionAt: '2099-01-01T00:00:00.000Z',
  };
}

function bootstrapInput() {
  return {
    serverUrl: 'wss://collab.example/socket',
    managementBaseUrl: 'https://collab.example/control/',
    roomId: 'room-1',
    subject: 'owner-1',
    displayName: 'Owner',
    color: '#6d5efc',
    adminToken: ADMIN_TOKEN,
    reconnect: true,
  };
}

function nativeAuthority(assertCurrent = vi.fn()) {
  return { ownerId: 'web-contents:1:test', parent: {} as never, assertCurrent };
}

function approvedDialog() {
  return { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) };
}

function httpMock() {
  return {
    bootstrapRoom: vi.fn().mockResolvedValue(ownerResponse()),
    recoverOwner: vi.fn().mockResolvedValue(ownerResponse()),
    refreshOwner: vi.fn().mockResolvedValue(ownerResponse(RENEWED_TOKEN, 0)),
    listMembers: vi.fn().mockResolvedValue({ members: [], nextCursor: null, hasMore: false }),
    updateMember: vi.fn().mockResolvedValue({
      membership: {
        subject: 'member-1',
        displayName: 'Member',
        role: 'reviewer',
        tokenVersion: 2,
      },
      changed: true,
    }),
    revokeMember: vi.fn().mockResolvedValue(undefined),
    listAudit: vi.fn().mockResolvedValue({ events: [], nextAfter: null, hasMore: false }),
  };
}

function establishedSession() {
  const session = new CollaborationInviteSessionAuthority(() => new Date('2026-07-18'));
  session.establishOwnerAccess(
    ownerConnection().serverUrl,
    ownerConnection().managementBaseUrl!,
    ownerResponse(),
  );
  return session;
}

describe('CollaborationManagementOperations', () => {
  it('reuses the exact bootstrap response and idempotency key after a join failure', async () => {
    const http = httpMock();
    const dialog = approvedDialog();
    const audit = { appendAudit: vi.fn() };
    const operations = new CollaborationManagementOperations(
      dialog,
      new OutboundActionGate(audit),
      { http, createId: () => FIRST_ID },
    );
    const failedJoin = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'network-failed',
        message: 'Connection failed.',
        retryable: true,
      },
    });

    const joinError = await operations
      .bootstrapAndJoin(nativeAuthority(), bootstrapInput(), failedJoin)
      .catch((error: unknown) => error);
    expect(joinError).toBeInstanceOf(Error);
    expect(String(joinError)).toContain('Connection failed.');
    expect(String(joinError)).not.toContain(ADMIN_TOKEN);
    const successfulJoin = vi.fn((input: CollaborationJoinInput) => {
      void input;
      return Promise.resolve({
        ok: true as const,
        connection: ownerConnection(),
      });
    });
    const result = await operations.bootstrapAndJoin(
      nativeAuthority(),
      bootstrapInput(),
      successfulJoin,
    );

    expect(http.bootstrapRoom).toHaveBeenCalledOnce();
    expect(http.bootstrapRoom.mock.calls[0]?.[2]).toBe(FIRST_ID);
    expect(failedJoin.mock.calls[0]?.[0]).toMatchObject({
      accessToken: ACCESS_TOKEN,
    });
    expect(successfulJoin.mock.calls[0]?.[0]).toMatchObject({
      accessToken: ACCESS_TOKEN,
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(dialog.showMessageBox.mock.calls)).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(audit.appendAudit.mock.calls)).not.toContain(ADMIN_TOKEN);
  });

  it('discloses recovery invalidation without disclosing administrator credentials', async () => {
    const http = httpMock();
    const dialog = approvedDialog();
    const operations = new CollaborationManagementOperations(
      dialog,
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http, createId: () => FIRST_ID },
    );

    await operations.recoverAndJoin(nativeAuthority(), bootstrapInput(), () =>
      Promise.resolve({ ok: true, connection: ownerConnection() }),
    );

    const rendered = JSON.stringify(dialog.showMessageBox.mock.calls);
    expect(rendered).toMatch(/invalidates earlier owner credentials/iu);
    expect(rendered).toContain('Administrator authorization: Provided');
    expect(rendered).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(http.recoverOwner.mock.results)).not.toContain(ADMIN_TOKEN);
  });

  it('renews the live credential and session together and rejects the stale lease afterward', async () => {
    const session = establishedSession();
    const staleLease = session.ownerLease(
      ownerConnection().serverUrl,
      ownerConnection().managementBaseUrl!,
      ownerConnection().roomId,
    );
    const http = httpMock();
    const replaceCredential = vi.fn();
    const operations = new CollaborationManagementOperations(
      approvedDialog(),
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http, session, createId: () => FIRST_ID },
    );

    const result = await operations.refresh(
      nativeAuthority(),
      ownerConnection(),
      replaceCredential,
    );

    expect(replaceCredential).toHaveBeenCalledExactlyOnceWith(RENEWED_TOKEN);
    expect(http.refreshOwner.mock.calls[0]?.[2]).toBe(FIRST_ID);
    const current = session.ownerLease(
      ownerConnection().serverUrl,
      ownerConnection().managementBaseUrl!,
      ownerConnection().roomId,
    );
    expect(current.binding.accessToken).toBe(RENEWED_TOKEN);
    expect(() => session.assertCurrent(staleLease)).toThrow(/session changed/iu);
    expect(JSON.stringify(result)).not.toContain(RENEWED_TOKEN);
  });

  it('does not replace the live credential when renewal identity validation fails', async () => {
    const session = establishedSession();
    const originalLease = session.ownerLease(
      ownerConnection().serverUrl,
      ownerConnection().managementBaseUrl!,
      ownerConnection().roomId,
    );
    const http = httpMock();
    http.refreshOwner.mockResolvedValue({
      ...ownerResponse(RENEWED_TOKEN),
      room: { id: 'other-room' },
    });
    const replaceCredential = vi.fn();
    const operations = new CollaborationManagementOperations(
      approvedDialog(),
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http, session, createId: () => FIRST_ID },
    );

    await expect(
      operations.refresh(nativeAuthority(), ownerConnection(), replaceCredential),
    ).rejects.toThrow(/does not match/iu);
    expect(replaceCredential).not.toHaveBeenCalled();
    expect(session.assertCurrent(originalLease).accessToken).toBe(ACCESS_TOKEN);
  });

  it('does not install a refreshed credential whose version or expiry contradicts its response', async () => {
    for (const accessToken of [
      ownerAccessToken({ ver: 1 }),
      ownerAccessToken({ exp: timestamp('2099-12-30T23:59:59.000Z') }),
    ]) {
      const session = establishedSession();
      const http = httpMock();
      http.refreshOwner.mockResolvedValue(ownerResponse(accessToken));
      const replaceCredential = vi.fn();
      const operations = new CollaborationManagementOperations(
        approvedDialog(),
        new OutboundActionGate({ appendAudit: vi.fn() }),
        { http, session, createId: () => FIRST_ID },
      );

      await expect(
        operations.refresh(nativeAuthority(), ownerConnection(), replaceCredential),
      ).rejects.toThrow(/does not match/iu);
      expect(replaceCredential).not.toHaveBeenCalled();
    }
  });

  it('rejects stale native authority and native denial before any HTTP request', async () => {
    const staleHttp = httpMock();
    const stale = vi.fn(() => {
      throw new Error('Window authority changed.');
    });
    const staleOperations = new CollaborationManagementOperations(
      approvedDialog(),
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http: staleHttp, createId: () => FIRST_ID },
    );
    await expect(
      staleOperations.bootstrapAndJoin(nativeAuthority(stale), bootstrapInput(), vi.fn()),
    ).rejects.toThrow('Window authority changed.');
    expect(staleHttp.bootstrapRoom).not.toHaveBeenCalled();

    const deniedHttp = httpMock();
    const deniedOperations = new CollaborationManagementOperations(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      {
        http: deniedHttp,
        session: establishedSession(),
        createId: () => FIRST_ID,
      },
    );
    await expect(
      deniedOperations.updateMember(nativeAuthority(), ownerConnection(), {
        subject: 'member-1',
        role: 'viewer',
        expectedTokenVersion: 1,
      }),
    ).resolves.toBeNull();
    await expect(
      deniedOperations.revokeMember(nativeAuthority(), ownerConnection(), {
        subject: 'member-1',
        expectedTokenVersion: 1,
      }),
    ).resolves.toBe(false);
    expect(deniedHttp.updateMember).not.toHaveBeenCalled();
    expect(deniedHttp.revokeMember).not.toHaveBeenCalled();
  });

  it('reuses update and revoke idempotency keys after transient failures', async () => {
    const ids = ['95c8589e-b738-4506-9ea9-7578f062f294', '498e3694-6349-467d-8977-f19a4bd136e4'];
    const http = httpMock();
    http.updateMember.mockRejectedValueOnce(new Error('Transient update failure.'));
    http.revokeMember.mockRejectedValueOnce(new Error('Transient revoke failure.'));
    const operations = new CollaborationManagementOperations(
      approvedDialog(),
      new OutboundActionGate({ appendAudit: vi.fn() }),
      {
        http,
        session: establishedSession(),
        createId: () => ids.shift() ?? FIRST_ID,
      },
    );
    const update = {
      subject: 'member-1',
      role: 'viewer' as const,
      expectedTokenVersion: 1,
    };
    await expect(
      operations.updateMember(nativeAuthority(), ownerConnection(), update),
    ).rejects.toThrow('Transient update failure.');
    await operations.updateMember(nativeAuthority(), ownerConnection(), update);
    expect(http.updateMember.mock.calls[0]?.[2]).toBe(http.updateMember.mock.calls[1]?.[2]);

    const revoke = { subject: 'member-1', expectedTokenVersion: 2 };
    await expect(
      operations.revokeMember(nativeAuthority(), ownerConnection(), revoke),
    ).rejects.toThrow('Transient revoke failure.');
    await operations.revokeMember(nativeAuthority(), ownerConnection(), revoke);
    expect(http.revokeMember.mock.calls[0]?.[2]).toBe(http.revokeMember.mock.calls[1]?.[2]);
    expect(http.updateMember.mock.calls[0]?.[2]).not.toBe(http.revokeMember.mock.calls[0]?.[2]);
  });

  it('does not reuse a mutation idempotency key across management room bindings', async () => {
    const ids = ['95c8589e-b738-4506-9ea9-7578f062f294', '498e3694-6349-467d-8977-f19a4bd136e4'];
    const http = httpMock();
    http.updateMember.mockRejectedValueOnce(new Error('Uncertain room-one result.'));
    const session = establishedSession();
    const operations = new CollaborationManagementOperations(
      approvedDialog(),
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http, session, createId: () => ids.shift() ?? FIRST_ID },
    );
    const update = {
      subject: 'member-1',
      role: 'viewer' as const,
      expectedTokenVersion: 1,
    };

    await expect(
      operations.updateMember(nativeAuthority(), ownerConnection(), update),
    ).rejects.toThrow('Uncertain room-one result.');
    const roomTwoConnection: CollaborationConnection = {
      ...ownerConnection(),
      connectionId: '00000000-0000-4000-8000-000000000011',
      managementBaseUrl: 'https://other-collab.example/control/',
      roomId: 'room-2',
    };
    session.establishOwnerAccess(
      roomTwoConnection.serverUrl,
      roomTwoConnection.managementBaseUrl!,
      {
        ...ownerResponse('room-two-owner-token'),
        room: { id: roomTwoConnection.roomId },
      },
    );
    await operations.updateMember(nativeAuthority(), roomTwoConnection, update);

    expect(http.updateMember.mock.calls[0]?.[2]).not.toBe(http.updateMember.mock.calls[1]?.[2]);
  });

  it('drops retained mutation idempotency keys at a session replacement boundary', async () => {
    const ids = ['95c8589e-b738-4506-9ea9-7578f062f294', '498e3694-6349-467d-8977-f19a4bd136e4'];
    const http = httpMock();
    http.revokeMember.mockRejectedValueOnce(new Error('Uncertain revocation result.'));
    const operations = new CollaborationManagementOperations(
      approvedDialog(),
      new OutboundActionGate({ appendAudit: vi.fn() }),
      {
        http,
        session: establishedSession(),
        createId: () => ids.shift() ?? FIRST_ID,
      },
    );
    const revoke = { subject: 'member-1', expectedTokenVersion: 2 };

    await expect(
      operations.revokeMember(nativeAuthority(), ownerConnection(), revoke),
    ).rejects.toThrow('Uncertain revocation result.');
    operations.clearPendingEffects();
    await operations.revokeMember(nativeAuthority(), ownerConnection(), revoke);

    expect(http.revokeMember.mock.calls[0]?.[2]).not.toBe(http.revokeMember.mock.calls[1]?.[2]);
  });

  it('passes exact pagination reads and returns only schema-validated pages', async () => {
    const http = httpMock();
    http.listMembers.mockResolvedValue({
      members: [
        {
          subject: 'member-1',
          displayName: 'Member',
          role: 'viewer',
          tokenVersion: 1,
        },
      ],
      nextCursor: 'bWVtYmVyLTE',
      hasMore: true,
    });
    const operations = new CollaborationManagementOperations(
      approvedDialog(),
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http, session: establishedSession(), createId: () => FIRST_ID },
    );

    await expect(
      operations.listMembers(nativeAuthority(), ownerConnection(), {
        after: 'YWZ0ZXI',
        limit: 25,
      }),
    ).resolves.toMatchObject({ hasMore: true, nextCursor: 'bWVtYmVyLTE' });
    await expect(
      operations.listAudit(nativeAuthority(), ownerConnection(), {
        after: 41,
        limit: 200,
      }),
    ).resolves.toEqual({ events: [], nextAfter: null, hasMore: false });
    expect(http.listMembers.mock.calls[0]?.[2]).toEqual({
      after: 'YWZ0ZXI',
      limit: 25,
    });
    expect(http.listAudit.mock.calls[0]?.[2]).toEqual({
      after: 41,
      limit: 200,
    });
  });
});

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
    iat: timestamp('2099-01-01T00:00:00.000Z'),
    exp: timestamp('2099-12-31T23:59:59.000Z'),
    ...overrides,
  };
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.TEST_SIGNATURE`;
}

function timestamp(value: string): number {
  return Math.floor(new Date(value).getTime() / 1_000);
}
