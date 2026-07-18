// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasDocument } from '../../../../../../shared/application/contracts.js';
import type {
  CollaborationEvent,
  CollaborationConnection,
  CollaborationMetadataSnapshot,
  CollaborationPublishInput,
  CollaborationSyncRecovery,
  CollaborationCreateCommentResult,
} from '../../../../../../shared/collaboration/index.js';
import { CollaborationMetadataSnapshotSchema } from '../../../../../../shared/collaboration/index.js';
import { useCollaborationCanvas } from '../useCollaborationCanvas.js';

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
  it('tracks a narrowly replayed reviewer comment through restart until its acknowledgement', async () => {
    const baseline = roomSnapshot();
    const comment = {
      id: 'comment-restart',
      nodeId: 'agent-1',
      authorId: 'editor-1',
      body: 'Retained reviewer feedback',
      resolved: false,
      createdAt: NOW,
    };
    const delivered = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      comments: { [comment.id]: comment },
    });
    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline,
        pending: delivered,
        disposition: 'sent',
        deliveryId: deliveryId(92),
        snapshotDigest: 'd'.repeat(64),
        expiresAt: '2026-08-14T12:00:00.000Z',
        replayedReceipt: {
          deliveryId: deliveryId(92),
          snapshotDigest: 'd'.repeat(64),
          disposition: 'sent',
        },
      },
    });
    readSnapshot.mockResolvedValue({ ok: true, value: delivered });
    const hook = renderHook(() =>
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
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));

    const withheld = CollaborationMetadataSnapshotSchema.parse({
      ...delivered,
      comments: {},
    });
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(withheld, { initial: false }));
    expect(onSnapshot).not.toHaveBeenCalledWith(delivered, { initial: false });
    expect(hook.result.current.canComment).toBe(true);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    act(() => eventListener?.(deliveryAcknowledgedEvent(92, false)));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(delivered, { initial: false }));
    await waitFor(() =>
      expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ snapshot: delivered })),
    );
  });

  it('restores a rejected-comment quarantine instead of exposing or replaying the local Yjs value', async () => {
    const baseline = roomSnapshot();
    const rejectedComment = commentResult(97, 'Rejected before restart').comment;
    const localYjsSnapshot = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      comments: { [rejectedComment.id]: rejectedComment },
    });
    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline,
        pending: localYjsSnapshot,
        disposition: 'rejected',
        deliveryId: deliveryId(97),
        snapshotDigest: 'e'.repeat(64),
        rejectedCommentIds: [rejectedComment.id],
        expiresAt: '2026-08-14T12:00:00.000Z',
      },
    });
    readSnapshot.mockResolvedValue({ ok: true, value: localYjsSnapshot });
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
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(baseline, { initial: false }));
    expect(onSnapshot).not.toHaveBeenCalledWith(localYjsSnapshot, {
      initial: false,
    });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('discards only the exact latest rejection token after a viewer downgrade', async () => {
    const baseline = roomSnapshot();
    const comment = commentResult(97, 'Exact local copy').comment;
    const pending = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      canvas: { ...baseline.canvas, title: 'Unrelated pending graph intent' },
      comments: { [comment.id]: comment },
    });
    const oldEntry = { comment, rejectedDeliveryId: deliveryId(97) };
    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline,
        pending,
        disposition: 'sent',
        deliveryId: deliveryId(98),
        snapshotDigest: 'b'.repeat(64),
        rejectedCommentIds: [comment.id],
        rejectedComments: [comment],
        rejectedCommentEntries: [oldEntry],
        expiresAt: '2026-08-14T12:00:00.000Z',
        replayedReceipt: {
          deliveryId: deliveryId(98),
          snapshotDigest: 'b'.repeat(64),
          disposition: 'sent',
        },
      },
    });
    readSnapshot.mockResolvedValue({ ok: true, value: baseline });
    discardRejectedComment.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline,
        pending,
        disposition: 'rejected',
        deliveryId: deliveryId(98),
        snapshotDigest: 'b'.repeat(64),
        rejectedCommentIds: [],
        rejectedComments: [],
        rejectedCommentEntries: [],
        dismissedRejectedComments: [comment],
        expiresAt: '2026-08-14T12:00:00.000Z',
      },
    });
    const hook = renderHook(() =>
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
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(hook.result.current.rejectedCommentEntries).toEqual([oldEntry]));

    act(() => eventListener?.(deliveryRejectedEvent(98, 'state-not-applied', false)));
    const latestEntry = { comment, rejectedDeliveryId: deliveryId(98) };
    await waitFor(() => expect(hook.result.current.rejectedCommentEntries).toEqual([latestEntry]));
    act(() => eventListener?.(statusEvent('connected', 'viewer')));

    await act(async () => {
      expect(await hook.result.current.discardRejectedComment(oldEntry)).toBe(false);
    });
    expect(discardRejectedComment).not.toHaveBeenCalled();
    await act(async () => {
      expect(await hook.result.current.discardRejectedComment(latestEntry)).toBe(true);
    });
    expect(discardRejectedComment).toHaveBeenCalledWith({
      projectId: canvas().projectId,
      canvasId: canvas().id,
      comment,
      rejectedDeliveryId: deliveryId(98),
    });
    await waitFor(() => expect(hook.result.current.rejectedCommentEntries).toEqual([]));
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('unblocks viewer checkpoints after the last rejected local copy is discarded', async () => {
    const baseline = roomSnapshot();
    const comment = commentResult(99, 'Discard rejected local copy').comment;
    const pending = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      comments: { [comment.id]: comment },
    });
    const entry = { comment, rejectedDeliveryId: deliveryId(99) };
    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline,
        pending,
        disposition: 'rejected',
        deliveryId: deliveryId(99),
        snapshotDigest: 'c'.repeat(64),
        rejectedCommentIds: [comment.id],
        rejectedComments: [comment],
        rejectedCommentEntries: [entry],
        expiresAt: '2026-08-14T12:00:00.000Z',
      },
    });
    // The local Yjs document can stay polluted until a later authenticated server resync.
    readSnapshot.mockResolvedValue({ ok: true, value: pending });
    discardRejectedComment.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline,
        pending: baseline,
        disposition: 'synchronized',
        rejectedCommentIds: [],
        rejectedComments: [],
        rejectedCommentEntries: [],
        dismissedRejectedComments: [],
        expiresAt: '2026-08-14T12:00:00.000Z',
      },
    });
    const hook = renderHook(() =>
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
    act(() => eventListener?.(statusEvent('connected', 'viewer')));
    await waitFor(() => expect(hook.result.current.rejectedCommentEntries).toEqual([entry]));
    expect(checkpoint).not.toHaveBeenCalled();

    await act(async () => {
      expect(await hook.result.current.discardRejectedComment(entry)).toBe(true);
    });
    expect(checkpoint).not.toHaveBeenCalled();

    const nextRemote = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      canvas: { ...baseline.canvas, title: 'Next remote advance' },
    });
    act(() => eventListener?.(metadataEvent(nextRemote)));
    await waitFor(() =>
      expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ snapshot: nextRemote })),
    );
  });

  it('restores acknowledged A while quarantining only later rejected B after restart', async () => {
    const original = roomSnapshot();
    const commentA = commentResult(81, 'Acknowledged A').comment;
    const commentB = commentResult(82, 'Rejected B').comment;
    const baselineA = CollaborationMetadataSnapshotSchema.parse({
      ...original,
      comments: { [commentA.id]: commentA },
    });
    const pendingAB = CollaborationMetadataSnapshotSchema.parse({
      ...original,
      comments: { [commentA.id]: commentA, [commentB.id]: commentB },
    });
    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline: baselineA,
        pending: pendingAB,
        disposition: 'rejected',
        deliveryId: deliveryId(82),
        snapshotDigest: 'f'.repeat(64),
        rejectedCommentIds: [commentB.id],
        expiresAt: '2026-08-14T12:00:00.000Z',
      },
    });
    readSnapshot.mockResolvedValue({ ok: true, value: pendingAB });
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
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(baselineA, { initial: false }));
    expect(onSnapshot).not.toHaveBeenCalledWith(pendingAB, { initial: false });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('restores rejected B beneath sent C and clears it only from acknowledged C baseline', async () => {
    const baselineA = roomSnapshot();
    const commentB = commentResult(82, 'Rejected B under C').comment;
    const candidateC = CollaborationMetadataSnapshotSchema.parse({
      ...baselineA,
      canvas: { ...baselineA.canvas, title: 'Newer C' },
      comments: { [commentB.id]: commentB },
    });
    const sentRecovery: CollaborationSyncRecovery = {
      baseline: baselineA,
      pending: candidateC,
      disposition: 'sent',
      deliveryId: deliveryId(83),
      snapshotDigest: 'a'.repeat(64),
      rejectedCommentIds: [commentB.id],
      rejectedComments: [commentB],
      expiresAt: '2026-08-14T12:00:00.000Z',
    };
    let finishRecovery: ((value: { ok: true; value: CollaborationSyncRecovery }) => void) | null =
      null;
    recover
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRecovery = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        value: {
          baseline: candidateC,
          pending: candidateC,
          disposition: 'acknowledged',
          deliveryId: deliveryId(83),
          snapshotDigest: 'a'.repeat(64),
          rejectedCommentIds: [],
          rejectedComments: [],
          expiresAt: '2026-08-14T12:00:00.000Z',
        },
      });
    readSnapshot.mockResolvedValue({ ok: true, value: candidateC });
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
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(recover).toHaveBeenCalledOnce());
    act(() => eventListener?.(metadataEvent(candidateC)));
    expect(onSnapshot).not.toHaveBeenCalled();
    act(() => {
      finishRecovery?.({ ok: true, value: sentRecovery });
    });

    const quarantined = CollaborationMetadataSnapshotSchema.parse({
      ...candidateC,
      comments: {},
    });
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(quarantined, { initial: false }));
    expect(onSnapshot).not.toHaveBeenCalledWith(candidateC, { initial: false });
    expect(checkpoint).not.toHaveBeenCalled();

    act(() => eventListener?.(statusEvent('reconnecting', 'reviewer')));
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(candidateC, { initial: false }));
    await waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
  });

  it('does not report a comment as shared until its durable acknowledgement arrives', async () => {
    const created = commentResult(90);
    createComment.mockResolvedValueOnce({
      ok: true,
      value: created,
    });
    const hook = renderHook(() =>
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
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(hook.result.current.canComment).toBe(true));

    const pending = hook.result.current.createComment('agent-1', 'Please revise this.');
    await waitFor(() => expect(createComment).toHaveBeenCalledOnce());
    const roomWithComment = CollaborationMetadataSnapshotSchema.parse({
      ...roomSnapshot(),
      comments: { [created.comment.id]: created.comment },
    });
    const roomWithoutComment = CollaborationMetadataSnapshotSchema.parse({
      ...roomWithComment,
      comments: {},
    });
    act(() => eventListener?.(metadataEvent(roomWithComment)));
    await waitFor(() =>
      expect(onSnapshot).toHaveBeenCalledWith(roomWithoutComment, {
        initial: false,
      }),
    );
    expect(onSnapshot).not.toHaveBeenCalledWith(roomWithComment, {
      initial: false,
    });
    act(() => eventListener?.(deliveryAcknowledgedEvent(90, false)));

    await expect(pending).resolves.toMatchObject({
      authorId: 'editor-1',
      body: 'Please revise this.',
    });
    await waitFor(() =>
      expect(onSnapshot).toHaveBeenCalledWith(roomWithComment, {
        initial: false,
      }),
    );
  });

  it('fails a revoked comment honestly when rejection arrives before its IPC receipt', async () => {
    createComment.mockImplementationOnce(() => {
      eventListener?.(deliveryRejectedEvent(91, 'not-authorized', false));
      return Promise.resolve({ ok: true as const, value: commentResult(91) });
    });
    const hook = renderHook(() =>
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
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(hook.result.current.canComment).toBe(true));

    await expect(
      hook.result.current.createComment('agent-1', 'Rejected feedback'),
    ).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(
      'The shared canvas refused your changes because your role cannot share them.',
    );
  });

  it('quarantines an early-rejected comment echo, its replies, and review references before the IPC receipt', async () => {
    const created = commentResult(91, 'Rejected before receipt');
    let resolveCommentIpc:
      | ((value: { ok: true; value: CollaborationCreateCommentResult }) => void)
      | null = null;
    createComment.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCommentIpc = resolve;
        }),
    );
    const hook = renderHook(() =>
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
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(hook.result.current.canComment).toBe(true));

    const pending = hook.result.current.createComment('agent-1', created.comment.body);
    await waitFor(() => expect(createComment).toHaveBeenCalledOnce());
    act(() => eventListener?.(deliveryRejectedEvent(91, 'not-authorized', false)));
    const replyChain = Array.from({ length: 64 }, (_value, index) => ({
      id: `comment-91-reply-${index}`,
      nodeId: 'agent-1',
      authorId: 'remote-reviewer',
      body: `Nested reply ${index} that must not outlive its rejected ancestor`,
      replyToId: index === 0 ? created.comment.id : `comment-91-reply-${index - 1}`,
      createdAt: NOW,
    }));
    const review = {
      id: 'review-91',
      nodeId: 'agent-1',
      reviewerId: 'remote-reviewer',
      status: 'changes-requested' as const,
      commentIds: [created.comment.id, ...replyChain.map((reply) => reply.id)],
      createdAt: NOW,
    };
    const earlyRoomEcho = CollaborationMetadataSnapshotSchema.parse({
      ...roomSnapshot(),
      comments: {
        [created.comment.id]: created.comment,
        ...Object.fromEntries(replyChain.map((reply) => [reply.id, reply])),
      },
      reviews: { [review.id]: review },
    });
    const quarantined = CollaborationMetadataSnapshotSchema.parse({
      ...earlyRoomEcho,
      comments: {},
      reviews: { [review.id]: { ...review, commentIds: [] } },
    });
    onSnapshot.mockClear();
    act(() => eventListener?.(metadataEvent(earlyRoomEcho)));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(quarantined, { initial: false }));
    expect(onSnapshot).not.toHaveBeenCalledWith(earlyRoomEcho, {
      initial: false,
    });
    act(() => resolveCommentIpc?.({ ok: true, value: created }));
    await expect(pending).resolves.toBeNull();

    onSnapshot.mockClear();
    const laterRoomEcho = CollaborationMetadataSnapshotSchema.parse({
      ...earlyRoomEcho,
      canvas: {
        ...earlyRoomEcho.canvas,
        title: 'Later unrelated remote update',
      },
    });
    const laterQuarantined = CollaborationMetadataSnapshotSchema.parse({
      ...quarantined,
      canvas: { ...quarantined.canvas, title: 'Later unrelated remote update' },
    });
    act(() => eventListener?.(metadataEvent(laterRoomEcho)));
    await waitFor(() =>
      expect(onSnapshot).toHaveBeenCalledWith(laterQuarantined, {
        initial: false,
      }),
    );
    expect(onSnapshot).not.toHaveBeenCalledWith(laterRoomEcho, {
      initial: false,
    });
  });

  it('keeps a rejected local comment quarantined from later remote room snapshots', async () => {
    const created = commentResult(96, 'Rejected feedback');
    createComment.mockResolvedValueOnce({ ok: true, value: created });
    const hook = renderHook(() =>
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
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(hook.result.current.canComment).toBe(true));

    const pending = hook.result.current.createComment('agent-1', created.comment.body);
    await waitFor(() => expect(createComment).toHaveBeenCalledOnce());
    const firstRoomEcho = CollaborationMetadataSnapshotSchema.parse({
      ...roomSnapshot(),
      comments: { [created.comment.id]: created.comment },
    });
    act(() => eventListener?.(metadataEvent(firstRoomEcho)));
    act(() => eventListener?.(deliveryRejectedEvent(96, 'not-authorized', false)));
    await expect(pending).resolves.toBeNull();
    onSnapshot.mockClear();

    const laterRoomEcho = CollaborationMetadataSnapshotSchema.parse({
      ...firstRoomEcho,
      canvas: { ...firstRoomEcho.canvas, title: 'Unrelated remote update' },
    });
    const quarantined = CollaborationMetadataSnapshotSchema.parse({
      ...laterRoomEcho,
      comments: {},
    });
    act(() => eventListener?.(metadataEvent(laterRoomEcho)));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(quarantined, { initial: false }));
    expect(onSnapshot).not.toHaveBeenCalledWith(laterRoomEcho, {
      initial: false,
    });
  });

  it('preserves the original comment resolver when reconnect recovery reattaches the same receipt', async () => {
    const created = commentResult(98, 'Survives reconnect');
    createComment.mockResolvedValueOnce({ ok: true, value: created });
    const hook = renderHook(() =>
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
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(hook.result.current.canComment).toBe(true));
    const pending = hook.result.current.createComment('agent-1', created.comment.body);
    await waitFor(() => expect(createComment).toHaveBeenCalledOnce());

    const baseline = roomSnapshot();
    const delivered = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      comments: { [created.comment.id]: created.comment },
    });
    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline,
        pending: delivered,
        deliveryId: created.receipt.deliveryId,
        snapshotDigest: created.receipt.snapshotDigest,
        disposition: 'sent',
        expiresAt: '2026-08-14T12:00:00.000Z',
        replayedReceipt: created.receipt,
      },
    });
    act(() => eventListener?.(statusEvent('reconnecting', 'reviewer')));
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    act(() => eventListener?.(deliveryAcknowledgedEvent(98, false)));

    await expect(pending).resolves.toMatchObject({
      body: 'Survives reconnect',
    });
  });

  it('pauses on a same-id recovery receipt digest mismatch without losing the original resolver', async () => {
    const created = commentResult(99, 'Digest mismatch');
    createComment.mockResolvedValueOnce({ ok: true, value: created });
    const hook = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useCollaborationCanvas({
          enabled,
          document: canvas(),
          selectedNodeId: 'agent-1',
          onSnapshot,
          onError,
          debounceMs: 0,
        }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(hook.result.current.canComment).toBe(true));
    const pending = hook.result.current.createComment('agent-1', created.comment.body);
    await waitFor(() => expect(createComment).toHaveBeenCalledOnce());

    const baseline = roomSnapshot();
    const delivered = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      comments: { [created.comment.id]: created.comment },
    });
    recover.mockResolvedValueOnce({
      ok: true,
      value: {
        baseline,
        pending: delivered,
        deliveryId: created.receipt.deliveryId,
        snapshotDigest: 'c'.repeat(64),
        disposition: 'sent',
        expiresAt: '2026-08-14T12:00:00.000Z',
        replayedReceipt: { ...created.receipt, snapshotDigest: 'c'.repeat(64) },
      },
    });
    act(() => eventListener?.(statusEvent('reconnecting', 'reviewer')));
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Sharing paused because a saved delivery record did not match while restoring offline changes.',
      ),
    );
    expect(hook.result.current.canComment).toBe(false);
    hook.rerender({ enabled: false });
    await expect(pending).resolves.toBeNull();
  });

  it('correlates an early acknowledgement and out-of-order comment receipts exactly', async () => {
    createComment
      .mockImplementationOnce(() => {
        eventListener?.(deliveryAcknowledgedEvent(93, false));
        return Promise.resolve({
          ok: true as const,
          value: commentResult(93, 'First'),
        });
      })
      .mockResolvedValueOnce({ ok: true, value: commentResult(94, 'Second') })
      .mockResolvedValueOnce({ ok: true, value: commentResult(95, 'Third') });
    const hook = renderHook(() =>
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
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(hook.result.current.canComment).toBe(true));

    await expect(hook.result.current.createComment('agent-1', 'First')).resolves.toMatchObject({
      body: 'First',
    });
    const second = hook.result.current.createComment('agent-1', 'Second');
    const third = hook.result.current.createComment('agent-1', 'Third');
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(3));
    act(() => eventListener?.(deliveryAcknowledgedEvent(95, false)));
    await expect(third).resolves.toMatchObject({ body: 'Third' });
    expect(secondSettled).toBe(false);
    act(() => eventListener?.(deliveryAcknowledgedEvent(94, false)));
    await expect(second).resolves.toMatchObject({ body: 'Second' });
  });

  it('settles comment promises when collaboration is disabled or the joined room is left', async () => {
    let resolveIpc:
      | ((value: { ok: true; value: CollaborationCreateCommentResult }) => void)
      | null = null;
    createComment.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveIpc = resolve;
        }),
    );
    const hook = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useCollaborationCanvas({
          enabled,
          document: canvas(),
          selectedNodeId: 'agent-1',
          onSnapshot,
          onError,
          debounceMs: 0,
        }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(hook.result.current.canComment).toBe(true));
    const disabled = hook.result.current.createComment('agent-1', 'Disable pending');
    hook.rerender({ enabled: false });
    await expect(disabled).resolves.toBeNull();
    act(() => resolveIpc?.({ ok: true, value: commentResult(96, 'Disable pending') }));

    hook.rerender({ enabled: true });
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => eventListener?.(statusEvent('connected', 'reviewer')));
    await waitFor(() => expect(hook.result.current.canComment).toBe(true));
    createComment.mockResolvedValueOnce({
      ok: true,
      value: commentResult(97, 'Leave pending'),
    });
    const left = hook.result.current.createComment('agent-1', 'Leave pending');
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(2));
    act(() => eventListener?.(statusEvent('offline', 'reviewer')));
    await expect(left).resolves.toBeNull();
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

function commentResult(sequence: number, body?: string) {
  return {
    comment: {
      id: `comment-${sequence}`,
      nodeId: 'agent-1',
      authorId: 'editor-1',
      body: body ?? (sequence === 90 ? 'Please revise this.' : 'Rejected feedback'),
      createdAt: NOW,
    },
    receipt: {
      deliveryId: deliveryId(sequence),
      snapshotDigest: 'b'.repeat(64),
      disposition: 'sent' as const,
    },
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
