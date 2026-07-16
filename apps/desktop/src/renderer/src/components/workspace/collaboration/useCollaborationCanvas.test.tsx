// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import type {
  CollaborationEvent,
  CollaborationConnection,
  CollaborationMetadataSnapshot,
  CollaborationPublishInput,
} from '../../../../../shared/collaboration/index.js';
import { CollaborationMetadataSnapshotSchema } from '../../../../../shared/collaboration/index.js';
import { useCollaborationCanvas } from './useCollaborationCanvas.js';

const NOW = '2026-07-15T12:00:00.000Z';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000010';
const publish = vi.fn((input: CollaborationPublishInput) => {
  void input;
  return Promise.resolve({ ok: true as const, value: true });
});
const updateAwareness = vi.fn(() => Promise.resolve({ ok: true as const, value: true }));
const readSnapshot = vi.fn(() =>
  Promise.resolve({
    ok: true as const,
    value: null as CollaborationMetadataSnapshot | null,
  }),
);
const getConnection = vi.fn<() => Promise<{ ok: true; value: CollaborationConnection | null }>>(
  () => Promise.resolve({ ok: true, value: null }),
);
const onSnapshot = vi.fn(() => true);
const onError = vi.fn();
let eventListener: ((event: CollaborationEvent) => void) | null = null;

beforeEach(() => {
  publish.mockClear();
  updateAwareness.mockClear();
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
        'Collaboration paused because local and room metadata both changed since the last synchronized state.',
      ),
    );
    expect(onSnapshot).toHaveBeenCalledTimes(appliedBeforeConflict);
    expect(publish).toHaveBeenCalledOnce();
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

  it('pauses instead of resurrecting or overwriting nodes when a reconnect snapshot changed', async () => {
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
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Collaboration paused because the room changed while disconnected and has no delivery acknowledgement to resolve it safely.',
      ),
    );
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
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

function metadataEvent(snapshot: CollaborationMetadataSnapshot): CollaborationEvent {
  return {
    type: 'metadata-snapshot',
    sequence: 3,
    occurredAt: NOW,
    connectionId: CONNECTION_ID,
    roomId: 'launch-room',
    snapshot,
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
