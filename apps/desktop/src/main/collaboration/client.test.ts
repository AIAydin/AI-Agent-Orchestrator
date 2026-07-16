import { describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';

import {
  CollaborationMetadataSnapshotSchema,
  type CollaborationAwarenessState,
  type CollaborationEvent,
  type CollaborationJoinInput,
} from '../../shared/collaboration/index.js';
import { CollaborationClient } from './client.js';
import type { CollaborationProviderFactoryInput, CollaborationProviderHandle } from './provider.js';

const NOW = '2026-07-15T12:00:00.000Z';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000010';

function joinInput(overrides: Partial<CollaborationJoinInput> = {}): CollaborationJoinInput {
  return {
    serverUrl: 'wss://collaboration.example.test/team',
    roomId: 'launch-room',
    subject: 'editor-1',
    displayName: 'Local editor',
    color: '#6d5efc',
    accessToken: accessToken(),
    reconnect: true,
    ...overrides,
  };
}

function accessToken(overrides: Record<string, unknown> = {}): string {
  const payload = {
    iss: 'forgeboard-collab',
    aud: 'forgeboard-collab-client',
    typ: 'access',
    jti: '00000000-0000-4000-8000-000000000020',
    roomId: 'launch-room',
    role: 'editor',
    sub: 'editor-1',
    ver: 1,
    iat: 1_768_435_200,
    exp: 1_999_999_999,
    ...overrides,
  };
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.TEST_SIGNATURE_SECRET`;
}

function snapshot() {
  return CollaborationMetadataSnapshotSchema.parse({
    canvas: {
      id: 'canvas-1',
      title: 'Safe canvas',
      version: 1,
      updatedAt: NOW,
    },
    nodes: {
      'task-1': {
        id: 'task-1',
        type: 'task',
        title: 'Safe task',
        position: { x: 1, y: 2 },
      },
    },
    edges: {},
    groups: {},
    tasks: { 'task-1': { id: 'task-1', title: 'Safe task', status: 'ready' } },
    comments: {},
    workflow: {},
    reviews: {},
  });
}

interface ProviderHarness {
  readonly factory: ReturnType<
    typeof vi.fn<(input: CollaborationProviderFactoryInput) => CollaborationProviderHandle>
  >;
  readonly clearCredential: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  input: CollaborationProviderFactoryInput | null;
  localAwareness: CollaborationAwarenessState | null;
  awareness: ReadonlyArray<{
    readonly clientId: number;
    readonly state: unknown;
  }>;
}

function providerHarness(): ProviderHarness {
  const harness: ProviderHarness = {
    input: null,
    localAwareness: null,
    awareness: [],
    clearCredential: vi.fn(),
    destroy: vi.fn(),
    factory: vi.fn(),
  };
  harness.factory.mockImplementation((input) => {
    harness.input = input;
    return {
      document: input.document,
      setLocalAwareness: (state) => {
        harness.localAwareness = state;
      },
      awarenessStates: () => harness.awareness,
      clearCredential: harness.clearCredential,
      destroy: harness.destroy,
    };
  });
  return harness;
}

async function connect(client: CollaborationClient, harness: ProviderHarness) {
  const pending = client.join(joinInput());
  expect(harness.input).not.toBeNull();
  harness.input?.onAuthenticated();
  harness.input?.onSynced();
  return await pending;
}

describe('CollaborationClient', () => {
  it('joins only after authentication and sync without exposing its credential', async () => {
    const provider = providerHarness();
    const events: CollaborationEvent[] = [];
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      now: () => new Date(NOW),
    });
    client.onEvent((event) => events.push(event));
    const token = joinInput().accessToken;

    const result = await connect(client, provider);

    expect(result).toMatchObject({
      ok: true,
      connection: {
        status: 'connected',
        role: 'editor',
        roomId: 'launch-room',
      },
    });
    expect(provider.input?.accessToken).toBe(token);
    expect(JSON.stringify({ result, connection: client.connection, events })).not.toContain(token);
    expect(client.snapshot).toBeNull();

    expect(client.publish(snapshot())).toBe(true);
    expect(client.snapshot).toEqual(snapshot());
    expect(
      client.updateAwareness({
        selection: { nodeIds: ['task-1'] },
        activity: { nodeId: 'task-1', status: 'editing' },
      }),
    ).toBe(true);
    expect(provider.localAwareness).toEqual({
      user: {
        id: 'editor-1',
        displayName: 'Local editor',
        color: '#6d5efc',
        role: 'editor',
      },
      selection: { nodeIds: ['task-1'] },
      activity: { nodeId: 'task-1', status: 'editing' },
    });

    provider.awareness = [{ clientId: 7, state: provider.localAwareness }];
    provider.input?.onAwarenessChange();
    expect(events.at(-1)).toMatchObject({
      type: 'awareness-changed',
      removedClientIds: [],
    });

    expect(client.leave()).toBeNull();
    expect(client.connection).toBeNull();
    expect(events.at(-1)).toMatchObject({
      type: 'status-changed',
      connection: { status: 'offline' },
    });
    expect(provider.clearCredential).toHaveBeenCalledOnce();
    expect(provider.destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('rejects malformed or mismatched access claims before creating a provider', async () => {
    const provider = providerHarness();
    const client = new CollaborationClient({
      createProvider: provider.factory,
    });

    await expect(client.join(joinInput({ accessToken: 'not-a-jwt' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-configuration' },
    });
    await expect(
      client.join(joinInput({ accessToken: accessToken({ roomId: 'another-room' }) })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-configuration' },
    });
    expect(provider.factory).not.toHaveBeenCalled();
  });

  it('returns to connected only after a reconnect authenticates and syncs', async () => {
    const provider = providerHarness();
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      now: () => new Date(NOW),
    });
    await connect(client, provider);

    provider.input?.onDisconnect();
    provider.input?.onStatus('connecting');
    expect(client.connection).toMatchObject({
      status: 'reconnecting',
      reconnectAttempt: 1,
    });

    provider.input?.onAuthenticated();
    expect(client.connection).toMatchObject({ status: 'reconnecting' });
    provider.input?.onSynced();
    expect(client.connection).toMatchObject({
      status: 'connected',
      reconnectAttempt: 1,
      role: 'editor',
    });
  });

  it('never publishes metadata or awareness before secure sync or during reconnect', async () => {
    const provider = providerHarness();
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      now: () => new Date(NOW),
    });
    const pending = client.join(joinInput());
    const document = provider.input?.document;
    expect(document).toBeDefined();

    expect(client.publish(snapshot())).toBe(false);
    expect(client.updateAwareness({ selection: { nodeIds: ['task-1'] } })).toBe(false);
    expect(document?.toJSON()).toEqual({});
    expect(provider.localAwareness).toBeNull();

    provider.input?.onAuthenticated();
    expect(client.publish(snapshot())).toBe(false);
    expect(document?.toJSON()).toEqual({});
    provider.input?.onSynced();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(provider.localAwareness).toMatchObject({ selection: { nodeIds: ['task-1'] } });
    expect(client.publish(snapshot())).toBe(true);

    const connectedDocument = structuredClone(document?.toJSON());
    const connectedAwareness = structuredClone(provider.localAwareness);
    provider.input?.onDisconnect();
    expect(client.connection).toMatchObject({ status: 'reconnecting' });
    expect(client.publish(snapshot())).toBe(false);
    expect(client.updateAwareness({ selection: { nodeIds: ['other-task'] } })).toBe(false);
    expect(document?.toJSON()).toEqual(connectedDocument);
    expect(provider.localAwareness).toEqual(connectedAwareness);
  });

  it('does not carry canvas metadata or awareness across an explicit room change', async () => {
    const provider = providerHarness();
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      now: () => new Date(NOW),
    });
    await connect(client, provider);
    expect(client.publish(snapshot())).toBe(true);
    expect(
      client.updateAwareness({
        selection: { nodeIds: ['task-1'] },
        activity: { nodeId: 'task-1', status: 'editing' },
      }),
    ).toBe(true);

    client.leave();
    provider.localAwareness = null;
    const secondJoin = client.join(
      joinInput({
        roomId: 'second-room',
        subject: 'editor-2',
        displayName: 'Second editor',
        accessToken: accessToken({ roomId: 'second-room', sub: 'editor-2' }),
      }),
    );
    const secondProvider = provider.input;
    expect(secondProvider).not.toBeNull();
    expect(secondProvider?.document.toJSON()).toEqual({});
    secondProvider?.onAuthenticated();
    secondProvider?.onSynced();

    await expect(secondJoin).resolves.toMatchObject({
      ok: true,
      connection: { roomId: 'second-room', subject: 'editor-2' },
    });
    expect(provider.localAwareness).toEqual({
      user: {
        id: 'editor-2',
        displayName: 'Second editor',
        color: '#6d5efc',
        role: 'editor',
      },
    });
  });

  it('disconnects when a remote Yjs update adds data outside the privacy allowlist', async () => {
    const provider = providerHarness();
    const events: CollaborationEvent[] = [];
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      now: () => new Date(NOW),
    });
    client.onEvent((event) => events.push(event));
    await connect(client, provider);
    const document = provider.input?.document as Y.Doc;

    document.getMap('credentials').set('token', 'REMOTE_SECRET_DO_NOT_FORWARD');

    expect(client.connection).toMatchObject({
      status: 'error',
      error: { code: 'privacy-rejected' },
    });
    expect(provider.clearCredential).toHaveBeenCalledOnce();
    expect(provider.destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toContain('REMOTE_SECRET_DO_NOT_FORWARD');
  });
});
