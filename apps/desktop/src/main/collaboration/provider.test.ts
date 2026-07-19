import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const hocuspocus = vi.hoisted(() => ({
  configuration: null as ({ readonly onOpen?: () => void } & Record<string, unknown>) | null,
}));

vi.mock('@hocuspocus/provider', () => ({
  WebSocketStatus: {
    Connecting: 'connecting',
    Connected: 'connected',
    Disconnected: 'disconnected',
  },
  HocuspocusProvider: class {
    public awareness = {
      setLocalState: vi.fn(),
      getStates: vi.fn(() => new Map()),
    };
    public configuration: { readonly onOpen?: () => void } & Record<string, unknown>;

    public constructor(configuration: { readonly onOpen?: () => void } & Record<string, unknown>) {
      this.configuration = configuration;
      hocuspocus.configuration = configuration;
    }

    public sendStateless = vi.fn();
    public disconnect = vi.fn();
    public destroy = vi.fn();
  },
}));

import { createHocuspocusCollaborationProvider } from './provider.js';

beforeEach(() => {
  hocuspocus.configuration = null;
});

describe('Hocuspocus collaboration transport authorization', () => {
  it('authorizes metadata-only initial and reconnect sync plus awareness before socket-open work', () => {
    const authorizeTransportEffect = vi.fn();
    const document = new Y.Doc();
    createHocuspocusCollaborationProvider({
      document,
      serverUrl: 'wss://collaboration.example.test/team',
      roomId: 'room-1',
      accessToken: 'opaque-token',
      reconnect: true,
      initialAwareness: {
        user: {
          id: 'editor-1',
          displayName: 'Editor',
          color: '#6d5efc',
          role: 'editor',
        },
      },
      authorizeTransportEffect,
      onAuthenticated: vi.fn(),
      onAuthenticationFailed: vi.fn(),
      onStatus: vi.fn(),
      onSynced: vi.fn(),
      onDisconnect: vi.fn(),
      onAwarenessChange: vi.fn(),
      onStateless: vi.fn(),
    });
    const onOpen = hocuspocus.configuration?.onOpen;
    if (typeof onOpen !== 'function') throw new Error('Missing provider onOpen callback.');

    onOpen();
    onOpen();

    expect(authorizeTransportEffect.mock.calls).toEqual([
      [{ kind: 'document-sync', phase: 'initial', connectionAttempt: 0 }],
      [{ kind: 'awareness', phase: 'initial', connectionAttempt: 0 }],
      [{ kind: 'document-sync', phase: 'reconnect', connectionAttempt: 1 }],
      [{ kind: 'awareness', phase: 'reconnect', connectionAttempt: 1 }],
    ]);
    expect(JSON.stringify(authorizeTransportEffect.mock.calls)).not.toContain('opaque-token');
  });

  it('propagates required-audit failure so Hocuspocus cannot continue its open sequence', () => {
    const document = new Y.Doc();
    createHocuspocusCollaborationProvider({
      document,
      serverUrl: 'wss://collaboration.example.test/team',
      roomId: 'room-1',
      accessToken: 'opaque-token',
      reconnect: true,
      initialAwareness: {
        user: {
          id: 'editor-1',
          displayName: 'Editor',
          color: '#6d5efc',
          role: 'editor',
        },
      },
      authorizeTransportEffect: () => {
        throw new Error('required audit unavailable');
      },
      onAuthenticated: vi.fn(),
      onAuthenticationFailed: vi.fn(),
      onStatus: vi.fn(),
      onSynced: vi.fn(),
      onDisconnect: vi.fn(),
      onAwarenessChange: vi.fn(),
      onStateless: vi.fn(),
    });
    const onOpen = hocuspocus.configuration?.onOpen;
    if (typeof onOpen !== 'function') throw new Error('Missing provider onOpen callback.');

    expect(() => onOpen()).toThrow('required audit unavailable');
  });
});
