// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import type {
  CollaborationEvent,
  CollaborationConnection,
  CollaborationMetadataSnapshot,
  CollaborationPublishInput,
  CollaborationSyncRecovery,
  CollaborationCreateCommentResult,
} from '../../../../../shared/collaboration/index.js';
import { CollaborationMetadataSnapshotSchema } from '../../../../../shared/collaboration/index.js';
import { useCollaborationCanvas } from './useCollaborationCanvas.js';

const NOW = '2026-07-15T12:00:00.000Z';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000010';
let nextDelivery = 20;
const publish = vi.fn((input: CollaborationPublishInput) => {
  void input;
  return Promise.resolve({
    ok: true as const,
    value: {
      deliveryId: deliveryId(nextDelivery++),
      snapshotDigest: 'a'.repeat(64),
      disposition: 'sent' as const,
    },
  });
});
const updateAwareness = vi.fn(() => Promise.resolve({ ok: true as const, value: true }));
const recover = vi.fn(() =>
  Promise.resolve({
    ok: true as const,
    value: null as CollaborationSyncRecovery | null,
  }),
);
const checkpoint = vi.fn(() => Promise.resolve({ ok: true as const, value: true }));
const createComment = vi.fn(() =>
  Promise.resolve({
    ok: true as const,
    value: null as CollaborationCreateCommentResult | null,
  }),
);
const discardRejectedComment = vi.fn(() =>
  Promise.resolve({
    ok: true as const,
    value: null as CollaborationSyncRecovery | null,
  }),
);
const readSnapshot = vi.fn(() =>
  Promise.resolve({
    ok: true as const,
    value: null as CollaborationMetadataSnapshot | null,
  }),
);
const getConnection = vi.fn<() => Promise<{ ok: true; value: CollaborationConnection | null }>>(
  () => Promise.resolve({ ok: true, value: null }),
);
const onSnapshot = vi.fn(
  (snapshot: CollaborationMetadataSnapshot, context: { readonly initial: boolean }) => {
    void snapshot;
    void context;
    return true;
  },
);
const onError = vi.fn();
let eventListener: ((event: CollaborationEvent) => void) | null = null;

beforeEach(() => {
  publish.mockClear();
  nextDelivery = 20;
  updateAwareness.mockClear();
  recover.mockClear();
  checkpoint.mockClear();
  createComment.mockClear();
  discardRejectedComment.mockReset();
  discardRejectedComment.mockResolvedValue({ ok: true, value: null });
  readSnapshot.mockReset();
  readSnapshot.mockResolvedValue({ ok: true, value: null });
  getConnection.mockReset();
  getConnection.mockResolvedValue({ ok: true, value: null });
  onSnapshot.mockReset();
  onSnapshot.mockReturnValue(true);
  onError.mockClear();
  eventListener = null;
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      collaboration: {
        get: getConnection,
        snapshot: readSnapshot,
        join: vi.fn(),
        leave: vi.fn(),
        publish,
        recover,
        checkpoint,
        discardRejectedComment,
        createComment,
        updateAwareness,
        onEvent: vi.fn((listener: (event: CollaborationEvent) => void) => {
          eventListener = listener;
          return () => {
            eventListener = null;
          };
        }),
      },
    },
  });
});

afterEach(cleanup);

describe('useCollaborationCanvas', () => {
  it('waits for the authenticated room snapshot before publishing the privacy projection', async () => {
    renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: 'agent-1',
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    expect(publish).not.toHaveBeenCalled();

    act(() => eventListener?.(statusEvent('connecting')));
    act(() => eventListener?.(statusEvent('reconnecting')));
    expect(publish).not.toHaveBeenCalled();
    expect(updateAwareness).not.toHaveBeenCalled();

    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(readSnapshot).toHaveBeenCalledOnce());
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const payload = publish.mock.calls[0]?.[0];
    expect(payload?.snapshot.nodes['agent-1']).toMatchObject({
      id: 'agent-1',
      type: 'agent',
      title: 'Agent',
      position: { x: 10, y: 20 },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('PROMPT_DO_NOT_SHARE');
    expect(serialized).not.toContain('/Users/private/repository');
    expect(serialized).not.toContain('TOKEN_DO_NOT_SHARE');
    await waitFor(() =>
      expect(updateAwareness).toHaveBeenCalledWith({
        awareness: {
          selection: { nodeIds: ['agent-1'] },
          activity: { nodeId: 'agent-1', status: 'editing' },
        },
      }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('applies the current room before publishing when mounted after connection', async () => {
    getConnection.mockResolvedValue({ ok: true, value: connectedConnection() });
    readSnapshot.mockResolvedValue({ ok: true, value: roomSnapshot() });

    renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );

    await waitFor(() =>
      expect(onSnapshot).toHaveBeenCalledWith(roomSnapshot(), {
        initial: true,
      }),
    );
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish.mock.calls[0]?.[0].snapshot.workflow).toHaveProperty('workflow-1');
    expect(readSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      publish.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('renders only remote awareness and throttles cursors without dropping selection', async () => {
    const hook = renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: 'agent-1',
        onSnapshot,
        onError,
        debounceMs: 0,
        cursorIntervalMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(updateAwareness).toHaveBeenCalled());
    updateAwareness.mockClear();

    act(() =>
      eventListener?.({
        type: 'awareness-changed',
        sequence: 2,
        occurredAt: NOW,
        connectionId: CONNECTION_ID,
        roomId: 'launch-room',
        states: [
          awarenessEntry(1, 'editor-1', 'Local editor'),
          awarenessEntry(2, 'editor-2', 'Remote editor'),
        ],
        removedClientIds: [],
      }),
    );
    expect(hook.result.current.awareness).toHaveLength(1);
    expect(hook.result.current.awareness[0]?.state.user.id).toBe('editor-2');

    act(() => hook.result.current.updateCursor({ x: 140, y: 260 }));
    await waitFor(() =>
      expect(updateAwareness).toHaveBeenCalledWith({
        awareness: {
          cursor: { x: 140, y: 260 },
          selection: { nodeIds: ['agent-1'] },
          activity: { nodeId: 'agent-1', status: 'editing' },
        },
      }),
    );

    updateAwareness.mockClear();
    act(() => hook.result.current.clearCursor());
    await waitFor(() =>
      expect(updateAwareness).toHaveBeenCalledWith({
        awareness: {
          selection: { nodeIds: ['agent-1'] },
          activity: { nodeId: 'agent-1', status: 'editing' },
        },
      }),
    );
  });

  it('fails closed until a room snapshot can be applied after local canvas loading', async () => {
    let currentDocument: CanvasDocument | null = null;
    onSnapshot.mockImplementation(() => currentDocument !== null);
    readSnapshot.mockResolvedValue({ ok: true, value: roomSnapshot() });
    const hook = renderHook(
      ({ document }: { document: CanvasDocument | null }) =>
        useCollaborationCanvas({
          enabled: true,
          document,
          selectedNodeId: null,
          onSnapshot,
          onError,
          debounceMs: 0,
        }),
      { initialProps: { document: currentDocument as CanvasDocument | null } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
    expect(publish).not.toHaveBeenCalled();
    expect(updateAwareness).not.toHaveBeenCalled();

    currentDocument = canvas();
    hook.rerender({ document: currentDocument });
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  });

  it('does not publish when the active room snapshot is rejected', async () => {
    onSnapshot.mockReturnValue(false);
    readSnapshot.mockResolvedValue({ ok: true, value: roomSnapshot() });
    renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(publish).not.toHaveBeenCalled();
    expect(updateAwareness).not.toHaveBeenCalled();
  });

  it('seeds a different empty room even when the canvas fingerprint is unchanged', async () => {
    renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());

    act(() => eventListener?.(statusEvent('reconnecting')));
    act(() =>
      eventListener?.(
        statusEvent('connected', 'editor', '00000000-0000-4000-8000-000000000011', 'second-room'),
      ),
    );
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
  });

  it('pauses instead of overwriting when local and room metadata change concurrently', async () => {
    const hook = renderHook(
      ({ document, debounceMs }: { document: CanvasDocument; debounceMs: number }) =>
        useCollaborationCanvas({
          enabled: true,
          document,
          selectedNodeId: null,
          onSnapshot,
          onError,
          debounceMs,
        }),
      { initialProps: { document: canvas(), debounceMs: 0 } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const baseline = publish.mock.calls[0]?.[0].snapshot;
    if (baseline === undefined) throw new Error('Missing published baseline.');
    act(() => eventListener?.(metadataEvent(baseline)));
    const appliedBeforeConflict = onSnapshot.mock.calls.length;

    hook.rerender({
      document: changedCanvas('Local unsent title'),
      debounceMs: 1_000,
    });
    act(() =>
      eventListener?.(
        metadataEvent(
          CollaborationMetadataSnapshotSchema.parse({
            ...baseline,
            canvas: { ...baseline.canvas, title: 'Remote concurrent title' },
          }),
        ),
      ),
    );

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Sharing paused because this device and the shared canvas both changed since they were last in sync.',
      ),
    );
    expect(onSnapshot).toHaveBeenCalledTimes(appliedBeforeConflict);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('ignores local Yjs echoes and continues publishing successive online edits', async () => {
    const hook = renderHook(
      ({ document }: { document: CanvasDocument }) =>
        useCollaborationCanvas({
          enabled: true,
          document,
          selectedNodeId: null,
          onSnapshot,
          onError,
          debounceMs: 0,
        }),
      { initialProps: { document: canvas() } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const baseline = publish.mock.calls[0]?.[0].snapshot;
    if (baseline === undefined) throw new Error('Missing online baseline.');
    act(() => eventListener?.(metadataEvent(baseline)));
    act(() => eventListener?.(deliveryAcknowledgedEvent(20, false)));

    hook.rerender({ document: changedCanvas('First online edit') });
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    const firstEdit = publish.mock.calls[1]?.[0].snapshot;
    if (firstEdit === undefined) throw new Error('Missing first online edit.');
    act(() => eventListener?.(metadataEvent(firstEdit, 'local')));
    act(() => eventListener?.(deliveryAcknowledgedEvent(21, false)));

    hook.rerender({ document: changedCanvas('Second online edit') });
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(3));
    expect(onError).not.toHaveBeenCalled();
  });

  it('applies a deliberate A to B to A remote rollback instead of suppressing historical state', async () => {
    const hook = renderHook(
      ({ document, debounceMs }: { document: CanvasDocument; debounceMs: number }) =>
        useCollaborationCanvas({
          enabled: true,
          document,
          selectedNodeId: null,
          onSnapshot,
          onError,
          debounceMs,
        }),
      { initialProps: { document: canvas(), debounceMs: 0 } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const stateA = publish.mock.calls[0]?.[0].snapshot;
    if (stateA === undefined) throw new Error('Missing state A.');
    act(() => eventListener?.(metadataEvent(stateA)));

    const stateB = CollaborationMetadataSnapshotSchema.parse({
      ...stateA,
      canvas: { ...stateA.canvas, title: 'State B' },
    });
    act(() => eventListener?.(metadataEvent(stateB)));
    hook.rerender({ document: changedCanvas('State B'), debounceMs: 1_000 });
    const callsBeforeRollback = onSnapshot.mock.calls.length;

    act(() => eventListener?.(metadataEvent(stateA)));
    expect(onSnapshot).toHaveBeenCalledTimes(callsBeforeRollback + 1);
    expect(onSnapshot).toHaveBeenLastCalledWith(stateA, { initial: false });
  });

  it('applies remote deletions after reconnect when the local graph stayed synchronized', async () => {
    renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const baseline = publish.mock.calls[0]?.[0].snapshot;
    if (baseline === undefined) throw new Error('Missing reconnect baseline.');
    act(() => eventListener?.(metadataEvent(baseline)));
    onSnapshot.mockClear();
    const deleted = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      nodes: {},
      edges: {},
      tasks: {},
      comments: {},
      workflow: {},
      reviews: {},
    });
    readSnapshot.mockResolvedValue({ ok: true, value: deleted });

    act(() => eventListener?.(statusEvent('reconnecting')));
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(deleted, { initial: false }));
    expect(onError).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('queues an offline editor change and applies the acknowledged Yjs merge on reconnect', async () => {
    const hook = renderHook(
      ({ document }: { document: CanvasDocument }) =>
        useCollaborationCanvas({
          enabled: true,
          document,
          selectedNodeId: null,
          onSnapshot,
          onError,
          debounceMs: 0,
        }),
      { initialProps: { document: canvas() } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const baseline = publish.mock.calls[0]?.[0].snapshot;
    if (baseline === undefined) throw new Error('Missing reconnect baseline.');
    act(() => eventListener?.(metadataEvent(baseline)));
    act(() => eventListener?.(deliveryAcknowledgedEvent(20, false)));

    act(() => eventListener?.(statusEvent('reconnecting')));
    hook.rerender({ document: changedCanvas('Offline editor title') });
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    const offlineProjection = publish.mock.calls[1]?.[0].snapshot;
    if (offlineProjection === undefined) throw new Error('Missing offline projection.');
    const merged = CollaborationMetadataSnapshotSchema.parse({
      ...offlineProjection,
      comments: {
        'remote-comment': {
          id: 'remote-comment',
          nodeId: 'agent-1',
          authorId: 'remote-editor',
          body: 'Remote reconnect note',
          resolved: false,
          createdAt: NOW,
        },
      },
    });
    readSnapshot.mockResolvedValue({ ok: true, value: merged });
    act(() => eventListener?.(deliveryAcknowledgedEvent(21, true)));
    act(() => eventListener?.(statusEvent('connected')));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(merged, { initial: false }));
    expect(onError).not.toHaveBeenCalled();
  });

  it('pauses when a same-field room edit wins over acknowledged offline intent', async () => {
    const hook = renderHook(
      ({ document }: { document: CanvasDocument }) =>
        useCollaborationCanvas({
          enabled: true,
          document,
          selectedNodeId: null,
          onSnapshot,
          onError,
          debounceMs: 0,
        }),
      { initialProps: { document: canvas() } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const baseline = publish.mock.calls[0]?.[0].snapshot;
    if (baseline === undefined) throw new Error('Missing conflict baseline.');
    act(() => eventListener?.(metadataEvent(baseline)));
    act(() => eventListener?.(deliveryAcknowledgedEvent(20, false)));
    onSnapshot.mockClear();

    act(() => eventListener?.(statusEvent('reconnecting')));
    hook.rerender({ document: changedCanvas('Offline intent') });
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    const offlineProjection = publish.mock.calls[1]?.[0].snapshot;
    if (offlineProjection === undefined) throw new Error('Missing offline conflict projection.');
    readSnapshot.mockResolvedValue({
      ok: true,
      value: CollaborationMetadataSnapshotSchema.parse({
        ...offlineProjection,
        canvas: { ...offlineProjection.canvas, title: 'Remote winner' },
      }),
    });
    act(() => eventListener?.(deliveryAcknowledgedEvent(21, true)));
    act(() => eventListener?.(statusEvent('connected')));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Sharing paused because an offline change clashed with shared canvas changes while reconnecting.',
      ),
    );
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('pauses when an offline editor change is not durably acknowledged', async () => {
    const hook = renderHook(
      ({ document }: { document: CanvasDocument }) =>
        useCollaborationCanvas({
          enabled: true,
          document,
          selectedNodeId: null,
          onSnapshot,
          onError,
          debounceMs: 0,
        }),
      { initialProps: { document: canvas() } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const baseline = publish.mock.calls[0]?.[0].snapshot;
    if (baseline === undefined) throw new Error('Missing reconnect baseline.');
    act(() => eventListener?.(metadataEvent(baseline)));
    act(() => eventListener?.(deliveryAcknowledgedEvent(20, false)));
    onSnapshot.mockClear();

    act(() => eventListener?.(statusEvent('reconnecting')));
    hook.rerender({ document: changedCanvas('Unacknowledged offline title') });
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    readSnapshot.mockResolvedValue({ ok: true, value: baseline });
    act(() => eventListener?.(deliveryRejectedEvent(21)));
    act(() => eventListener?.(statusEvent('connected')));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Sharing paused because the shared canvas did not confirm your offline changes after reconnecting.',
      ),
    );
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('keeps reviewer and viewer roles presence-only and never publishes graph metadata', async () => {
    readSnapshot.mockResolvedValue({ ok: true, value: roomSnapshot() });
    const hook = renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected', 'viewer')));

    await waitFor(() =>
      expect(onSnapshot).toHaveBeenCalledWith(roomSnapshot(), {
        initial: false,
      }),
    );
    await waitFor(() => expect(updateAwareness).toHaveBeenCalled());
    expect(hook.result.current.graphReadOnly).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps viewer authority during reconnect and reapplies an unchanged room snapshot', async () => {
    readSnapshot.mockResolvedValue({ ok: true, value: roomSnapshot() });
    const hook = renderHook(
      ({ document }: { document: CanvasDocument }) =>
        useCollaborationCanvas({
          enabled: true,
          document,
          selectedNodeId: null,
          onSnapshot,
          onError,
          debounceMs: 0,
        }),
      { initialProps: { document: canvas() } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected', 'viewer')));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
    expect(hook.result.current.graphReadOnly).toBe(true);

    act(() => eventListener?.(statusEvent('reconnecting', 'viewer')));
    expect(hook.result.current.graphReadOnly).toBe(true);
    hook.rerender({
      document: changedCanvas('Unauthorized local viewer edit'),
    });
    act(() => eventListener?.(statusEvent('connected', 'viewer')));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));
    expect(onSnapshot).toHaveBeenLastCalledWith(roomSnapshot(), {
      initial: false,
    });
    expect(hook.result.current.graphReadOnly).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it('retains offline viewer authority until the joined session is actually left', async () => {
    readSnapshot.mockResolvedValue({ ok: true, value: roomSnapshot() });
    const hook = renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected', 'viewer')));
    await waitFor(() => expect(hook.result.current.graphReadOnly).toBe(true));

    getConnection.mockResolvedValue({
      ok: true,
      value: pendingConnection('offline'),
    });
    act(() => eventListener?.(statusEvent('offline', 'viewer')));
    await waitFor(() => expect(getConnection).toHaveBeenCalledTimes(2));
    expect(hook.result.current.graphReadOnly).toBe(true);

    getConnection.mockResolvedValue({ ok: true, value: null });
    act(() => eventListener?.(statusEvent('offline', 'viewer')));
    await waitFor(() => expect(hook.result.current.graphReadOnly).toBe(false));
  });

  it('clears viewer authority when collaboration is disabled', async () => {
    readSnapshot.mockResolvedValue({ ok: true, value: roomSnapshot() });
    const hook = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useCollaborationCanvas({
          enabled,
          document: canvas(),
          selectedNodeId: null,
          onSnapshot,
          onError,
          debounceMs: 0,
        }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected', 'viewer')));
    await waitFor(() => expect(hook.result.current.graphReadOnly).toBe(true));

    hook.rerender({ enabled: false });
    await waitFor(() => expect(hook.result.current.graphReadOnly).toBe(false));
  });

  it('restores a durable disjoint local intent against the authenticated room after restart', async () => {
    const baseline = roomSnapshot();
    const pending = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      canvas: { ...baseline.canvas, updatedAt: '2026-07-15T12:01:00.000Z' },
      nodes: {
        ...baseline.nodes,
        'agent-1': {
          ...baseline.nodes['agent-1'],
          title: 'Local restart title',
        },
      },
    });
    const remote = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      canvas: {
        ...baseline.canvas,
        title: 'Remote canvas title',
        updatedAt: '2026-07-15T12:02:00.000Z',
      },
    });
    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline,
        pending,
        disposition: 'staged',
        expiresAt: '2026-08-14T12:00:00.000Z',
      },
    });
    readSnapshot.mockResolvedValueOnce({ ok: true, value: remote });
    renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalled());
    const applied = onSnapshot.mock.calls.at(-1);
    expect(applied?.[0].canvas.title).toBe('Remote canvas title');
    expect(applied?.[0].nodes['agent-1']?.title).toBe('Local restart title');
    expect(applied?.[1]).toEqual({ initial: false });
    expect(onError).not.toHaveBeenCalledWith(expect.stringMatching(/conflict/u));
  });

  it('pauses a durable same-field restart conflict without checkpointing it away', async () => {
    const baseline = roomSnapshot();
    const pending = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      canvas: { ...baseline.canvas, title: 'Local restart title' },
    });
    const remote = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      canvas: { ...baseline.canvas, title: 'Remote restart title' },
    });
    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline,
        pending,
        disposition: 'staged',
        expiresAt: '2026-08-14T12:00:00.000Z',
      },
    });
    readSnapshot.mockResolvedValueOnce({ ok: true, value: remote });
    renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/clash/u)));
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('retains recovered graph intent locally after a role downgrade without replaying it', async () => {
    const baseline = roomSnapshot();
    const pending = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      nodes: {
        ...baseline.nodes,
        'agent-1': {
          ...baseline.nodes['agent-1'],
          title: 'Privileged offline edit',
        },
      },
    });
    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline,
        pending,
        disposition: 'queued-offline',
        deliveryId: deliveryId(89),
        snapshotDigest: 'c'.repeat(64),
        expiresAt: '2026-08-14T12:00:00.000Z',
      },
    });
    readSnapshot.mockResolvedValueOnce({ ok: true, value: baseline });
    renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected', 'viewer')));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(baseline, { initial: false }));
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/saved on this device/u));
    expect(publish).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('does not checkpoint an authenticated snapshot while its local delivery is unacknowledged', async () => {
    readSnapshot.mockResolvedValue({ ok: true, value: roomSnapshot() });
    const hook = renderHook(
      ({ document }: { document: CanvasDocument }) =>
        useCollaborationCanvas({
          enabled: true,
          document,
          selectedNodeId: null,
          onSnapshot,
          onError,
          debounceMs: 0,
        }),
      { initialProps: { document: canvas() } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    act(() => eventListener?.(deliveryAcknowledgedEvent(20, false)));
    await waitFor(() => expect(readSnapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(checkpoint).toHaveBeenCalled());
    checkpoint.mockClear();
    publish.mockClear();

    hook.rerender({ document: changedCanvas('Pending local title') });
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const published = publish.mock.calls[0]?.[0].snapshot;
    if (published === undefined) throw new Error('Missing published snapshot.');
    readSnapshot.mockResolvedValue({ ok: true, value: published });
    act(() => eventListener?.(metadataEvent(published)));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(published, { initial: false }));
    expect(checkpoint).not.toHaveBeenCalled();

    act(() => eventListener?.(deliveryAcknowledgedEvent(21, false)));
    await waitFor(() =>
      expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ snapshot: published })),
    );
  });

  it('reattaches an in-flight graph receipt by digest without confusing its serialized dedupe key', async () => {
    const hook = renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const pending = publish.mock.calls[0]?.[0].snapshot;
    if (pending === undefined) throw new Error('Missing graph delivery candidate.');
    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline: null,
        pending,
        deliveryId: deliveryId(20),
        snapshotDigest: 'a'.repeat(64),
        disposition: 'sent',
        expiresAt: '2026-08-14T12:00:00.000Z',
        replayedReceipt: {
          deliveryId: deliveryId(20),
          snapshotDigest: 'a'.repeat(64),
          disposition: 'sent',
        },
      },
    });

    act(() => eventListener?.(statusEvent('reconnecting')));
    act(() => eventListener?.(statusEvent('connected')));

    await waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.canComment).toBe(true));
    expect(onError).not.toHaveBeenCalledWith(
      'Sharing paused because a saved delivery record did not match while restoring offline changes.',
    );
    act(() => eventListener?.(deliveryAcknowledgedEvent(20, true)));
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not republish a recovered graph receipt after the renderer remounts', async () => {
    const first = renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const pending = publish.mock.calls[0]?.[0].snapshot;
    if (pending === undefined) throw new Error('Missing graph delivery candidate.');
    first.unmount();

    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline: null,
        pending,
        deliveryId: deliveryId(20),
        snapshotDigest: 'a'.repeat(64),
        disposition: 'sent',
        expiresAt: '2026-08-14T12:00:00.000Z',
        replayedReceipt: {
          deliveryId: deliveryId(20),
          snapshotDigest: 'a'.repeat(64),
          disposition: 'sent',
        },
      },
    });
    readSnapshot.mockResolvedValueOnce({ ok: true, value: pending });
    const remounted = renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: null,
        onSnapshot,
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected')));

    await waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(remounted.result.current.canComment).toBe(true));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(publish).toHaveBeenCalledOnce();
    act(() => eventListener?.(deliveryAcknowledgedEvent(20, false)));
    expect(onError).not.toHaveBeenCalled();
  });
});

function canvas(): CanvasDocument {
  return {
    id: '00000000-0000-4000-8000-000000000030',
    projectId: '00000000-0000-4000-8000-000000000031',
    name: 'Workshop',
    nodes: [
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 10, y: 20 },
        width: 320,
        height: 180,
        data: {
          kind: 'agent',
          title: 'Agent',
          color: '#445566',
          prompt: 'PROMPT_DO_NOT_SHARE',
          repositoryPath: '/Users/private/repository',
          token: 'TOKEN_DO_NOT_SHARE',
        },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW,
  };
}

function changedCanvas(title: string): CanvasDocument {
  return { ...canvas(), name: title };
}

function roomSnapshot(): CollaborationMetadataSnapshot {
  return CollaborationMetadataSnapshotSchema.parse({
    canvas: {
      id: '00000000-0000-4000-8000-000000000030',
      title: 'Shared workshop',
      version: 1,
      updatedAt: NOW,
    },
    nodes: {
      'agent-1': {
        id: 'agent-1',
        type: 'agent',
        title: 'Shared agent',
        position: { x: 10, y: 20 },
      },
    },
    edges: {},
    groups: {},
    tasks: {},
    comments: {},
    workflow: {
      'workflow-1': {
        id: 'workflow-1',
        nodeId: 'agent-1',
        status: 'running',
        updatedAt: NOW,
      },
    },
    reviews: {},
  });
}

function awarenessEntry(clientId: number, id: string, displayName: string) {
  return {
    clientId,
    state: {
      user: { id, displayName, color: '#6d5efc', role: 'editor' as const },
      cursor: { x: 10, y: 20 },
      selection: { nodeIds: ['agent-1'] },
      activity: { nodeId: 'agent-1', status: 'editing' as const },
    },
  };
}

function metadataEvent(
  snapshot: CollaborationMetadataSnapshot,
  source: 'local' | 'remote' = 'remote',
): CollaborationEvent {
  return {
    type: 'metadata-snapshot',
    sequence: 3,
    occurredAt: NOW,
    connectionId: CONNECTION_ID,
    roomId: 'launch-room',
    source,
    snapshot,
  };
}

function deliveryId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function deliveryAcknowledgedEvent(
  sequence: number,
  reconciledAfterReconnect: boolean,
): CollaborationEvent {
  return {
    type: 'delivery-acknowledged',
    sequence: 4,
    occurredAt: NOW,
    connectionId: CONNECTION_ID,
    roomId: 'launch-room',
    acknowledgement: {
      protocol: 'forgeboard.delivery.v1',
      type: 'delivery-acknowledged',
      deliveryId: deliveryId(sequence),
      stateVector: 'AQID',
      persistedAt: NOW,
    },
    reconciledAfterReconnect,
  };
}

function deliveryRejectedEvent(
  sequence: number,
  reason:
    | 'invalid-request'
    | 'not-authorized'
    | 'state-not-applied'
    | 'document-too-large' = 'state-not-applied',
  duringReconnect = true,
): CollaborationEvent {
  return {
    type: 'delivery-rejected',
    sequence: 5,
    occurredAt: NOW,
    connectionId: CONNECTION_ID,
    roomId: 'launch-room',
    rejection: {
      protocol: 'forgeboard.delivery.v1',
      type: 'delivery-rejected',
      deliveryId: deliveryId(sequence),
      stateVector: 'AQID',
      reason,
    },
    duringReconnect,
  };
}

function statusEvent(
  status: 'offline' | 'connecting' | 'connected' | 'reconnecting',
  role: 'owner' | 'editor' | 'reviewer' | 'viewer' = 'editor',
  connectionId = CONNECTION_ID,
  roomId = 'launch-room',
): CollaborationEvent {
  return {
    type: 'status-changed',
    sequence: 1,
    occurredAt: NOW,
    connectionId,
    roomId,
    connection:
      status === 'connected'
        ? connectedConnection(role, connectionId, roomId)
        : pendingConnection(status, connectionId, roomId),
  };
}

function connectedConnection(
  role: 'owner' | 'editor' | 'reviewer' | 'viewer' = 'editor',
  connectionId = CONNECTION_ID,
  roomId = 'launch-room',
) {
  return {
    ...pendingConnection('connected' as const, connectionId, roomId),
    role,
    connectedAt: NOW,
  };
}

function pendingConnection(
  status: 'offline' | 'connecting' | 'connected' | 'reconnecting',
  connectionId = CONNECTION_ID,
  roomId = 'launch-room',
) {
  return {
    connectionId,
    serverUrl: 'wss://collaboration.example.test/team',
    roomId,
    subject: 'editor-1',
    displayName: 'Local editor',
    color: '#6d5efc',
    status,
    reconnect: true,
    reconnectAttempt: 0,
    lastTransitionAt: NOW,
  };
}
