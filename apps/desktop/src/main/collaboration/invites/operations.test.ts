import { describe, expect, it, vi } from 'vitest';

import type {
  CollaborationConnection,
  CollaborationInvite,
  CollaborationJoinInput,
  CollaborationJoinInviteInput,
} from '../../../shared/collaboration/index.js';
import { OutboundActionGate } from '../../outbound/outbound-action-gate.js';
import { inviteRedeemDisclosure } from './disclosures.js';
import { CollaborationInviteOperations } from './operations.js';
import { CollaborationInviteSessionAuthority } from './session.js';

const INVITE_ID = '95c8589e-b738-4506-9ea9-7578f062f294';
const INVITE_TOKEN = 'signed.invite.token';
const INVITE_LINK = `forgeboard://collaboration/invite#token=${INVITE_TOKEN}`;
const ACCESS_TOKEN = jwt({ exp: 4_102_444_800 });

describe('CollaborationInviteOperations', () => {
  it('retains invite authority after a direct join with an opaque access token', () => {
    const operations = new CollaborationInviteOperations(
      { showMessageBox: vi.fn() },
      new OutboundActionGate({ appendAudit: vi.fn() }),
    );
    expect(() =>
      operations.establishDirect(
        { ...directJoinInput(), accessToken: 'opaque-access-token' },
        ownerConnection(),
      ),
    ).not.toThrow();
  });

  it('creates, lists, natively copies, and revokes only current owner-session invites', async () => {
    const invite = createdInvite();
    const http = {
      createInvite: vi.fn().mockResolvedValue(invite),
      redeemInvite: vi.fn(),
      revokeInvite: vi.fn().mockResolvedValue(revokedInvite()),
    };
    const clipboard = { writeText: vi.fn() };
    const dialog = {
      showMessageBox: vi
        .fn()
        .mockResolvedValueOnce({ response: 1 })
        .mockResolvedValueOnce({ response: 0 })
        .mockResolvedValueOnce({ response: 1 })
        .mockResolvedValueOnce({ response: 0 })
        .mockResolvedValueOnce({ response: 1 }),
    };
    const audit = { appendAudit: vi.fn() };
    const operations = new CollaborationInviteOperations(dialog, new OutboundActionGate(audit), {
      http,
      clipboard,
    });
    const connection = ownerConnection();
    operations.establishDirect(directJoinInput(), connection);
    const authority = nativeAuthority();

    await expect(
      operations.create(authority, connection, {
        role: 'reviewer',
        expiresInSeconds: 600,
        maxUses: 2,
      }),
    ).resolves.toEqual({
      id: INVITE_ID,
      roomId: 'room-1',
      role: 'reviewer',
      expiresAt: '2099-12-31T23:59:59.000Z',
      maxUses: 2,
    });
    expect(http.createInvite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accessToken: ACCESS_TOKEN, role: 'owner' }),
      { role: 'reviewer', expiresInSeconds: 600, maxUses: 2 },
    );

    await expect(operations.copy(authority, connection, INVITE_ID)).resolves.toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    await expect(operations.copy(authority, connection, INVITE_ID)).resolves.toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(INVITE_LINK);

    await expect(operations.revoke(authority, connection, INVITE_ID)).resolves.toBeNull();
    expect(http.revokeInvite).not.toHaveBeenCalled();
    await expect(operations.revoke(authority, connection, INVITE_ID)).resolves.toEqual({
      ...revokedInvite(),
      copyAvailable: false,
    });
    expect(http.revokeInvite).toHaveBeenCalledOnce();
    expect(JSON.stringify(dialog.showMessageBox.mock.calls)).not.toContain(INVITE_TOKEN);
    expect(JSON.stringify(audit.appendAudit.mock.calls)).not.toContain(INVITE_TOKEN);
  });

  it('loads token-free history and revokes a listed prior-session invite without copy authority', async () => {
    const page = {
      invites: [
        {
          id: INVITE_ID,
          roomId: 'room-1',
          role: 'viewer' as const,
          createdAt: '2099-01-01T00:00:00.000Z',
          expiresAt: '2099-12-31T23:59:59.000Z',
          maxUses: 2,
          useCount: 0,
          revokedAt: null,
          status: 'active' as const,
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
    const http = {
      createInvite: vi.fn(),
      listInvites: vi.fn().mockResolvedValue(page),
      redeemInvite: vi.fn(),
      revokeInvite: vi.fn().mockResolvedValue(revokedInvite()),
    };
    const operations = new CollaborationInviteOperations(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http, clipboard: { writeText: vi.fn() } },
    );
    const connection = ownerConnection();
    operations.establishDirect(directJoinInput(), connection);

    await expect(
      operations.listHistory(nativeAuthority(), connection, { limit: 50 }),
    ).resolves.toEqual({
      ...page,
      invites: [{ ...page.invites[0], copyAvailable: false }],
    });
    await expect(operations.copy(nativeAuthority(), connection, INVITE_ID)).rejects.toThrow(
      'not available',
    );
    await expect(operations.revoke(nativeAuthority(), connection, INVITE_ID)).resolves.toEqual({
      ...revokedInvite(),
      copyAvailable: false,
    });
    expect(http.revokeInvite).toHaveBeenCalledOnce();
  });

  it('binds redemption approval to the exact invite fingerprint before any HTTP request', async () => {
    const first = joinInviteInput(INVITE_LINK);
    const second = joinInviteInput('forgeboard://collaboration/invite#token=another.signed.invite');
    const gate = new OutboundActionGate({ appendAudit: vi.fn() });
    const plan = gate.prepare('owner-1', inviteRedeemDisclosure(first));
    const request = vi.fn();

    await expect(
      gate.confirmAndExecute({
        ownerId: 'owner-1',
        planId: plan.id,
        confirmation: { confirm: () => Promise.resolve('approved') },
        currentDisclosure: () => inviteRedeemDisclosure(second),
        execute: request,
      }),
    ).rejects.toThrow(/changed after approval/iu);
    expect(request).not.toHaveBeenCalled();
    expect(
      inviteRedeemDisclosure(first).details.find((detail) => detail.label === 'Invite fingerprint')
        ?.value,
    ).not.toBe(
      inviteRedeemDisclosure(second).details.find((detail) => detail.label === 'Invite fingerprint')
        ?.value,
    );
  });

  it('reuses one exact redeemed credential after a transient join failure', async () => {
    const http = {
      createInvite: vi.fn(),
      redeemInvite: vi.fn().mockResolvedValue({
        room: { id: 'room-1' },
        membership: {
          subject: 'member-1',
          displayName: 'Member',
          role: 'viewer',
        },
        accessToken: ACCESS_TOKEN,
        expiresAt: '2099-12-31T23:59:59.000Z',
      }),
      revokeInvite: vi.fn(),
    };
    const dialog = {
      showMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
    };
    const audit = { appendAudit: vi.fn() };
    const operations = new CollaborationInviteOperations(dialog, new OutboundActionGate(audit), {
      http,
    });
    const join = vi.fn((input: CollaborationJoinInput) =>
      Promise.resolve({
        ok: true as const,
        connection: viewerConnection(input),
      }),
    );

    const result = await operations.redeemAndJoin(
      nativeAuthority(),
      joinInviteInput(INVITE_LINK),
      join,
    );
    expect(join).toHaveBeenCalledWith(expect.objectContaining({ accessToken: ACCESS_TOKEN }));
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(INVITE_TOKEN);
    expect(JSON.stringify(dialog.showMessageBox.mock.calls)).not.toContain(INVITE_TOKEN);
    expect(JSON.stringify(audit.appendAudit.mock.calls)).not.toContain(INVITE_TOKEN);

    const failed = new CollaborationInviteOperations(
      dialog,
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http },
    );
    await expect(
      failed.redeemAndJoin(nativeAuthority(), joinInviteInput(INVITE_LINK), () =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'authentication-failed',
            message: 'Denied.',
            retryable: false,
          },
        }),
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      failed.redeemAndJoin(nativeAuthority(), joinInviteInput(INVITE_LINK), (input) =>
        Promise.resolve({ ok: true, connection: viewerConnection(input) }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(http.redeemInvite).toHaveBeenCalledTimes(2);
  });

  it('drops a pending redemption when the exact link or identity changes', async () => {
    const http = {
      createInvite: vi.fn(),
      redeemInvite: vi.fn().mockResolvedValue({
        room: { id: 'room-1' },
        membership: {
          subject: 'member-1',
          displayName: 'Member',
          role: 'viewer',
        },
        accessToken: ACCESS_TOKEN,
        expiresAt: '2099-12-31T23:59:59.000Z',
      }),
      revokeInvite: vi.fn(),
    };
    const operations = new CollaborationInviteOperations(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http },
    );
    const fail = () =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: 'network-failed' as const,
          message: 'Retry.',
          retryable: true,
        },
      });

    await operations.redeemAndJoin(nativeAuthority(), joinInviteInput(INVITE_LINK), fail);
    const changed = joinInviteInput('forgeboard://collaboration/invite#token=changed.token.value');
    await operations.redeemAndJoin(nativeAuthority(), changed, fail);
    await operations.redeemAndJoin(nativeAuthority(), joinInviteInput(INVITE_LINK), fail);

    expect(http.redeemInvite).toHaveBeenCalledTimes(3);
  });

  it('rejects the session invite cap before confirmation or HTTP', async () => {
    const session = new CollaborationInviteSessionAuthority(() => new Date('2026-07-17'));
    const http = {
      createInvite: vi.fn(),
      redeemInvite: vi.fn(),
      revokeInvite: vi.fn(),
    };
    const dialog = { showMessageBox: vi.fn() };
    const operations = new CollaborationInviteOperations(
      dialog,
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http, session },
    );
    operations.establishDirect(directJoinInput(), ownerConnection());
    const lease = session.ownerLease(
      ownerConnection().serverUrl,
      ownerConnection().managementBaseUrl!,
      ownerConnection().roomId,
    );
    for (let index = 0; index < 100; index += 1) {
      const suffix = String(index).padStart(12, '0');
      const token = `invite-${suffix}`;
      session.recordCreatedInvite(lease, {
        ...createdInvite(),
        id: `00000000-0000-4000-8000-${suffix}`,
        token,
        url: `forgeboard://collaboration/invite#token=${token}`,
      });
    }

    await expect(
      operations.create(nativeAuthority(), ownerConnection(), {
        role: 'viewer',
        expiresInSeconds: 600,
        maxUses: 1,
      }),
    ).rejects.toThrow(/management limit/iu);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(http.createInvite).not.toHaveBeenCalled();
  });

  it('compensates a completed create when native window authority is lost', async () => {
    let created = false;
    const http = {
      createInvite: vi.fn(() => {
        created = true;
        return Promise.resolve(createdInvite());
      }),
      redeemInvite: vi.fn(),
      revokeInvite: vi.fn().mockResolvedValue(revokedInvite()),
    };
    const operations = new CollaborationInviteOperations(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http },
    );
    operations.establishDirect(directJoinInput(), ownerConnection());
    const authority = {
      ...nativeAuthority(),
      assertCurrent: vi.fn(() => {
        if (created) throw new Error('The originating window closed.');
      }),
    };

    await expect(
      operations.create(authority, ownerConnection(), {
        role: 'viewer',
        expiresInSeconds: 600,
        maxUses: 1,
      }),
    ).rejects.toThrow(/window closed/iu);
    expect(http.createInvite).toHaveBeenCalledOnce();
    expect(http.revokeInvite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accessToken: ACCESS_TOKEN, roomId: 'room-1' }),
      INVITE_ID,
    );
  });

  it('revalidates the session after native copy approval before touching the clipboard', async () => {
    let clearOperations = (): void => undefined;
    let confirmations = 0;
    const clipboard = { writeText: vi.fn() };
    const dialog = {
      showMessageBox: vi.fn(() => {
        confirmations += 1;
        if (confirmations === 2) clearOperations();
        return Promise.resolve({ response: 1, checkboxChecked: false });
      }),
    };
    const http = {
      createInvite: vi.fn().mockResolvedValue(createdInvite()),
      redeemInvite: vi.fn(),
      revokeInvite: vi.fn(),
    };
    const operations = new CollaborationInviteOperations(
      dialog,
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { http, clipboard },
    );
    clearOperations = () => operations.clear();
    operations.establishDirect(directJoinInput(), ownerConnection());
    await operations.create(nativeAuthority(), ownerConnection(), {
      role: 'reviewer',
      expiresInSeconds: 600,
      maxUses: 2,
    });
    await expect(
      operations.copy(nativeAuthority(), ownerConnection(), INVITE_ID),
    ).rejects.toThrow();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});

function nativeAuthority() {
  return {
    ownerId: 'web-contents:1:test',
    parent: {} as never,
    assertCurrent: vi.fn(),
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

function viewerConnection(input: CollaborationJoinInput): CollaborationConnection {
  return {
    ...ownerConnection(),
    serverUrl: input.serverUrl,
    managementBaseUrl: input.managementBaseUrl,
    roomId: input.roomId,
    subject: input.subject,
    displayName: input.displayName,
    role: 'viewer',
  };
}

function directJoinInput(): CollaborationJoinInput {
  return {
    serverUrl: 'wss://collab.example/socket',
    managementBaseUrl: 'https://collab.example/control/',
    roomId: 'room-1',
    subject: 'owner-1',
    displayName: 'Owner',
    color: '#6d5efc',
    accessToken: ACCESS_TOKEN,
    reconnect: true,
  };
}

function joinInviteInput(inviteLink: string): CollaborationJoinInviteInput {
  return {
    serverUrl: 'wss://collab.example/socket',
    managementBaseUrl: 'https://collab.example/control/',
    inviteLink,
    subject: 'member-1',
    displayName: 'Member',
    color: '#6d5efc',
    reconnect: true,
  };
}

function createdInvite(): CollaborationInvite {
  return {
    id: INVITE_ID,
    roomId: 'room-1',
    role: 'reviewer',
    expiresAt: '2099-12-31T23:59:59.000Z',
    maxUses: 2,
    token: INVITE_TOKEN,
    url: INVITE_LINK,
  };
}

function revokedInvite() {
  return {
    id: INVITE_ID,
    roomId: 'room-1',
    role: 'reviewer' as const,
    createdAt: '2099-01-01T00:00:00.000Z',
    expiresAt: '2099-12-31T23:59:59.000Z',
    maxUses: 2,
    useCount: 0,
    revokedAt: '2099-01-02T00:00:00.000Z',
    status: 'revoked' as const,
  };
}

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}
