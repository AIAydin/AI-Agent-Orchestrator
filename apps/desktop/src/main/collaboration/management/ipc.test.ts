import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
        electron.handlers.set(channel, handler),
    ),
    removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
  },
}));

import {
  COLLABORATION_IPC_CHANNELS,
  type CollaborationConnection,
  type CollaborationJoinInput,
} from '../../../shared/collaboration/index.js';
import { OutboundActionGate } from '../../outbound/outbound-action-gate.js';
import { CollaborationIpcService } from '../ipc.js';
import { CollaborationManagementHttpError } from './http-client.js';
import type { CollaborationManagementOperations } from './operations.js';

const NOW = '2026-07-17T12:00:00.000Z';
const EXPIRES = '2026-07-17T20:00:00.000Z';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000401';

beforeEach(() => {
  electron.handlers.clear();
  electron.fromWebContents.mockReset();
});

describe('CollaborationIpcService room management boundary', () => {
  it('chains bootstrap through main-owned join and returns a strict token-free owner view', async () => {
    const client = fakeClient();
    const management = fakeManagement();
    management.bootstrapAndJoin.mockImplementation(async (_authority, _input, join) => {
      const joined = await join(joinInput('owner-access-secret'));
      if (!joined.ok) throw new Error(joined.error.message);
      return {
        connection: joined.connection,
        expiresAt: EXPIRES,
        tokenVersion: 0,
      };
    });
    serviceWith(client, management);
    const owner = renderer();
    electron.fromWebContents.mockReturnValue(owner.parent);
    const input = {
      serverUrl: 'wss://collaboration.example.test/team',
      managementBaseUrl: 'https://collaboration.example.test/control',
      roomId: 'room-1',
      subject: 'owner-1',
      displayName: 'Owner One',
      color: '#6d5efc',
      adminToken: 'ADMIN_SECRET_MUST_NOT_RETURN',
      reconnect: true,
    };

    const result = await invoke('bootstrapRoomAndJoin', owner.event, input);

    expect(result).toMatchObject({
      ok: true,
      value: {
        connection: { role: 'owner', status: 'connected' },
        tokenVersion: 0,
      },
    });
    const call = management.bootstrapAndJoin.mock.calls[0];
    expect(typeof call?.[0].ownerId).toBe('string');
    expect(call?.[1].adminToken).toBe(input.adminToken);
    expect(typeof call?.[2]).toBe('function');
    expect(JSON.stringify(result)).not.toContain(input.adminToken);
    expect(JSON.stringify(result)).not.toContain('owner-access-secret');
  });

  it('owner-gates member and audit reads and preserves safe server conflict codes', async () => {
    const client = fakeClient();
    const management = fakeManagement();
    management.listMembers.mockResolvedValue({
      members: [
        {
          subject: 'owner-1',
          displayName: 'Owner One',
          role: 'owner',
          tokenVersion: 0,
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    management.updateMember.mockRejectedValue(
      new CollaborationManagementHttpError(
        'request-rejected',
        'The collaboration data changed. Refresh it before trying again.',
        409,
        'membership_conflict',
      ),
    );
    management.listAudit.mockResolvedValue({
      events: [],
      nextAfter: null,
      hasMore: false,
    });
    serviceWith(client, management);
    const owner = renderer();
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('owner-token'));
    expect(management.clearPendingEffects).toHaveBeenCalledOnce();

    await expect(invoke('listRoomMembers', owner.event, { limit: 100 })).resolves.toMatchObject({
      ok: true,
      value: { members: [{ subject: 'owner-1' }] },
    });
    await expect(
      invoke('updateRoomMember', owner.event, {
        subject: 'viewer-1',
        role: 'reviewer',
        expectedTokenVersion: 2,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'membership_conflict',
        message: 'The collaboration data changed. Refresh it before trying again.',
      },
    });
    await expect(
      invoke('listRoomAudit', owner.event, { after: 0, limit: 100 }),
    ).resolves.toMatchObject({
      ok: true,
      value: { events: [], hasMore: false },
    });
  });

  it('renews only in volatile client/session state and clears management authority on leave', async () => {
    const client = fakeClient();
    const management = fakeManagement();
    management.refresh.mockImplementation((_authority, connection, replaceCredential) => {
      replaceCredential('RENEWED_ACCESS_SECRET');
      return Promise.resolve({
        connection,
        expiresAt: EXPIRES,
        tokenVersion: 0,
      });
    });
    serviceWith(client, management);
    const owner = renderer();
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('owner-token'));

    const renewed = await invoke('refreshOwnerSession', owner.event);
    expect(client.replaceAccessToken).toHaveBeenCalledWith('RENEWED_ACCESS_SECRET');
    expect(JSON.stringify(renewed)).not.toContain('RENEWED_ACCESS_SECRET');

    await invoke('leave', owner.event);
    expect(management.clear).toHaveBeenCalled();
    await expect(invoke('listRoomMembers', owner.event, { limit: 100 })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('clears retained owner-access retry authority when its window is destroyed', async () => {
    const client = fakeClient();
    const management = fakeManagement();
    management.bootstrapAndJoin.mockRejectedValue(new Error('join failed after room creation'));
    serviceWith(client, management);
    const owner = renderer();
    electron.fromWebContents.mockReturnValue(owner.parent);

    await expect(
      invoke('bootstrapRoomAndJoin', owner.event, {
        serverUrl: 'wss://collaboration.example.test/team',
        managementBaseUrl: 'https://collaboration.example.test/control/',
        roomId: 'room-1',
        subject: 'owner-1',
        displayName: 'Owner One',
        color: '#6d5efc',
        adminToken: 'ADMIN_SECRET',
        reconnect: true,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(management.clear).not.toHaveBeenCalled();

    owner.destroy();
    expect(management.clear).toHaveBeenCalledOnce();
  });

  it('clears retained owner-access retry authority when its window is destroyed in flight', async () => {
    const client = fakeClient();
    const management = fakeManagement();
    let rejectBootstrap: ((error: Error) => void) | undefined;
    management.bootstrapAndJoin.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectBootstrap = reject;
        }),
    );
    serviceWith(client, management);
    const owner = renderer();
    electron.fromWebContents.mockReturnValue(owner.parent);

    const pending = invoke('bootstrapRoomAndJoin', owner.event, {
      serverUrl: 'wss://collaboration.example.test/team',
      managementBaseUrl: 'https://collaboration.example.test/control/',
      roomId: 'room-1',
      subject: 'owner-1',
      displayName: 'Owner One',
      color: '#6d5efc',
      adminToken: 'ADMIN_SECRET',
      reconnect: true,
    });
    await vi.waitFor(() => expect(management.bootstrapAndJoin).toHaveBeenCalledOnce());

    owner.destroy();
    expect(management.clear).toHaveBeenCalledOnce();
    rejectBootstrap?.(new Error('originating window closed'));
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(management.clear).toHaveBeenCalledOnce();
  });
});

function serviceWith(
  client: ReturnType<typeof fakeClient>,
  management: ReturnType<typeof fakeManagement>,
) {
  const service = new CollaborationIpcService(
    { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
    new OutboundActionGate({ appendAudit: vi.fn() }),
    { client, management },
  );
  service.registerIpcHandlers();
  return service;
}

function fakeClient() {
  let connection: CollaborationConnection | null = null;
  return {
    get connection() {
      return connection;
    },
    snapshot: null,
    join: vi.fn((input: CollaborationJoinInput) => {
      connection = connected(input);
      return Promise.resolve({ ok: true as const, connection });
    }),
    replaceAccessToken: vi.fn(),
    leave: vi.fn(() => {
      connection = null;
      return null;
    }),
    publish: vi.fn(),
    createComment: vi.fn(),
    replayComments: vi.fn(),
    setRejectedCommentSuppressions: vi.fn(),
    updateAwareness: vi.fn(),
    onEvent: vi.fn(() => vi.fn()),
    pause: vi.fn(),
    resume: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
}

function fakeManagement() {
  return {
    clear: vi.fn<CollaborationManagementOperations['clear']>(),
    clearPendingEffects: vi.fn<CollaborationManagementOperations['clearPendingEffects']>(),
    dispose: vi.fn<CollaborationManagementOperations['dispose']>(),
    bootstrapAndJoin: vi.fn<CollaborationManagementOperations['bootstrapAndJoin']>(),
    recoverAndJoin: vi.fn<CollaborationManagementOperations['recoverAndJoin']>(),
    refresh: vi.fn<CollaborationManagementOperations['refresh']>(),
    listMembers: vi.fn<CollaborationManagementOperations['listMembers']>(),
    updateMember: vi.fn<CollaborationManagementOperations['updateMember']>(),
    revokeMember: vi.fn<CollaborationManagementOperations['revokeMember']>(),
    listAudit: vi.fn<CollaborationManagementOperations['listAudit']>(),
  };
}

function renderer() {
  const frame = { detached: false };
  let destroyed: (() => void) | undefined;
  const sender = {
    id: 41,
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'destroyed') destroyed = listener;
    }),
    send: vi.fn(),
  };
  return {
    event: { sender, senderFrame: frame },
    parent: { isDestroyed: vi.fn(() => false) },
    destroy: () => destroyed?.(),
  };
}

function invoke(
  operation: keyof typeof COLLABORATION_IPC_CHANNELS,
  event: unknown,
  ...args: unknown[]
): Promise<unknown> {
  const handler = electron.handlers.get(COLLABORATION_IPC_CHANNELS[operation]);
  if (handler === undefined) throw new Error(`Missing ${operation} handler.`);
  return handler(event, ...args);
}

function joinInput(accessToken: string): CollaborationJoinInput {
  return {
    serverUrl: 'wss://collaboration.example.test/team',
    managementBaseUrl: 'https://collaboration.example.test/control/',
    roomId: 'room-1',
    subject: 'owner-1',
    displayName: 'Owner One',
    color: '#6d5efc',
    accessToken,
    reconnect: true,
  };
}

function connected(input: CollaborationJoinInput): CollaborationConnection {
  return {
    connectionId: CONNECTION_ID,
    serverUrl: input.serverUrl,
    ...(input.managementBaseUrl === undefined
      ? {}
      : { managementBaseUrl: input.managementBaseUrl }),
    roomId: input.roomId,
    subject: input.subject,
    displayName: input.displayName,
    color: input.color,
    role: 'owner',
    status: 'connected',
    reconnect: input.reconnect,
    reconnectAttempt: 0,
    connectedAt: NOW,
    lastTransitionAt: NOW,
  };
}
