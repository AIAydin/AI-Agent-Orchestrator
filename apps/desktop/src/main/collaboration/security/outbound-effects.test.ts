import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CollaborationConnection,
  CollaborationEvent,
  CollaborationJoinInput,
  CollaborationMetadataSnapshot,
  CollaborationPublishReceipt,
  CollaborationSyncRecovery,
} from '../../../shared/collaboration/index.js';
import { COLLABORATION_IPC_CHANNELS } from '../../../shared/collaboration/index.js';
import { OutboundActionGate } from '../../outbound/outbound-action-gate.js';

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

import { CollaborationIpcService } from '../ipc.js';

const NOW = '2026-07-18T12:00:00.000Z';
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const CANVAS_ID = '00000000-0000-4000-8000-000000000030';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000010';

beforeEach(() => {
  electron.handlers.clear();
  electron.fromWebContents.mockReset();
});

describe('CollaborationIpcService required effect audits', () => {
  it('fails closed before canvas, comment, or awareness publication when audit is unavailable', async () => {
    const client = fakeClient();
    const store = fakeStore();
    let failRequiredAudit = false;
    const appendAudit = vi.fn((category: string) => {
      if (failRequiredAudit && category === 'collaboration') {
        throw new Error('required collaboration audit unavailable');
      }
    });
    const { owner } = await joinedService(client, store, appendAudit);
    failRequiredAudit = true;

    await expect(
      invoke('publish', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        baseline: safeSnapshot(),
        snapshot: { ...safeSnapshot(), canvas: { ...safeSnapshot().canvas, title: 'blocked' } },
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      invoke('createComment', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        nodeId: 'node-1',
        body: 'blocked comment',
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      invoke('updateAwareness', owner.event, {
        awareness: { selection: { nodeIds: ['node-1'] } },
      }),
    ).resolves.toMatchObject({ ok: false });

    expect(store.stageCollaborationSyncDelivery).not.toHaveBeenCalled();
    expect(client.updateAwareness).not.toHaveBeenCalled();
    expect(client.snapshot).toEqual(safeSnapshot());
    expect(JSON.stringify(appendAudit.mock.calls)).not.toContain('blocked comment');
  });

  it('requires cancel-default native confirmation and a durable audit before local deletion', async () => {
    const client = fakeClient('viewer');
    const store = fakeStore();
    const rejectedDeliveryId = '00000000-0000-4000-8000-000000000096';
    const comment = {
      id: 'comment-requiring-discard-confirmation',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'private rejected text',
      createdAt: NOW,
    };
    const rejected: CollaborationSyncRecovery = {
      baseline: safeSnapshot(),
      pending: { ...safeSnapshot(), comments: { [comment.id]: comment } },
      deliveryId: rejectedDeliveryId,
      snapshotDigest: 'd'.repeat(64),
      disposition: 'rejected',
      rejectedCommentEntries: [{ comment, rejectedDeliveryId }],
      expiresAt: NOW,
    };
    store.recoverCollaborationSyncState.mockReturnValue(rejected);
    const appendAudit = vi.fn();
    const showMessageBox = vi
      .fn()
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValue({ response: 0 });
    const { owner } = await joinedService(client, store, appendAudit, showMessageBox);
    const input = { projectId: PROJECT_ID, canvasId: CANVAS_ID, comment, rejectedDeliveryId };

    await expect(invoke('discardRejectedComment', owner.event, input)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(store.discardRejectedCollaborationComment).not.toHaveBeenCalled();
    const cancellationAudit = JSON.stringify(appendAudit.mock.calls);
    expect(cancellationAudit).toContain('native-confirmation-cancelled');
    expect(cancellationAudit).not.toContain(comment.body);

    showMessageBox.mockResolvedValue({ response: 1 });
    appendAudit.mockImplementation((category: string, _action: string, outcome: string) => {
      if (category === 'collaboration' && outcome === 'allowed') {
        throw new Error('required discard audit unavailable');
      }
    });
    await expect(invoke('discardRejectedComment', owner.event, input)).resolves.toMatchObject({
      ok: false,
      error: { message: 'required discard audit unavailable' },
    });
    expect(store.discardRejectedCollaborationComment).not.toHaveBeenCalled();
  });

  it('fails closed before persisting or reporting a delivery settlement', async () => {
    const client = fakeClient();
    const store = fakeStore();
    let rejectSettlementAudit = false;
    const appendAudit = vi.fn((_category: string, action: string) => {
      if (rejectSettlementAudit && action === 'delivery-settlement-persist') {
        throw new Error('required settlement audit unavailable');
      }
    });
    const { owner } = await joinedService(client, store, appendAudit);
    const receipt = publishReceipt('9', 'a');
    await invoke('publish', owner.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      baseline: safeSnapshot(),
      snapshot: safeSnapshot(),
    });
    const acknowledgement: CollaborationEvent = {
      type: 'delivery-acknowledged',
      sequence: 1,
      occurredAt: NOW,
      connectionId: CONNECTION_ID,
      roomId: 'launch-room',
      acknowledgement: {
        protocol: 'forgeboard.delivery.v1',
        type: 'delivery-acknowledged',
        deliveryId: receipt.deliveryId,
        stateVector: 'AA==',
        persistedAt: NOW,
      },
      reconciledAfterReconnect: false,
    };

    rejectSettlementAudit = true;
    client.emit(acknowledgement);
    expect(store.settleCollaborationSyncDelivery).not.toHaveBeenCalled();
    expect(owner.event.sender.send).not.toHaveBeenCalled();

    rejectSettlementAudit = false;
    client.emit(acknowledgement);
    expect(store.settleCollaborationSyncDelivery).toHaveBeenCalledWith(
      receipt.deliveryId,
      'acknowledged',
    );
    expect(owner.event.sender.send).toHaveBeenCalledOnce();
    const audits = JSON.stringify(appendAudit.mock.calls);
    expect(audits).toContain('authorized-before-settlement-persist');
    expect(audits).not.toContain('AA==');
  });
});

async function joinedService(
  client: ReturnType<typeof fakeClient>,
  store: ReturnType<typeof fakeStore>,
  appendAudit: ReturnType<typeof vi.fn>,
  showMessageBox = vi.fn().mockResolvedValue({ response: 1 }),
) {
  const service = new CollaborationIpcService(
    { showMessageBox },
    new OutboundActionGate({ appendAudit }),
    { client, store },
  );
  service.registerIpcHandlers();
  const owner = renderer();
  electron.fromWebContents.mockReturnValue(owner.parent);
  await invoke('join', owner.event, joinInput());
  return { owner, service };
}

function invoke(
  operation: keyof typeof COLLABORATION_IPC_CHANNELS,
  event: unknown,
  ...args: unknown[]
) {
  const handler = electron.handlers.get(COLLABORATION_IPC_CHANNELS[operation]);
  if (handler === undefined) throw new Error(`Missing ${operation} handler.`);
  return handler(event, ...args);
}

function renderer() {
  const frame = { detached: false };
  const sender = {
    id: 1,
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    send: vi.fn(),
  };
  return {
    event: { sender, senderFrame: frame },
    parent: { isDestroyed: vi.fn(() => false) },
  };
}

function joinInput(): CollaborationJoinInput {
  return {
    serverUrl: 'wss://collaboration.example.test/team',
    roomId: 'launch-room',
    subject: 'editor-1',
    displayName: 'Local editor',
    color: '#6d5efc',
    accessToken: 'opaque-test-token',
    reconnect: true,
  };
}

function fakeClient(role: 'editor' | 'viewer' = 'editor') {
  let connection: CollaborationConnection | null = null;
  let snapshot = safeSnapshot();
  const listeners = new Set<(event: CollaborationEvent) => void>();
  return {
    get connection() {
      return connection;
    },
    get snapshot() {
      return connection === null ? null : snapshot;
    },
    join: vi.fn((input: CollaborationJoinInput) => {
      connection = {
        connectionId: CONNECTION_ID,
        serverUrl: input.serverUrl,
        roomId: input.roomId,
        subject: input.subject,
        displayName: input.displayName,
        color: input.color,
        role,
        status: 'connected',
        reconnect: input.reconnect,
        reconnectAttempt: 0,
        connectedAt: NOW,
        lastTransitionAt: NOW,
      };
      return Promise.resolve({ ok: true as const, connection });
    }),
    leave: vi.fn(() => {
      connection = null;
      return null;
    }),
    publish: vi.fn(
      (
        candidate: CollaborationMetadataSnapshot,
        beforeApply?: (receipt: CollaborationPublishReceipt) => void,
      ) => {
        const receipt = publishReceipt('9', 'a');
        beforeApply?.(receipt);
        snapshot = candidate;
        return receipt;
      },
    ),
    createComment: vi.fn(
      (input: { nodeId: string; body: string }, beforeApply?: (...args: never[]) => void) => {
        const comment = {
          id: 'comment-1',
          nodeId: input.nodeId,
          authorId: 'editor-1',
          body: input.body,
          createdAt: NOW,
        };
        const candidate = {
          ...snapshot,
          comments: { ...snapshot.comments, [comment.id]: comment },
        };
        const receipt = publishReceipt('8', 'b');
        beforeApply?.(candidate as never, comment as never, receipt as never);
        snapshot = candidate;
        return { comment, receipt };
      },
    ),
    replayComments: vi.fn(() => null),
    setRejectedCommentSuppressions: vi.fn(),
    updateAwareness: vi.fn(() => true),
    onEvent: vi.fn((listener: (event: CollaborationEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit: (event: CollaborationEvent) => {
      for (const listener of listeners) listener(event);
    },
    pause: vi.fn(),
    resume: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
}

function safeSnapshot(): CollaborationMetadataSnapshot {
  return {
    canvas: { id: CANVAS_ID, title: 'Canvas', version: 1, updatedAt: NOW },
    nodes: {
      'node-1': { id: 'node-1', type: 'task', title: 'Task', position: { x: 1, y: 2 } },
    },
    edges: {},
    groups: {},
    tasks: {},
    comments: {},
    workflow: {},
    reviews: {},
  };
}

function fakeStore() {
  return {
    loadCanvas: vi.fn(() => ({
      id: CANVAS_ID,
      projectId: PROJECT_ID,
      name: 'Canvas',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: NOW,
    })),
    recoverCollaborationSyncState: vi.fn<() => CollaborationSyncRecovery | null>(() => null),
    stageCollaborationSyncDelivery: vi.fn(),
    checkpointCollaborationSyncState: vi.fn(),
    discardRejectedCollaborationComment: vi.fn(),
    settleCollaborationSyncDelivery: vi.fn(),
  };
}

function publishReceipt(idSuffix: string, digestCharacter: string): CollaborationPublishReceipt {
  return {
    deliveryId: `00000000-0000-4000-8000-00000000009${idSuffix}`,
    snapshotDigest: digestCharacter.repeat(64),
    disposition: 'sent',
  };
}
