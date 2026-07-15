// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import type {
  CollaborationEvent,
  CollaborationPublishInput,
} from '../../../../../shared/collaboration/index.js';
import { useCollaborationCanvas } from './useCollaborationCanvas.js';

const NOW = '2026-07-15T12:00:00.000Z';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000010';
const publish = vi.fn((input: CollaborationPublishInput) => {
  void input;
  return Promise.resolve({ ok: true as const, value: true });
});
const updateAwareness = vi.fn(() => Promise.resolve({ ok: true as const, value: true }));
const onError = vi.fn();
let eventListener: ((event: CollaborationEvent) => void) | null = null;

beforeEach(() => {
  publish.mockClear();
  updateAwareness.mockClear();
  onError.mockClear();
  eventListener = null;
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      collaboration: {
        get: vi.fn(() => Promise.resolve({ ok: true, value: null })),
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
  it('publishes only the canonical privacy projection after authenticated sync completes', async () => {
    renderHook(() =>
      useCollaborationCanvas({
        enabled: true,
        document: canvas(),
        selectedNodeId: 'agent-1',
        onError,
        debounceMs: 0,
      }),
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    expect(publish).not.toHaveBeenCalled();

    act(() => eventListener?.(connectingEvent()));
    expect(publish).not.toHaveBeenCalled();
    expect(updateAwareness).not.toHaveBeenCalled();

    act(() => eventListener?.(statusEvent('reconnecting')));
    expect(publish).not.toHaveBeenCalled();
    expect(updateAwareness).not.toHaveBeenCalled();

    act(() => eventListener?.(statusEvent('connected')));

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

function connectingEvent(): CollaborationEvent {
  return statusEvent('connecting');
}

function statusEvent(status: 'connecting' | 'connected' | 'reconnecting'): CollaborationEvent {
  return {
    type: 'status-changed',
    sequence: 1,
    occurredAt: NOW,
    connectionId: CONNECTION_ID,
    roomId: 'launch-room',
    connection: {
      connectionId: CONNECTION_ID,
      serverUrl: 'wss://collaboration.example.test/team',
      roomId: 'launch-room',
      subject: 'editor-1',
      displayName: 'Local editor',
      color: '#6d5efc',
      status,
      reconnect: true,
      reconnectAttempt: 0,
      lastTransitionAt: NOW,
    },
  };
}
