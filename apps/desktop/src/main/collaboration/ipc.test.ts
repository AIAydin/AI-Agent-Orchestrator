import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CollaborationConnection,
  CollaborationCreateCommentResult,
  CollaborationEvent,
  CollaborationJoinInput,
  CollaborationMetadataSnapshot,
  CollaborationPublishReceipt,
  CollaborationSyncRecovery,
} from '../../shared/collaboration/index.js';
import { OutboundActionGate } from '../outbound/outbound-action-gate.js';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
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
  applyCollaborationRejectedCommentDismissals,
} from '../../shared/collaboration/index.js';
import { CollaborationIpcService, collaborationJoinDisclosure } from './ipc.js';

const NOW = '2026-07-15T12:00:00.000Z';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000010';
const PROJECT_ID = '00000000-0000-4000-8000-000000000020';
const CANVAS_ID = '00000000-0000-4000-8000-000000000030';

beforeEach(() => {
  electron.handlers.clear();
  electron.fromWebContents.mockReset();
});

describe('CollaborationIpcService ownership and approval', () => {
  it('discloses allowlisted free text without claiming to inspect or redact secrets', () => {
    const disclosure = collaborationJoinDisclosure(joinInput('SESSION_TOKEN_DO_NOT_DISCLOSE'));

    expect(disclosure.warning).toMatch(/only the allowlisted fields/u);
    expect(disclosure.warning).toMatch(/does not inspect or redact secrets/u);
    expect(disclosure.warning).toMatch(/not selected automatically/u);
    expect(disclosure.warning).not.toMatch(/are excluded/u);
    expect(JSON.stringify(disclosure)).not.toContain('SESSION_TOKEN_DO_NOT_DISCLOSE');
  });

  it('main-authorizes terminal mutations only for collaboration owner and editor roles', async () => {
    const viewerClient = fakeClient('viewer');
    const viewerService = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: viewerClient },
    );
    viewerService.registerIpcHandlers();
    const viewer = renderer(1);
    const localWindow = renderer(2);
    electron.fromWebContents.mockReturnValue(viewer.parent);

    expect(() =>
      viewerService.assertTerminalMutationAuthorized(viewer.sender as never),
    ).not.toThrow();
    await invoke('join', viewer.event, joinInput('viewer-token'));
    expect(() => viewerService.assertTerminalMutationAuthorized(viewer.sender as never)).toThrow(
      /collaboration role cannot/u,
    );
    expect(() =>
      viewerService.assertTerminalMutationAuthorized(localWindow.sender as never),
    ).not.toThrow();

    await invoke('leave', viewer.event);
    const editorClient = fakeClient('editor');
    const editorService = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: editorClient },
    );
    editorService.registerIpcHandlers();
    await invoke('join', viewer.event, joinInput('editor-token'));
    expect(() =>
      editorService.assertTerminalMutationAuthorized(viewer.sender as never),
    ).not.toThrow();
  });

  it('denies terminal mutations while the collaboration owner role is unresolved', async () => {
    const client = fakeClient('editor');
    let resolveJoin: (() => void) | undefined;
    client.join.mockImplementationOnce(
      () =>
        new Promise((resolvePromise) => {
          resolveJoin = () =>
            resolvePromise({
              ok: true as const,
              connection: {
                connectionId: CONNECTION_ID,
                serverUrl: 'wss://collaboration.example.test/team',
                roomId: 'launch-room',
                subject: 'editor-1',
                displayName: 'Local editor',
                color: '#6d5efc',
                role: 'editor' as const,
                status: 'connected' as const,
                reconnect: true,
                reconnectAttempt: 0,
                connectedAt: NOW,
                lastTransitionAt: NOW,
              },
            });
        }),
    );
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);

    const joining = invoke('join', owner.event, joinInput('editor-token'));
    await vi.waitFor(() => expect(client.join).toHaveBeenCalledOnce());
    expect(() => service.assertTerminalMutationAuthorized(owner.sender as never)).toThrow(
      /collaboration role cannot/u,
    );
    resolveJoin?.();
    await joining;
  });

  it('does not claim an owner on cancellation and never discloses the token', async () => {
    const client = fakeClient();
    const audit = { appendAudit: vi.fn() };
    const dialog = {
      showMessageBox: vi
        .fn()
        .mockResolvedValueOnce({ response: 0 })
        .mockResolvedValueOnce({ response: 1 }),
    };
    const service = new CollaborationIpcService(dialog, new OutboundActionGate(audit), { client });
    service.registerIpcHandlers();
    const first = renderer(1);
    const second = renderer(2);
    electron.fromWebContents.mockImplementation((sender) =>
      sender === first.sender ? first.parent : second.parent,
    );
    const token = 'SESSION_TOKEN_DO_NOT_DISCLOSE';

    await expect(invoke('join', first.event, joinInput(token))).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
    await expect(invoke('join', second.event, joinInput(token))).resolves.toMatchObject({
      ok: true,
      connection: { status: 'connected' },
    });

    expect(client.join).toHaveBeenCalledOnce();
    expect(JSON.stringify(dialog.showMessageBox.mock.calls)).not.toContain(token);
    expect(JSON.stringify(audit.appendAudit.mock.calls)).not.toContain(token);
  });

  it('fails closed for another owner and clears ownership on leave', async () => {
    const client = fakeClient();
    const dialog = {
      showMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
    };
    const service = new CollaborationIpcService(
      dialog,
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client },
    );
    service.registerIpcHandlers();
    const first = renderer(1);
    const second = renderer(2);
    electron.fromWebContents.mockImplementation((sender) =>
      sender === first.sender ? first.parent : second.parent,
    );

    await invoke('join', first.event, joinInput('first-token'));
    await expect(invoke('join', second.event, joinInput('second-token'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'authorization-failed' },
    });
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(client.leave).not.toHaveBeenCalled();

    await expect(invoke('leave', first.event)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(client.leave).toHaveBeenCalledOnce();
    await expect(invoke('join', second.event, joinInput('second-token'))).resolves.toMatchObject({
      ok: true,
      connection: { subject: 'editor-1' },
    });
  });

  it('returns the authenticated room snapshot only to the owning renderer', async () => {
    const client = fakeClient();
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    const other = renderer(2);
    electron.fromWebContents.mockImplementation((sender) =>
      sender === owner.sender ? owner.parent : other.parent,
    );
    await invoke('join', owner.event, joinInput('owner-token'));
    await expect(invoke('snapshot', owner.event)).resolves.toEqual({
      ok: true,
      value: safeSnapshot(),
    });
    await expect(invoke('snapshot', other.event)).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it('returns the durable delivery receipt only to the owning renderer', async () => {
    const client = fakeClient();
    const store = fakeStore();
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    const other = renderer(2);
    electron.fromWebContents.mockImplementation((sender) =>
      sender === owner.sender ? owner.parent : other.parent,
    );
    await invoke('join', owner.event, joinInput('owner-token'));
    client.emit(acknowledgementEvent('00000000-0000-4000-8000-000000000099'));

    const input = {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      baseline: null,
      snapshot: safeSnapshot(),
    };
    await expect(invoke('publish', owner.event, input)).resolves.toEqual({
      ok: true,
      value: {
        deliveryId: '00000000-0000-4000-8000-000000000099',
        snapshotDigest: 'a'.repeat(64),
        disposition: 'sent',
      },
    });
    await expect(invoke('publish', other.event, input)).resolves.toMatchObject({
      ok: false,
    });
    expect(client.publish).toHaveBeenCalledOnce();
    expect(store.recordCollaborationSyncDelivery).toHaveBeenCalledOnce();
    expect(store.settleCollaborationSyncDelivery).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000099',
      'acknowledged',
    );
  });

  it('fails before publish or comment mutation when the durable delivery journal is unavailable', async () => {
    const client = fakeClient();
    const store = fakeStore();
    store.recordCollaborationSyncDelivery.mockImplementation(() => {
      throw new Error('durable journal unavailable');
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('owner-token'));
    const baseline = safeSnapshot();

    await expect(
      invoke('publish', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        baseline,
        snapshot: {
          ...baseline,
          canvas: { ...baseline.canvas, title: 'Must not escape' },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: 'durable journal unavailable' },
    });
    await expect(
      invoke('createComment', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        nodeId: 'node-1',
        body: 'Must not escape',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: 'durable journal unavailable' },
    });
    await expect(invoke('snapshot', owner.event)).resolves.toEqual({
      ok: true,
      value: baseline,
    });
    expect(store.stageCollaborationSyncState).toHaveBeenCalledTimes(2);
    expect(store.recordCollaborationSyncDelivery).toHaveBeenCalledTimes(2);
  });

  it('does not stage phantom restart intent when client delivery capacity rejects a publish or comment', async () => {
    const client = fakeClient();
    client.publish.mockReturnValueOnce(null);
    client.createComment.mockReturnValueOnce(null);
    const store = fakeStore();
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('owner-token'));

    await expect(
      invoke('publish', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        baseline: safeSnapshot(),
        snapshot: {
          ...safeSnapshot(),
          canvas: { ...safeSnapshot().canvas, title: 'Phantom' },
        },
      }),
    ).resolves.toEqual({ ok: true, value: null });
    await expect(
      invoke('createComment', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        nodeId: 'node-1',
        body: 'Also phantom',
      }),
    ).resolves.toEqual({ ok: true, value: null });
    expect(store.stageCollaborationSyncState).not.toHaveBeenCalled();
    expect(store.recordCollaborationSyncDelivery).not.toHaveBeenCalled();
  });

  it('forwards a durable server acknowledgement when the local settlement update fails', async () => {
    const client = fakeClient();
    const store = fakeStore();
    const deliveryId = '00000000-0000-4000-8000-000000000099';
    store.settleCollaborationSyncDelivery.mockImplementation(() => {
      throw new Error('settlement write unavailable');
    });
    store.recoverCollaborationSyncState.mockReturnValue({
      baseline: safeSnapshot(),
      pending: safeSnapshot(),
      deliveryId,
      snapshotDigest: 'a'.repeat(64),
      disposition: 'sent',
      expiresAt: NOW,
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('owner-token'));
    await invoke('publish', owner.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      baseline: safeSnapshot(),
      snapshot: safeSnapshot(),
    });
    owner.sender.send.mockClear();
    const acknowledgement = acknowledgementEvent(deliveryId);

    expect(() => client.emit(acknowledgement)).not.toThrow();
    expect(owner.sender.send).toHaveBeenCalledWith(
      COLLABORATION_IPC_CHANNELS.event,
      acknowledgement,
    );
    await expect(
      invoke('checkpoint', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        snapshot: safeSnapshot(),
      }),
    ).resolves.toEqual({ ok: true, value: true });
    expect(store.checkpointCollaborationSyncState).toHaveBeenCalledOnce();
  });

  it('fails recovery closed when rejected B cannot settle beneath newer C across rejoin', async () => {
    const client = fakeClient('editor');
    const store = fakeStore();
    const deliveryId = '00000000-0000-4000-8000-000000000098';
    const comment = {
      id: 'comment-1',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Rejected feedback',
      createdAt: NOW,
    };
    const baseline = safeSnapshot();
    const pending = { ...baseline, comments: { [comment.id]: comment } };
    store.settleCollaborationSyncDelivery.mockImplementation(() => {
      throw new Error('settlement write unavailable');
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('editor-token'));
    await invoke('createComment', owner.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      nodeId: 'node-1',
      body: comment.body,
    });
    const candidateC = {
      ...pending,
      canvas: { ...pending.canvas, title: 'Newer C' },
    };
    await expect(
      invoke('publish', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        baseline,
        snapshot: candidateC,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { deliveryId: '00000000-0000-4000-8000-000000000099' },
    });
    client.emit(rejectionEvent(deliveryId));
    store.recoverCollaborationSyncState.mockReturnValue({
      baseline,
      pending: candidateC,
      deliveryId: '00000000-0000-4000-8000-000000000099',
      snapshotDigest: 'a'.repeat(64),
      disposition: 'sent',
      rejectedCommentIds: [],
      expiresAt: NOW,
    });

    await invoke('leave', owner.event);
    await invoke('join', owner.event, joinInput('editor-token'));
    await expect(
      invoke('recover', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
      }),
    ).resolves.toMatchObject({
      ok: false,
    });
    expect(store.settleCollaborationSyncDelivery).toHaveBeenCalledTimes(2);
    expect(store.checkpointCollaborationSyncState).not.toHaveBeenCalled();
    expect(client.replayComments).not.toHaveBeenCalled();
  });

  it('replays a retained reviewer comment narrowly after restart and returns its tracked receipt', async () => {
    const reviewer = fakeClient('reviewer');
    const store = fakeStore();
    const baseline = safeSnapshot();
    const comment = {
      id: 'comment-restart',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Retained reviewer feedback',
      resolved: false,
      createdAt: NOW,
    };
    const pending = { ...baseline, comments: { [comment.id]: comment } };
    const recovery: CollaborationSyncRecovery = {
      baseline,
      pending,
      disposition: 'staged',
      expiresAt: NOW,
    };
    store.recoverCollaborationSyncState.mockReturnValueOnce(recovery).mockReturnValueOnce({
      ...recovery,
      deliveryId: '00000000-0000-4000-8000-000000000097',
      snapshotDigest: 'c'.repeat(64),
      disposition: 'sent',
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: reviewer, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('reviewer-token'));

    await expect(
      invoke('recover', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        disposition: 'sent',
        replayedReceipt: {
          deliveryId: '00000000-0000-4000-8000-000000000097',
        },
      },
    });
    expect(reviewer.replayComments).toHaveBeenCalledWith([comment], expect.any(Function));
    expect(reviewer.publish).not.toHaveBeenCalled();
    expect(store.stageCollaborationSyncState).toHaveBeenCalledWith(
      expect.any(Object),
      baseline,
      pending,
    );
  });

  it('replays only missing B against room A so a B rejection cannot quarantine acknowledged A', async () => {
    const reviewer = fakeClient('reviewer');
    const store = fakeStore();
    const original = safeSnapshot();
    const commentA = {
      id: 'comment-a',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Already durable A',
      createdAt: NOW,
    };
    const commentB = {
      id: 'comment-b',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Missing B',
      createdAt: NOW,
    };
    const roomA = { ...original, comments: { [commentA.id]: commentA } };
    const retainedAB = {
      ...original,
      comments: { [commentA.id]: commentA, [commentB.id]: commentB },
    };
    reviewer.setSnapshot(roomA);
    const recovery: CollaborationSyncRecovery = {
      baseline: original,
      pending: retainedAB,
      disposition: 'staged',
      expiresAt: NOW,
    };
    store.recoverCollaborationSyncState.mockReturnValueOnce(recovery).mockReturnValueOnce({
      baseline: roomA,
      pending: retainedAB,
      deliveryId: '00000000-0000-4000-8000-000000000097',
      snapshotDigest: 'c'.repeat(64),
      disposition: 'sent',
      expiresAt: NOW,
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: reviewer, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('reviewer-token'));

    await expect(
      invoke('recover', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        baseline: { comments: { 'comment-a': { id: 'comment-a' } } },
        pending: {
          comments: {
            'comment-a': { id: 'comment-a' },
            'comment-b': { id: 'comment-b' },
          },
        },
        replayedReceipt: { deliveryId: '00000000-0000-4000-8000-000000000097' },
      },
    });
    expect(reviewer.replayComments).toHaveBeenCalledWith([commentB], expect.any(Function));
    expect(store.stageCollaborationSyncDelivery).toHaveBeenCalledWith(
      expect.any(Object),
      roomA,
      retainedAB,
      expect.objectContaining({
        deliveryId: '00000000-0000-4000-8000-000000000097',
      }),
    );
  });

  it('replays an exact rejected reviewer comment after restart when authority is valid', async () => {
    const reviewer = fakeClient('reviewer');
    const store = fakeStore();
    const baseline = safeSnapshot();
    const comment = {
      id: 'comment-rejected',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Rejected reviewer feedback',
      resolved: false,
      createdAt: NOW,
    };
    const recovery: CollaborationSyncRecovery = {
      baseline,
      pending: { ...baseline, comments: { [comment.id]: comment } },
      deliveryId: '00000000-0000-4000-8000-000000000096',
      snapshotDigest: 'd'.repeat(64),
      disposition: 'rejected',
      rejectedCommentIds: [comment.id],
      rejectedComments: [comment],
      expiresAt: NOW,
    };
    store.recoverCollaborationSyncState.mockReturnValueOnce(recovery).mockReturnValue({
      ...recovery,
      deliveryId: '00000000-0000-4000-8000-000000000097',
      snapshotDigest: 'c'.repeat(64),
      disposition: 'sent',
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: reviewer, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('reviewer-token'));

    await expect(
      invoke('recover', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        disposition: 'sent',
        replayedReceipt: {
          deliveryId: '00000000-0000-4000-8000-000000000097',
        },
      },
    });
    expect(reviewer.replayComments).toHaveBeenCalledWith([comment], expect.any(Function));
    expect(store.stageCollaborationSyncDelivery).toHaveBeenCalled();
  });

  it('returns exact rejected text locally without replay when the current role cannot comment', async () => {
    const viewer = fakeClient('viewer');
    const store = fakeStore();
    const comment = {
      id: 'comment-retained-for-viewer',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Exact text retained after downgrade',
      createdAt: NOW,
    };
    store.recoverCollaborationSyncState.mockReturnValue({
      baseline: safeSnapshot(),
      pending: safeSnapshot(),
      deliveryId: '00000000-0000-4000-8000-000000000096',
      snapshotDigest: 'd'.repeat(64),
      disposition: 'rejected',
      rejectedCommentIds: [comment.id],
      rejectedComments: [comment],
      expiresAt: NOW,
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: viewer, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('viewer-token'));

    await expect(
      invoke('recover', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        rejectedComments: [{ id: comment.id, body: 'Exact text retained after downgrade' }],
      },
    });
    expect(viewer.replayComments).not.toHaveBeenCalled();
    expect(store.checkpointCollaborationSyncState).not.toHaveBeenCalled();
  });

  it('lets a downgraded viewer discard an exact local rejection and checkpoints only its overlay', async () => {
    const viewer = fakeClient('viewer');
    const store = fakeStore();
    const rejectedDeliveryId = '00000000-0000-4000-8000-000000000096';
    const comment = {
      id: 'comment-retained-for-viewer',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Exact text retained after downgrade',
      createdAt: NOW,
    };
    const room = safeSnapshot();
    const pending = { ...room, comments: { [comment.id]: comment } };
    const rejected: CollaborationSyncRecovery = {
      baseline: room,
      pending,
      deliveryId: rejectedDeliveryId,
      snapshotDigest: 'd'.repeat(64),
      disposition: 'rejected',
      rejectedCommentIds: [comment.id],
      rejectedComments: [comment],
      rejectedCommentEntries: [{ comment, rejectedDeliveryId }],
      dismissedRejectedComments: [],
      expiresAt: NOW,
    };
    store.recoverCollaborationSyncState.mockReturnValue(rejected);
    store.discardRejectedCollaborationComment.mockReturnValue({
      ...rejected,
      rejectedCommentIds: [],
      rejectedComments: [],
      rejectedCommentEntries: [],
      dismissedRejectedComments: [comment],
      dismissedRejectedCommentEntries: [{ comment, rejectedDeliveryId }],
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: viewer, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('viewer-token'));

    await expect(
      invoke('discardRejectedComment', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        comment,
        rejectedDeliveryId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { disposition: 'synchronized' },
    });
    expect(store.discardRejectedCollaborationComment).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'editor-1' }),
      comment,
      rejectedDeliveryId,
    );
    expect(store.checkpointCollaborationSyncState).toHaveBeenCalledWith(expect.any(Object), room);
    expect(viewer.replayComments).not.toHaveBeenCalled();
    expect(viewer.publish).not.toHaveBeenCalled();
    expect(viewer.setRejectedCommentSuppressions).toHaveBeenLastCalledWith([comment], room);
    expect(viewer.setRejectedCommentSuppressions).not.toHaveBeenCalledWith([], null);
    const suppressionCallCount = viewer.setRejectedCommentSuppressions.mock.calls.length;
    await invoke('join', owner.event, joinInput('viewer-rejoin-token'));
    expect(viewer.setRejectedCommentSuppressions).toHaveBeenCalledTimes(suppressionCallCount);
  });

  it('retains unrelated local graph intent after an exact rejected comment is discarded', async () => {
    const viewer = fakeClient('viewer');
    const store = fakeStore();
    const rejectedDeliveryId = '00000000-0000-4000-8000-000000000095';
    const comment = {
      id: 'comment-with-graph-intent',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Discard only this comment',
      createdAt: NOW,
    };
    const review = {
      id: 'review-with-rejected-comment',
      nodeId: 'node-1',
      reviewerId: 'editor-1',
      status: 'changes-requested' as const,
      createdAt: NOW,
    };
    const room = { ...safeSnapshot(), reviews: { [review.id]: review } };
    const pending = {
      ...room,
      canvas: { ...room.canvas, title: 'Unrelated retained graph edit' },
      comments: { [comment.id]: comment },
      reviews: { [review.id]: { ...review, commentIds: [comment.id] } },
    };
    const afterDismissal: CollaborationSyncRecovery = {
      baseline: room,
      pending,
      deliveryId: rejectedDeliveryId,
      snapshotDigest: 'e'.repeat(64),
      disposition: 'rejected',
      rejectedCommentIds: [],
      rejectedComments: [],
      rejectedCommentEntries: [],
      dismissedRejectedComments: [comment],
      dismissedRejectedCommentEntries: [{ comment, rejectedDeliveryId }],
      expiresAt: NOW,
    };
    store.recoverCollaborationSyncState.mockReturnValue({
      ...afterDismissal,
      rejectedCommentIds: [comment.id],
      rejectedComments: [comment],
      rejectedCommentEntries: [{ comment, rejectedDeliveryId }],
      dismissedRejectedComments: [],
    });
    store.discardRejectedCollaborationComment.mockReturnValue(afterDismissal);
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: viewer, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('viewer-token'));

    await expect(
      invoke('discardRejectedComment', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        comment,
        rejectedDeliveryId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        disposition: 'rejected',
        dismissedRejectedComments: [{ id: comment.id }],
      },
    });
    expect(store.checkpointCollaborationSyncState).not.toHaveBeenCalled();
    expect(viewer.setRejectedCommentSuppressions).toHaveBeenLastCalledWith([comment], room);
  });

  it('finishes a crash-interrupted exact dismissal during the next recovery read', async () => {
    const viewer = fakeClient('viewer');
    const store = fakeStore();
    const comment = {
      id: 'comment-dismissed-before-crash',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Already dismissed locally',
      createdAt: NOW,
    };
    const room = safeSnapshot();
    const rejectedDeliveryId = '00000000-0000-4000-8000-000000000094';
    const remoteC = {
      ...room,
      canvas: { ...room.canvas, title: 'Authenticated remote C' },
    };
    const locallyPollutedCurrent = {
      ...remoteC,
      comments: { [comment.id]: comment },
    };
    viewer.setSnapshot(locallyPollutedCurrent);
    store.recoverCollaborationSyncState.mockReturnValue({
      baseline: room,
      pending: { ...room, comments: { [comment.id]: comment } },
      deliveryId: rejectedDeliveryId,
      snapshotDigest: 'f'.repeat(64),
      disposition: 'rejected',
      rejectedCommentIds: [],
      rejectedComments: [],
      rejectedCommentEntries: [],
      dismissedRejectedComments: [comment],
      dismissedRejectedCommentEntries: [{ comment, rejectedDeliveryId }],
      expiresAt: NOW,
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: viewer, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('viewer-token'));

    await expect(
      invoke('recover', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { disposition: 'synchronized', pending: { comments: {} } },
    });
    expect(store.checkpointCollaborationSyncState).toHaveBeenCalledWith(expect.any(Object), room);
    expect(viewer.snapshot).toEqual(remoteC);
    expect(viewer.replayComments).not.toHaveBeenCalled();
    expect(viewer.setRejectedCommentSuppressions).toHaveBeenLastCalledWith([comment], room);
    expect(viewer.setRejectedCommentSuppressions).not.toHaveBeenCalledWith([], null);
  });

  it('keeps a session dismissal across recovery but reveals a newer identical rejection', async () => {
    const viewer = fakeClient('viewer');
    const store = fakeStore();
    const originalDeliveryId = '00000000-0000-4000-8000-000000000091';
    const newerDeliveryId = '00000000-0000-4000-8000-000000000092';
    const comment = {
      id: 'comment-identical-new-rejection',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Identical text with a newer delivery',
      createdAt: NOW,
    };
    const room = safeSnapshot();
    const pending = {
      ...room,
      canvas: { ...room.canvas, title: 'Retained unrelated graph intent' },
      comments: { [comment.id]: comment },
    };
    store.recoverCollaborationSyncState.mockReturnValue({
      baseline: room,
      pending,
      deliveryId: originalDeliveryId,
      snapshotDigest: '1'.repeat(64),
      disposition: 'rejected',
      rejectedCommentIds: [],
      rejectedComments: [],
      rejectedCommentEntries: [],
      dismissedRejectedComments: [comment],
      dismissedRejectedCommentEntries: [{ comment, rejectedDeliveryId: originalDeliveryId }],
      expiresAt: NOW,
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: viewer, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('viewer-token'));

    await invoke('recover', owner.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
    });
    expect(viewer.setRejectedCommentSuppressions).toHaveBeenLastCalledWith([comment], room);

    const advancedBaseline = {
      ...room,
      canvas: { ...room.canvas, title: 'Advanced authoritative baseline' },
    };
    store.recoverCollaborationSyncState.mockReturnValue({
      baseline: advancedBaseline,
      pending,
      deliveryId: originalDeliveryId,
      snapshotDigest: '1'.repeat(64),
      disposition: 'rejected',
      rejectedCommentIds: [],
      rejectedComments: [],
      rejectedCommentEntries: [],
      dismissedRejectedComments: [comment],
      dismissedRejectedCommentEntries: [{ comment, rejectedDeliveryId: originalDeliveryId }],
      expiresAt: NOW,
    });
    await invoke('recover', owner.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
    });
    expect(viewer.setRejectedCommentSuppressions).toHaveBeenLastCalledWith(
      [comment],
      advancedBaseline,
    );

    store.recoverCollaborationSyncState.mockReturnValue({
      baseline: room,
      pending,
      deliveryId: newerDeliveryId,
      snapshotDigest: '2'.repeat(64),
      disposition: 'rejected',
      rejectedCommentIds: [comment.id],
      rejectedComments: [comment],
      rejectedCommentEntries: [{ comment, rejectedDeliveryId: newerDeliveryId }],
      dismissedRejectedComments: [],
      dismissedRejectedCommentEntries: [],
      expiresAt: NOW,
    });

    await invoke('recover', owner.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
    });
    expect(viewer.setRejectedCommentSuppressions).toHaveBeenLastCalledWith([], null);
    expect(store.checkpointCollaborationSyncState).not.toHaveBeenCalled();
  });

  it('reveals an accepted comment even when a newer unrelated delivery is still sent', async () => {
    const viewer = fakeClient('viewer');
    const store = fakeStore();
    const rejectedDeliveryId = '00000000-0000-4000-8000-000000000089';
    const laterDeliveryId = '00000000-0000-4000-8000-000000000090';
    const comment = {
      id: 'comment-accepted-before-later-delivery',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'The server later accepted this exact value',
      createdAt: NOW,
    };
    const room = safeSnapshot();
    const rejectedPending = {
      ...room,
      canvas: { ...room.canvas, title: 'Retained local graph intent' },
      comments: { [comment.id]: comment },
    };
    store.recoverCollaborationSyncState.mockReturnValue({
      baseline: room,
      pending: rejectedPending,
      deliveryId: rejectedDeliveryId,
      snapshotDigest: '3'.repeat(64),
      disposition: 'rejected',
      rejectedCommentIds: [],
      rejectedComments: [],
      rejectedCommentEntries: [],
      dismissedRejectedComments: [comment],
      dismissedRejectedCommentEntries: [{ comment, rejectedDeliveryId }],
      expiresAt: NOW,
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: viewer, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('viewer-token'));

    await invoke('recover', owner.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
    });
    expect(viewer.setRejectedCommentSuppressions).toHaveBeenLastCalledWith([comment], room);

    const acceptedBaseline = { ...room, comments: { [comment.id]: comment } };
    store.recoverCollaborationSyncState.mockReturnValue({
      baseline: acceptedBaseline,
      pending: {
        ...acceptedBaseline,
        canvas: {
          ...acceptedBaseline.canvas,
          title: 'Newer unrelated pending C',
        },
      },
      deliveryId: laterDeliveryId,
      snapshotDigest: '4'.repeat(64),
      disposition: 'sent',
      rejectedCommentIds: [],
      rejectedComments: [],
      rejectedCommentEntries: [],
      dismissedRejectedComments: [],
      dismissedRejectedCommentEntries: [],
      expiresAt: NOW,
    });

    await invoke('recover', owner.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
    });
    expect(viewer.setRejectedCommentSuppressions).toHaveBeenLastCalledWith([], null);
  });

  it('returns an in-flight tracked receipt when the renderer reattaches to the same session', async () => {
    const reviewer = fakeClient('reviewer');
    const store = fakeStore();
    const baseline = safeSnapshot();
    const comment = {
      id: 'comment-1',
      nodeId: 'node-1',
      authorId: 'editor-1',
      body: 'Still awaiting acknowledgement',
      createdAt: NOW,
    };
    const pending = { ...baseline, comments: { [comment.id]: comment } };
    store.recoverCollaborationSyncState.mockReturnValueOnce(null).mockReturnValue({
      baseline,
      pending,
      deliveryId: '00000000-0000-4000-8000-000000000098',
      snapshotDigest: 'b'.repeat(64),
      disposition: 'sent',
      expiresAt: NOW,
    });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: reviewer, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('reviewer-token'));
    await invoke('createComment', owner.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      nodeId: 'node-1',
      body: comment.body,
    });

    await expect(
      invoke('recover', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        replayedReceipt: {
          deliveryId: '00000000-0000-4000-8000-000000000098',
          disposition: 'sent',
        },
      },
    });
    expect(reviewer.replayComments).not.toHaveBeenCalled();
    expect(store.checkpointCollaborationSyncState).not.toHaveBeenCalled();
  });

  it('refuses to checkpoint staged or rejected intent before durable acknowledgement', async () => {
    const client = fakeClient();
    const store = fakeStore();
    const recovery: CollaborationSyncRecovery = {
      baseline: safeSnapshot(),
      pending: {
        ...safeSnapshot(),
        canvas: { ...safeSnapshot().canvas, title: 'Local intent' },
      },
      disposition: 'staged',
      expiresAt: NOW,
    };
    store.recoverCollaborationSyncState
      .mockReturnValueOnce(recovery)
      .mockReturnValueOnce({ ...recovery, disposition: 'rejected' });
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('owner-token'));
    const input = {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      snapshot: safeSnapshot(),
    };

    await expect(invoke('checkpoint', owner.event, input)).resolves.toMatchObject({ ok: false });
    await expect(invoke('checkpoint', owner.event, input)).resolves.toMatchObject({ ok: false });
    expect(store.checkpointCollaborationSyncState).not.toHaveBeenCalled();
  });

  it('retains rejected B when acknowledged C omits it during recovery and checkpoint', async () => {
    const client = fakeClient();
    const store = fakeStore();
    const candidateC = {
      ...safeSnapshot(),
      canvas: { ...safeSnapshot().canvas, title: 'Acknowledged C without B' },
    };
    const recovery: CollaborationSyncRecovery = {
      baseline: candidateC,
      pending: candidateC,
      deliveryId: '00000000-0000-4000-8000-000000000099',
      snapshotDigest: 'c'.repeat(64),
      disposition: 'acknowledged',
      rejectedCommentIds: ['comment-b'],
      rejectedComments: [
        {
          id: 'comment-b',
          nodeId: 'node-1',
          authorId: 'editor-1',
          body: 'Exact rejected B',
          createdAt: NOW,
        },
      ],
      expiresAt: NOW,
    };
    const rejectedComment = recovery.rejectedComments?.[0];
    if (rejectedComment === undefined) throw new Error('Missing rejected comment fixture.');
    const replayed: CollaborationMetadataSnapshot = {
      ...candidateC,
      comments: { 'comment-b': rejectedComment },
    };
    client.setSnapshot(candidateC);
    store.recoverCollaborationSyncState
      .mockReturnValueOnce(recovery)
      .mockReturnValueOnce({
        ...recovery,
        pending: replayed,
        deliveryId: '00000000-0000-4000-8000-000000000097',
        snapshotDigest: 'c'.repeat(64),
        disposition: 'sent',
      })
      .mockReturnValue(recovery);
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('owner-token'));

    await expect(
      invoke('recover', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        rejectedCommentIds: ['comment-b'],
        rejectedComments: [{ id: 'comment-b', body: 'Exact rejected B' }],
        replayedReceipt: {
          deliveryId: '00000000-0000-4000-8000-000000000097',
        },
      },
    });
    expect(client.replayComments).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'comment-b', body: 'Exact rejected B' })],
      expect.any(Function),
    );
    client.setSnapshot(candidateC);
    await expect(
      invoke('checkpoint', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        snapshot: candidateC,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(store.checkpointCollaborationSyncState).not.toHaveBeenCalled();
  });

  it('allows a reviewer only the narrow identity-bound comment path and rejects viewer downgrade', async () => {
    const store = fakeStore();
    const reviewer = fakeClient('reviewer');
    const service = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: reviewer, store },
    );
    service.registerIpcHandlers();
    const owner = renderer(1);
    electron.fromWebContents.mockReturnValue(owner.parent);
    await invoke('join', owner.event, joinInput('reviewer-token'));
    const input = {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      nodeId: 'node-1',
      body: 'Please revise this.',
    };

    await expect(invoke('createComment', owner.event, input)).resolves.toMatchObject({
      ok: true,
      value: { comment: { authorId: 'editor-1', body: 'Please revise this.' } },
    });
    expect(reviewer.createComment).toHaveBeenCalledWith(
      { nodeId: 'node-1', body: 'Please revise this.' },
      expect.any(Function),
    );
    await expect(
      invoke('publish', owner.event, {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        baseline: safeSnapshot(),
        snapshot: safeSnapshot(),
      }),
    ).resolves.toMatchObject({ ok: false });

    await invoke('leave', owner.event);
    const viewer = fakeClient('viewer');
    const viewerService = new CollaborationIpcService(
      { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) },
      new OutboundActionGate({ appendAudit: vi.fn() }),
      { client: viewer, store },
    );
    viewerService.registerIpcHandlers();
    await invoke('join', owner.event, joinInput('viewer-token'));
    await expect(invoke('createComment', owner.event, input)).resolves.toMatchObject({ ok: false });
    expect(viewer.createComment).not.toHaveBeenCalled();
  });
});

function invoke(
  operation:
    | 'join'
    | 'leave'
    | 'snapshot'
    | 'publish'
    | 'recover'
    | 'checkpoint'
    | 'discardRejectedComment'
    | 'createComment',
  event: unknown,
  ...args: unknown[]
): Promise<unknown> {
  const handler = electron.handlers.get(COLLABORATION_IPC_CHANNELS[operation]);
  if (handler === undefined) throw new Error(`Missing ${operation} handler.`);
  return handler(event, ...args);
}

function renderer(id: number) {
  const frame = { detached: false };
  const sender = {
    id,
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    send: vi.fn(),
  };
  return {
    sender,
    event: { sender, senderFrame: frame },
    parent: { isDestroyed: vi.fn(() => false) },
  };
}

function acknowledgementEvent(deliveryId: string): CollaborationEvent {
  return {
    type: 'delivery-acknowledged',
    sequence: 2,
    occurredAt: NOW,
    connectionId: CONNECTION_ID,
    roomId: 'launch-room',
    acknowledgement: {
      protocol: 'forgeboard.delivery.v1',
      type: 'delivery-acknowledged',
      deliveryId,
      stateVector: 'AQID',
      persistedAt: NOW,
    },
    reconciledAfterReconnect: false,
  };
}

function rejectionEvent(deliveryId: string): CollaborationEvent {
  return {
    type: 'delivery-rejected',
    sequence: 3,
    occurredAt: NOW,
    connectionId: CONNECTION_ID,
    roomId: 'launch-room',
    rejection: {
      protocol: 'forgeboard.delivery.v1',
      type: 'delivery-rejected',
      deliveryId,
      stateVector: 'AQID',
      reason: 'not-authorized',
    },
    duringReconnect: false,
  };
}

function joinInput(accessToken: string): CollaborationJoinInput {
  return {
    serverUrl: 'wss://collaboration.example.test/team',
    roomId: 'launch-room',
    subject: 'editor-1',
    displayName: 'Local editor',
    color: '#6d5efc',
    accessToken,
    reconnect: true,
  };
}

function fakeClient(role: 'owner' | 'editor' | 'reviewer' | 'viewer' = 'editor') {
  let connection: CollaborationConnection | null = null;
  let currentSnapshot = safeSnapshot();
  let suppressedComments: CollaborationMetadataSnapshot['comments'][string][] = [];
  let suppressionBaseline: CollaborationMetadataSnapshot | null = null;
  const listeners = new Set<(event: CollaborationEvent) => void>();
  return {
    get connection() {
      return connection;
    },
    get snapshot() {
      return connection === null
        ? null
        : applyCollaborationRejectedCommentDismissals(
            currentSnapshot,
            suppressedComments,
            suppressionBaseline,
          );
    },
    join: vi.fn((input: CollaborationJoinInput) => {
      suppressedComments = [];
      suppressionBaseline = null;
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
      suppressedComments = [];
      suppressionBaseline = null;
      connection = null;
      return null;
    }),
    publish: vi.fn(
      (
        candidate: CollaborationMetadataSnapshot,
        beforeApply?: (receipt: {
          readonly deliveryId: string;
          readonly snapshotDigest: string;
          readonly disposition: 'sent';
        }) => void,
      ): CollaborationPublishReceipt | null => {
        const receipt = {
          deliveryId: '00000000-0000-4000-8000-000000000099',
          snapshotDigest: 'a'.repeat(64),
          disposition: 'sent' as const,
        };
        beforeApply?.(receipt);
        currentSnapshot = candidate;
        return receipt;
      },
    ),
    createComment: vi.fn(
      (
        input: { readonly nodeId: string; readonly body: string },
        beforeApply?: (
          snapshot: CollaborationMetadataSnapshot,
          comment: CollaborationMetadataSnapshot['comments'][string],
          receipt: {
            readonly deliveryId: string;
            readonly snapshotDigest: string;
            readonly disposition: 'sent';
          },
        ) => void,
      ): CollaborationCreateCommentResult | null => {
        const comment = {
          id: 'comment-1',
          nodeId: input.nodeId,
          authorId: 'editor-1',
          body: input.body,
          createdAt: NOW,
        };
        const candidate = {
          ...safeSnapshot(),
          comments: { [comment.id]: comment },
        };
        const receipt = {
          deliveryId: '00000000-0000-4000-8000-000000000098',
          snapshotDigest: 'b'.repeat(64),
          disposition: 'sent' as const,
        };
        beforeApply?.(candidate, comment, receipt);
        currentSnapshot = candidate;
        return { comment, receipt };
      },
    ),
    replayComments: vi.fn(
      (
        comments: readonly CollaborationMetadataSnapshot['comments'][string][],
        beforeApply?: (
          snapshot: CollaborationMetadataSnapshot,
          receipt: {
            readonly deliveryId: string;
            readonly snapshotDigest: string;
            readonly disposition: 'sent';
          },
        ) => void,
      ) => {
        const candidate = {
          ...currentSnapshot,
          comments: {
            ...currentSnapshot.comments,
            ...Object.fromEntries(comments.map((comment) => [comment.id, comment])),
          },
        };
        const receipt = {
          deliveryId: '00000000-0000-4000-8000-000000000097',
          snapshotDigest: 'c'.repeat(64),
          disposition: 'sent' as const,
        };
        beforeApply?.(candidate, receipt);
        currentSnapshot = candidate;
        return receipt;
      },
    ),
    setRejectedCommentSuppressions: vi.fn(
      (
        comments: readonly CollaborationMetadataSnapshot['comments'][string][],
        baseline: CollaborationMetadataSnapshot | null = null,
      ) => {
        suppressedComments = [...comments];
        suppressionBaseline = baseline;
      },
    ),
    updateAwareness: vi.fn(() => true),
    onEvent: vi.fn((listener: (event: CollaborationEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
    emit: (event: CollaborationEvent) => {
      for (const listener of listeners) listener(event);
    },
    setSnapshot: (snapshot: CollaborationMetadataSnapshot) => {
      currentSnapshot = snapshot;
    },
  };
}

function safeSnapshot(): CollaborationMetadataSnapshot {
  return {
    canvas: { id: CANVAS_ID, title: 'Canvas', version: 1, updatedAt: NOW },
    nodes: {
      'node-1': {
        id: 'node-1',
        type: 'task',
        title: 'Task',
        position: { x: 1, y: 2 },
      },
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
  const stageCollaborationSyncState = vi.fn(
    (
      _scope: unknown,
      baseline: CollaborationMetadataSnapshot | null,
      pending: CollaborationMetadataSnapshot,
    ) => ({
      baseline,
      pending,
      disposition: 'staged' as const,
      expiresAt: NOW,
    }),
  );
  const recordCollaborationSyncDelivery = vi.fn();
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
    stageCollaborationSyncState,
    stageCollaborationSyncDelivery: vi.fn(
      (
        scope: unknown,
        baseline: CollaborationMetadataSnapshot | null,
        pending: CollaborationMetadataSnapshot,
        receipt: CollaborationPublishReceipt,
      ) => {
        stageCollaborationSyncState(scope, baseline, pending);
        recordCollaborationSyncDelivery(scope, receipt);
        return {
          baseline,
          pending,
          deliveryId: receipt.deliveryId,
          snapshotDigest: receipt.snapshotDigest,
          disposition: receipt.disposition,
          expiresAt: NOW,
        };
      },
    ),
    checkpointCollaborationSyncState: vi.fn(
      (_scope: unknown, snapshot: CollaborationMetadataSnapshot): CollaborationSyncRecovery => ({
        baseline: snapshot,
        pending: snapshot,
        disposition: 'synchronized',
        expiresAt: NOW,
      }),
    ),
    discardRejectedCollaborationComment: vi.fn(
      (): CollaborationSyncRecovery => ({
        baseline: null,
        pending: safeSnapshot(),
        disposition: 'rejected',
        rejectedCommentIds: [],
        rejectedComments: [],
        rejectedCommentEntries: [],
        dismissedRejectedComments: [],
        expiresAt: NOW,
      }),
    ),
    recordCollaborationSyncDelivery,
    settleCollaborationSyncDelivery: vi.fn(),
  };
}
