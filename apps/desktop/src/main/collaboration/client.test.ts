import { describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';

import {
  CollaborationMetadataSnapshotSchema,
  CollaborationPublishReceiptSchema,
  effectiveCollaborationSyncPending,
  type CollaborationAwarenessState,
  type CollaborationEvent,
  type CollaborationJoinInput,
  type CollaborationMetadataSnapshot,
} from '../../shared/collaboration/index.js';
import { CollaborationClient } from './client.js';
import { collaborationSnapshotFromDocument, replaceCollaborationDocument } from './document.js';
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

function acknowledgeLatestDelivery(harness: ProviderHarness, persistedAt = NOW): void {
  const rawRequest = harness.stateless.at(-1);
  if (rawRequest === undefined) throw new Error('Expected a delivery confirmation request.');
  const request = JSON.parse(rawRequest) as { deliveryId: string; stateVector: string };
  harness.input?.onStateless(
    JSON.stringify({
      protocol: 'forgeboard.delivery.v1',
      type: 'delivery-acknowledged',
      deliveryId: request.deliveryId,
      stateVector: request.stateVector,
      persistedAt,
    }),
  );
}

interface ProviderHarness {
  readonly factory: ReturnType<
    typeof vi.fn<(input: CollaborationProviderFactoryInput) => CollaborationProviderHandle>
  >;
  readonly clearCredential: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly sendStateless: ReturnType<typeof vi.fn<(payload: string) => void>>;
  input: CollaborationProviderFactoryInput | null;
  localAwareness: CollaborationAwarenessState | null;
  awareness: ReadonlyArray<{
    readonly clientId: number;
    readonly state: unknown;
  }>;
  stateless: string[];
}

function providerHarness(): ProviderHarness {
  const harness: ProviderHarness = {
    input: null,
    localAwareness: null,
    awareness: [],
    stateless: [],
    clearCredential: vi.fn(),
    destroy: vi.fn(),
    sendStateless: vi.fn((payload: string) => harness.stateless.push(payload)),
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
      sendStateless: harness.sendStateless,
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

    expect(client.publish(snapshot())).toMatchObject({ disposition: 'sent' });
    expect(provider.stateless).toHaveLength(1);
    expect(client.snapshot).toEqual(snapshot());
    expect(events.findLast((event) => event.type === 'metadata-snapshot')).toMatchObject({
      type: 'metadata-snapshot',
      source: 'local',
    });
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

  it('queues offline editor metadata and waits for durable delivery acknowledgement on reconnect', async () => {
    const provider = providerHarness();
    const events: CollaborationEvent[] = [];
    let deliverySequence = 20;
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      createDeliveryId: () =>
        `00000000-0000-4000-8000-${String(deliverySequence++).padStart(12, '0')}`,
      now: () => new Date(NOW),
    });
    client.onEvent((event) => events.push(event));
    await connect(client, provider);

    expect(client.publish(snapshot())).toMatchObject({ disposition: 'sent' });
    acknowledgeLatestDelivery(provider);
    expect(events.at(-1)).toMatchObject({
      type: 'delivery-acknowledged',
      reconciledAfterReconnect: false,
    });

    provider.input?.onDisconnect();
    const offlineSnapshot = CollaborationMetadataSnapshotSchema.parse({
      ...snapshot(),
      canvas: { ...snapshot().canvas, title: 'Offline editor title' },
    });
    expect(client.publish(offlineSnapshot)).toMatchObject({ disposition: 'queued-offline' });
    expect(client.snapshot).toBeNull();

    provider.input?.onAuthenticated();
    provider.input?.onSynced();
    expect(client.connection).toMatchObject({ status: 'reconnecting' });
    expect(provider.stateless).toHaveLength(2);

    acknowledgeLatestDelivery(provider);
    expect(client.connection).toMatchObject({ status: 'connected' });
    expect(client.snapshot?.canvas.title).toBe('Offline editor title');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'delivery-acknowledged',
        reconciledAfterReconnect: true,
      }),
    );
  });

  it('reports a lost delivery acknowledgement as an explicit retained-intent rejection', async () => {
    vi.useFakeTimers();
    const provider = providerHarness();
    const events: CollaborationEvent[] = [];
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      createDeliveryId: () => '00000000-0000-4000-8000-000000000099',
      now: () => new Date(NOW),
      deliveryAcknowledgementTimeoutMs: 25,
    });
    try {
      client.onEvent((event) => events.push(event));
      await connect(client, provider);

      expect(client.publish(snapshot())).toMatchObject({ disposition: 'sent' });
      expect(provider.stateless).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(26);

      expect(events.at(-1)).toMatchObject({
        type: 'delivery-rejected',
        duringReconnect: false,
        rejection: {
          deliveryId: '00000000-0000-4000-8000-000000000099',
          reason: 'state-not-applied',
        },
      });
      expect(client.snapshot).toEqual(snapshot());
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it('enforces viewer metadata read-only authority in the main process', async () => {
    const provider = providerHarness();
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      now: () => new Date(NOW),
    });
    const pending = client.join(joinInput({ accessToken: accessToken({ role: 'viewer' }) }));
    provider.input?.onAuthenticated();
    provider.input?.onSynced();
    await expect(pending).resolves.toMatchObject({
      ok: true,
      connection: { role: 'viewer' },
    });
    expect(client.publish(snapshot())).toBeNull();
    provider.input?.onDisconnect();
    expect(client.publish(snapshot())).toBeNull();
    expect(provider.stateless).toEqual([]);
  });

  it('lets a reviewer add only an identity-bound comment without full graph publish authority', async () => {
    const provider = providerHarness();
    let sequence = 40;
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      createDeliveryId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
      now: () => new Date(NOW),
    });
    const pending = client.join(joinInput({ accessToken: accessToken({ role: 'reviewer' }) }));
    provider.input?.onAuthenticated();
    provider.input?.onSynced();
    await pending;
    const document = provider.input?.document;
    if (document === undefined) throw new Error('Missing collaboration document.');
    replaceCollaborationDocument(document, snapshot(), Symbol('remote-room'));
    const beforeApply = vi.fn(() => {
      expect(client.snapshot?.comments).toEqual({});
    });

    expect(client.publish(snapshot())).toBeNull();
    const result = client.createComment(
      { nodeId: 'task-1', body: 'Reviewer feedback' },
      beforeApply,
    );

    expect(beforeApply).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      comment: {
        nodeId: 'task-1',
        authorId: 'editor-1',
        body: 'Reviewer feedback',
      },
      receipt: { disposition: 'sent' },
    });
    expect(client.snapshot).toMatchObject({
      nodes: snapshot().nodes,
      comments: {
        [result?.comment.id ?? 'missing']: { authorId: 'editor-1', body: 'Reviewer feedback' },
      },
    });
  });

  it('reserves a delivery receipt before a comment mutation can fill the pending capacity', async () => {
    const provider = providerHarness();
    let sequence = 1_000;
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      createDeliveryId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
      now: () => new Date(NOW),
    });
    const joining = client.join(joinInput({ accessToken: accessToken({ role: 'editor' }) }));
    provider.input?.onAuthenticated();
    provider.input?.onSynced();
    await joining;
    const document = provider.input?.document;
    if (document === undefined) throw new Error('Missing collaboration document.');
    replaceCollaborationDocument(document, snapshot(), Symbol('remote-room'));
    let competingReceipts = 0;

    const result = client.createComment(
      { nodeId: 'task-1', body: 'Receipt-bound feedback' },
      () => {
        for (let index = 0; index < 300; index += 1) {
          if (client.publish(snapshot()) !== null) competingReceipts += 1;
        }
      },
    );

    expect(competingReceipts).toBe(255);
    expect(result).toMatchObject({
      comment: { body: 'Receipt-bound feedback' },
      receipt: { disposition: 'sent' },
    });
    expect(client.snapshot?.comments[result?.comment.id ?? 'missing']).toMatchObject({
      body: 'Receipt-bound feedback',
    });
    expect(provider.stateless).toHaveLength(256);
  });

  it('does not mutate publish, comment, or replay state when durable receipt staging fails', async () => {
    const provider = providerHarness();
    let sequence = 2_000;
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      createDeliveryId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
      now: () => new Date(NOW),
    });
    await connect(client, provider);
    const document = provider.input?.document;
    if (document === undefined) throw new Error('Missing collaboration document.');
    const baseline = snapshot();
    replaceCollaborationDocument(document, baseline, Symbol('remote-room'));
    const failJournal = vi.fn((receipt: unknown) => {
      const parsed = CollaborationPublishReceiptSchema.parse(receipt);
      expect(parsed.deliveryId).toMatch(/^[a-f0-9-]{36}$/u);
      expect(parsed.snapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(parsed.disposition).toBe('sent');
      throw new Error('durable journal unavailable');
    });

    expect(() =>
      client.publish(
        { ...baseline, canvas: { ...baseline.canvas, title: 'Must not escape' } },
        failJournal,
      ),
    ).toThrow(/durable journal unavailable/u);
    expect(() =>
      client.createComment(
        { nodeId: 'task-1', body: 'Must not escape' },
        (_candidate, _comment, receipt) => failJournal(receipt),
      ),
    ).toThrow(/durable journal unavailable/u);
    expect(() =>
      client.replayComments(
        [
          {
            id: 'comment-restart',
            nodeId: 'task-1',
            authorId: 'editor-1',
            body: 'Must not escape',
            resolved: false,
            createdAt: NOW,
          },
        ],
        (_candidate, receipt) => failJournal(receipt),
      ),
    ).toThrow(/durable journal unavailable/u);

    expect(failJournal).toHaveBeenCalledTimes(3);
    expect(client.snapshot).toEqual(baseline);
    expect(provider.stateless).toEqual([]);
    expect(client.publish(baseline)).toMatchObject({ disposition: 'sent' });
    expect(provider.stateless).toHaveLength(1);
  });

  it('keeps exact suppression local and requires a clean rejoin before later authoring', async () => {
    const provider = providerHarness();
    const events: CollaborationEvent[] = [];
    let sequence = 3_000;
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      createDeliveryId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
      now: () => new Date(NOW),
    });
    client.onEvent((event) => events.push(event));
    await connect(client, provider);
    const document = provider.input?.document;
    if (document === undefined) throw new Error('Missing collaboration document.');
    const rejected = {
      id: 'comment-rejected',
      nodeId: 'task-1',
      authorId: 'editor-1',
      body: 'Rejected local text',
      createdAt: NOW,
    };
    const reply = {
      ...rejected,
      id: 'comment-reply',
      body: 'Dependent reply',
      replyToId: rejected.id,
    };
    const review = {
      id: 'review-1',
      nodeId: 'task-1',
      reviewerId: 'editor-1',
      status: 'changes-requested' as const,
      createdAt: NOW,
    };
    const authoritative = CollaborationMetadataSnapshotSchema.parse({
      ...snapshot(),
      reviews: { [review.id]: review },
    });
    const polluted = CollaborationMetadataSnapshotSchema.parse({
      ...authoritative,
      comments: { [rejected.id]: rejected, [reply.id]: reply },
      reviews: {
        [review.id]: {
          ...review,
          commentIds: [rejected.id, reply.id],
        },
      },
    });
    replaceCollaborationDocument(document, polluted, Symbol('remote-room'));

    client.setRejectedCommentSuppressions([rejected], authoritative);

    expect(collaborationSnapshotFromDocument(document)).toEqual(polluted);
    expect(client.snapshot).toEqual(
      effectiveCollaborationSyncPending({
        baseline: authoritative,
        pending: polluted,
        dismissedRejectedComments: [rejected],
      }),
    );
    expect(client.snapshot?.comments).toEqual({});
    expect(client.snapshot?.reviews[review.id]).toEqual(review);
    expect(events.findLast((event) => event.type === 'metadata-snapshot')).toMatchObject({
      type: 'metadata-snapshot',
      snapshot: { comments: {}, reviews: { [review.id]: review } },
    });

    client.setRejectedCommentSuppressions([]);
    expect(client.snapshot?.comments).toEqual(polluted.comments);
    client.setRejectedCommentSuppressions([rejected], authoritative);

    const staleJournal = vi.fn();
    expect(() => client.publish(polluted, staleJournal)).toThrow(/stale collaboration view/u);
    expect(staleJournal).not.toHaveBeenCalled();
    const cleanJournal = vi.fn();
    expect(() => client.publish(authoritative, cleanJournal)).toThrow(/Leave and rejoin/u);
    expect(cleanJournal).not.toHaveBeenCalled();
    expect(provider.stateless).toEqual([]);

    const createdCandidate = vi.fn<(candidate: CollaborationMetadataSnapshot) => void>();
    expect(() =>
      client.createComment({ nodeId: 'task-1', body: 'Fresh feedback' }, (candidate) => {
        createdCandidate(candidate);
      }),
    ).toThrow(/Leave and rejoin/u);
    expect(createdCandidate).not.toHaveBeenCalled();
    expect(collaborationSnapshotFromDocument(document)).toEqual(polluted);
    expect(provider.stateless).toEqual([]);

    expect(client.replayComments([rejected])).toBeNull();
    expect(collaborationSnapshotFromDocument(document)).toEqual(polluted);
    const replayed = {
      id: 'comment-replayed',
      nodeId: 'task-1',
      authorId: 'editor-1',
      body: 'Recovered independent feedback',
      createdAt: NOW,
    };
    const replayCandidate = vi.fn<(candidate: CollaborationMetadataSnapshot) => void>();
    expect(() =>
      client.replayComments([rejected, replayed], (candidate) => {
        replayCandidate(candidate);
      }),
    ).toThrow(/Leave and rejoin/u);
    expect(replayCandidate).not.toHaveBeenCalled();
    expect(collaborationSnapshotFromDocument(document)).toEqual(polluted);
    expect(provider.stateless).toEqual([]);

    const eventCountBeforeRejoin = events.length;
    client.leave();
    await connect(client, provider);
    expect(
      events
        .slice(eventCountBeforeRejoin)
        .some(
          (event) =>
            event.type === 'metadata-snapshot' &&
            event.snapshot.comments[rejected.id] !== undefined,
        ),
    ).toBe(false);
    const cleanDocument = provider.input?.document;
    if (cleanDocument === undefined) throw new Error('Missing rejoined collaboration document.');
    replaceCollaborationDocument(cleanDocument, authoritative, Symbol('remote-room'));
    const created = client.createComment({ nodeId: 'task-1', body: 'Fresh feedback' });
    expect(created).toMatchObject({
      comment: {
        id: '00000000-0000-4000-8000-000000003001',
        body: 'Fresh feedback',
      },
      receipt: { disposition: 'sent' },
    });
    const replayApplied = vi.fn();
    expect(
      client.replayComments([replayed], (candidate) => {
        expect(candidate.comments[replayed.id]).toEqual(replayed);
        expect(candidate.reviews).toEqual({ [review.id]: review });
        replayApplied();
      }),
    ).toMatchObject({ disposition: 'sent' });
    expect(replayApplied).toHaveBeenCalledOnce();
    expect(collaborationSnapshotFromDocument(cleanDocument)).toEqual(client.snapshot);
    expect(client.snapshot?.comments).toMatchObject({ [replayed.id]: replayed });
    expect(provider.stateless).toHaveLength(2);
  });

  it('does not turn a failing event listener into a post-mutation operation failure', async () => {
    const provider = providerHarness();
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      now: () => new Date(NOW),
    });
    await connect(client, provider);
    const observed: CollaborationEvent[] = [];
    client.onEvent(() => {
      throw new Error('renderer transport unavailable');
    });
    client.onEvent((event) => observed.push(event));

    expect(() => client.publish(snapshot())).not.toThrow();
    expect(provider.stateless).toHaveLength(1);
    expect(observed).toContainEqual(expect.objectContaining({ type: 'metadata-snapshot' }));
  });

  it('retains a journaled receipt when the confirmation transport throws after mutation', async () => {
    const provider = providerHarness();
    provider.sendStateless.mockImplementationOnce(() => {
      throw new Error('transport write failed');
    });
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      now: () => new Date(NOW),
    });
    await connect(client, provider);
    const journal = vi.fn();

    expect(() => client.publish(snapshot(), journal)).not.toThrow();
    expect(journal).toHaveBeenCalledOnce();
    expect(client.snapshot).toEqual(snapshot());
    expect(provider.sendStateless).toHaveBeenCalledOnce();
  });

  it('does not let a viewer create a shared comment', async () => {
    const provider = providerHarness();
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      now: () => new Date(NOW),
    });
    const pending = client.join(joinInput({ accessToken: accessToken({ role: 'viewer' }) }));
    provider.input?.onAuthenticated();
    provider.input?.onSynced();
    await pending;
    const document = provider.input?.document;
    if (document === undefined) throw new Error('Missing collaboration document.');
    replaceCollaborationDocument(document, snapshot(), Symbol('remote-room'));

    expect(client.createComment({ nodeId: 'task-1', body: 'Forbidden' })).toBeNull();
    expect(client.snapshot?.comments).toEqual({});
  });

  it('replays retained reviewer comments with their original main-authored identity only', async () => {
    const provider = providerHarness();
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      createDeliveryId: () => '00000000-0000-4000-8000-000000000078',
      now: () => new Date(NOW),
    });
    const pending = client.join(joinInput({ accessToken: accessToken({ role: 'reviewer' }) }));
    provider.input?.onAuthenticated();
    provider.input?.onSynced();
    await pending;
    const document = provider.input?.document;
    if (document === undefined) throw new Error('Missing collaboration document.');
    replaceCollaborationDocument(document, snapshot(), Symbol('remote-room'));
    const beforeApply = vi.fn(() => expect(client.snapshot?.comments).toEqual({}));

    expect(
      client.replayComments(
        [
          {
            id: 'comment-restart',
            nodeId: 'task-1',
            authorId: 'editor-1',
            body: 'Retained reviewer feedback',
            resolved: false,
            createdAt: NOW,
          },
        ],
        beforeApply,
      ),
    ).toMatchObject({ disposition: 'sent' });
    expect(beforeApply).toHaveBeenCalledOnce();
    expect(client.snapshot).toMatchObject({
      nodes: snapshot().nodes,
      comments: {
        'comment-restart': {
          authorId: 'editor-1',
          body: 'Retained reviewer feedback',
        },
      },
    });
    expect(() =>
      client.replayComments([
        {
          id: 'forged-comment',
          nodeId: 'task-1',
          authorId: 'another-user',
          body: 'Forged',
          resolved: false,
          createdAt: NOW,
        },
      ]),
    ).toThrow(/authenticated collaborator/u);
  });

  it('rejects pre-auth metadata and queues editable metadata safely during reconnect', async () => {
    const provider = providerHarness();
    const client = new CollaborationClient({
      createProvider: provider.factory,
      createId: () => CONNECTION_ID,
      now: () => new Date(NOW),
    });
    const pending = client.join(joinInput());
    const document = provider.input?.document;
    expect(document).toBeDefined();

    expect(client.publish(snapshot())).toBeNull();
    expect(client.updateAwareness({ selection: { nodeIds: ['task-1'] } })).toBe(false);
    expect(document?.toJSON()).toEqual({});
    expect(provider.localAwareness).toBeNull();

    provider.input?.onAuthenticated();
    expect(client.publish(snapshot())).toBeNull();
    expect(document?.toJSON()).toEqual({});
    provider.input?.onSynced();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(provider.localAwareness).toMatchObject({ selection: { nodeIds: ['task-1'] } });
    expect(client.publish(snapshot())).toMatchObject({ disposition: 'sent' });

    const connectedDocument = structuredClone(document?.toJSON());
    const connectedAwareness = structuredClone(provider.localAwareness);
    provider.input?.onDisconnect();
    expect(client.connection).toMatchObject({ status: 'reconnecting' });
    expect(client.publish(snapshot())).toMatchObject({ disposition: 'queued-offline' });
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
    expect(client.publish(snapshot())).toMatchObject({ disposition: 'sent' });
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
