import { describe, expect, it, vi } from 'vitest';

import { COLLABORATION_IPC_CHANNELS } from '../../shared/collaboration/index.js';
import { createCollaborationApi } from './bridge.js';

const INVITE_ID = '95c8589e-b738-4506-9ea9-7578f062f294';
const INVITE_LINK = 'forgeboard://collaboration/invite#token=one-time-invite-token';

const safeInvite = {
  id: INVITE_ID,
  roomId: 'room-1',
  role: 'reviewer' as const,
  expiresAt: '2026-07-18T12:00:00.000Z',
  maxUses: 1,
};

const connected = {
  connectionId: 'd9a16a79-a358-4f2d-8987-f6687291f33f',
  serverUrl: 'wss://collab.example/ws',
  managementBaseUrl: 'https://collab.example/control/',
  roomId: 'room-1',
  subject: 'member-1',
  displayName: 'Member One',
  color: '#6d5efc',
  role: 'reviewer' as const,
  status: 'connected' as const,
  reconnect: true,
  reconnectAttempt: 0,
  connectedAt: '2026-07-17T12:00:00.000Z',
  lastTransitionAt: '2026-07-17T12:00:00.000Z',
};

const ownerSession = {
  connection: {
    ...connected,
    subject: 'owner-1',
    displayName: 'Owner One',
    role: 'owner' as const,
  },
  expiresAt: '2026-07-18T20:00:00.000Z',
  tokenVersion: 2,
};

function bridge(invoke = vi.fn()) {
  const on = vi.fn();
  const remove = vi.fn();
  return { api: createCollaborationApi(invoke, on, remove), invoke, on, remove };
}

describe('createCollaborationApi invite bridge', () => {
  it('forwards strict management inputs and accepts only token-free projections', async () => {
    const member = {
      subject: 'member-2',
      displayName: 'Member Two',
      role: 'viewer' as const,
      tokenVersion: 3,
    };
    const invoke = vi.fn((channel: string) => {
      switch (channel) {
        case COLLABORATION_IPC_CHANNELS.bootstrapRoomAndJoin:
        case COLLABORATION_IPC_CHANNELS.recoverOwnerAndJoin:
        case COLLABORATION_IPC_CHANNELS.refreshOwnerSession:
          return Promise.resolve({ ok: true, value: ownerSession });
        case COLLABORATION_IPC_CHANNELS.listRoomMembers:
          return Promise.resolve({
            ok: true,
            value: { members: [member], nextCursor: null, hasMore: false },
          });
        case COLLABORATION_IPC_CHANNELS.updateRoomMember:
          return Promise.resolve({ ok: true, value: { membership: member, changed: true } });
        case COLLABORATION_IPC_CHANNELS.listRoomAudit:
          return Promise.resolve({
            ok: true,
            value: { events: [], nextAfter: null, hasMore: false },
          });
        default:
          return Promise.resolve({ ok: true, value: true });
      }
    });
    const { api } = bridge(invoke);
    const accessInput = {
      serverUrl: 'wss://collab.example/ws',
      managementBaseUrl: 'https://collab.example/control',
      roomId: 'room-1',
      subject: 'member-1',
      displayName: 'Member One',
      color: '#6d5efc',
      adminToken: 'volatile-admin-token',
      reconnect: true,
    };

    await expect(api.bootstrapRoomAndJoin(accessInput)).resolves.toEqual({
      ok: true,
      value: ownerSession,
    });
    await expect(api.recoverOwnerAndJoin(accessInput)).resolves.toEqual({
      ok: true,
      value: ownerSession,
    });
    await expect(api.refreshOwnerSession()).resolves.toEqual({ ok: true, value: ownerSession });
    await api.listRoomMembers({ limit: 100 });
    await api.updateRoomMember({
      subject: member.subject,
      role: 'viewer',
      expectedTokenVersion: 3,
    });
    await api.revokeRoomMember({ subject: member.subject, expectedTokenVersion: 3 });
    await api.listRoomAudit({ after: 0, limit: 100 });

    expect(invoke.mock.calls).toContainEqual([
      COLLABORATION_IPC_CHANNELS.bootstrapRoomAndJoin,
      { ...accessInput, managementBaseUrl: 'https://collab.example/control/' },
    ]);
    expect(invoke.mock.calls).toContainEqual([
      COLLABORATION_IPC_CHANNELS.revokeRoomMember,
      { subject: member.subject, expectedTokenVersion: 3 },
    ]);
  });

  it('rejects token-bearing management results and extra mutation inputs', async () => {
    const { api, invoke } = bridge(
      vi.fn().mockResolvedValue({
        ok: true,
        value: { ...ownerSession, accessToken: 'must-not-return' },
      }),
    );
    await expect(api.refreshOwnerSession()).rejects.toBeTruthy();
    await expect(
      api.updateRoomMember({
        subject: 'member-2',
        role: 'viewer',
        expectedTokenVersion: 3,
        accessToken: 'must-not-cross',
      } as never),
    ).rejects.toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('forwards only strict invite requests and token-free result schemas', async () => {
    const invoke = vi.fn((channel: string) => {
      switch (channel) {
        case COLLABORATION_IPC_CHANNELS.joinInvite:
          return Promise.resolve({ ok: true, connection: connected });
        case COLLABORATION_IPC_CHANNELS.listSessionInvites:
          return Promise.resolve({ ok: true, value: [safeInvite] });
        case COLLABORATION_IPC_CHANNELS.createInvite:
          return Promise.resolve({ ok: true, value: safeInvite });
        default:
          return Promise.resolve({ ok: true, value: true });
      }
    });
    const { api } = bridge(invoke);
    await expect(
      api.joinInvite({
        serverUrl: 'wss://collab.example/ws',
        managementBaseUrl: 'https://collab.example/control',
        inviteLink: INVITE_LINK,
        subject: 'member-1',
        displayName: 'Member One',
        color: '#6d5efc',
        reconnect: true,
      }),
    ).resolves.toEqual({ ok: true, connection: connected });
    await expect(api.listSessionInvites()).resolves.toEqual({ ok: true, value: [safeInvite] });
    await expect(
      api.createInvite({ role: 'reviewer', expiresInSeconds: 900, maxUses: 1 }),
    ).resolves.toEqual({ ok: true, value: safeInvite });
    await expect(api.copyInviteLink({ inviteId: INVITE_ID })).resolves.toEqual({
      ok: true,
      value: true,
    });
    await expect(api.revokeInvite({ inviteId: INVITE_ID })).resolves.toEqual({
      ok: true,
      value: true,
    });

    expect(invoke.mock.calls).toEqual([
      [
        COLLABORATION_IPC_CHANNELS.joinInvite,
        {
          serverUrl: 'wss://collab.example/ws',
          managementBaseUrl: 'https://collab.example/control/',
          inviteLink: INVITE_LINK,
          subject: 'member-1',
          displayName: 'Member One',
          color: '#6d5efc',
          reconnect: true,
        },
      ],
      [COLLABORATION_IPC_CHANNELS.listSessionInvites],
      [
        COLLABORATION_IPC_CHANNELS.createInvite,
        { role: 'reviewer', expiresInSeconds: 900, maxUses: 1 },
      ],
      [COLLABORATION_IPC_CHANNELS.copyInviteLink, { inviteId: INVITE_ID }],
      [COLLABORATION_IPC_CHANNELS.revokeInvite, { inviteId: INVITE_ID }],
    ]);
  });

  it('keeps direct access-token joins compatible while accepting an optional management base', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, connection: connected });
    const { api } = bridge(invoke);
    await api.join({
      serverUrl: 'wss://collab.example/ws',
      managementBaseUrl: 'https://collab.example/control',
      roomId: 'room-1',
      subject: 'member-1',
      displayName: 'Member One',
      color: '#6d5efc',
      accessToken: 'legacy-direct-access-token',
      reconnect: true,
    });
    expect(invoke).toHaveBeenCalledWith(COLLABORATION_IPC_CHANNELS.join, {
      serverUrl: 'wss://collab.example/ws',
      managementBaseUrl: 'https://collab.example/control/',
      roomId: 'room-1',
      subject: 'member-1',
      displayName: 'Member One',
      color: '#6d5efc',
      accessToken: 'legacy-direct-access-token',
      reconnect: true,
    });

    invoke.mockClear();
    await api.join({
      serverUrl: 'wss://collab.example/ws',
      roomId: 'room-1',
      subject: 'member-1',
      displayName: 'Member One',
      color: '#6d5efc',
      accessToken: 'legacy-direct-access-token',
      reconnect: true,
    });
    expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty('managementBaseUrl');
  });

  it('rejects hidden tokens, raw links, malformed IDs, and extra input before IPC', async () => {
    const { api, invoke } = bridge();
    await expect(
      api.createInvite({
        role: 'viewer',
        expiresInSeconds: 300,
        maxUses: 1,
        accessToken: 'must-not-cross',
      } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.copyInviteLink({ inviteId: INVITE_ID, inviteLink: INVITE_LINK } as never),
    ).rejects.toBeTruthy();
    await expect(api.revokeInvite({ inviteId: '../secret' })).rejects.toBeTruthy();
    await expect(
      api.joinInvite({
        serverUrl: 'wss://collab.example/ws',
        managementBaseUrl: 'https://collab.example/control',
        inviteLink: INVITE_LINK,
        subject: 'member-1',
        displayName: 'Member One',
        color: '#6d5efc',
        reconnect: true,
        accessToken: 'must-not-cross',
      } as never),
    ).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects any renderer-facing invite response containing a token or link', async () => {
    for (const channel of [
      COLLABORATION_IPC_CHANNELS.listSessionInvites,
      COLLABORATION_IPC_CHANNELS.createInvite,
    ]) {
      const value = { ...safeInvite, token: 'must-not-return', url: INVITE_LINK };
      const result = channel === COLLABORATION_IPC_CHANNELS.listSessionInvites ? [value] : value;
      const { api } = bridge(vi.fn().mockResolvedValue({ ok: true, value: result }));
      const operation =
        channel === COLLABORATION_IPC_CHANNELS.listSessionInvites
          ? api.listSessionInvites()
          : api.createInvite({ role: 'reviewer', expiresInSeconds: 900, maxUses: 1 });
      await expect(operation).rejects.toBeTruthy();
    }
  });

  it('filters invalid events and unregisters the exact handler', () => {
    const { api, on, remove } = bridge();
    const listener = vi.fn();
    const unsubscribe = api.onEvent(listener);
    const handler = on.mock.calls[0]?.[1] as (_event: unknown, payload: unknown) => void;
    handler({}, { type: 'credential', accessToken: 'must-not-return' });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    expect(remove).toHaveBeenCalledWith(COLLABORATION_IPC_CHANNELS.event, handler);
  });
});
