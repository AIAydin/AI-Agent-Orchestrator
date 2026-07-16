import {
  CollaborationCommentMetadataSchema,
  CollaborationMetadataSnapshotSchema,
  type CollaborationCommentMetadata,
  type CollaborationMetadataSnapshot,
} from '../metadata-contracts.js';

/** Compares validated comment values, including every optional field, rather than identifiers. */
export function collaborationCommentMetadataEquals(
  left: CollaborationCommentMetadata | undefined,
  right: CollaborationCommentMetadata | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return serializeComment(left) === serializeComment(right);
}

/** Applies the local-only dismissal overlay without changing a durable delivery candidate. */
export function applyCollaborationRejectedCommentDismissals(
  snapshot: CollaborationMetadataSnapshot,
  dismissals: readonly CollaborationCommentMetadata[],
  baseline?: CollaborationMetadataSnapshot | null,
): CollaborationMetadataSnapshot {
  if (dismissals.length === 0) return CollaborationMetadataSnapshotSchema.parse(snapshot);
  const excluded = new Set<string>();
  for (const dismissal of dismissals) {
    const parsed = CollaborationCommentMetadataSchema.parse(dismissal);
    if (!collaborationCommentMetadataEquals(snapshot.comments[parsed.id], parsed)) continue;
    excluded.add(parsed.id);
  }
  if (excluded.size === 0) return CollaborationMetadataSnapshotSchema.parse(snapshot);
  const repliesByParent = new Map<string, string[]>();
  for (const comment of Object.values(snapshot.comments)) {
    if (comment.replyToId === undefined) continue;
    const replies = repliesByParent.get(comment.replyToId) ?? [];
    replies.push(comment.id);
    repliesByParent.set(comment.replyToId, replies);
  }
  const queue = [...excluded];
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index];
    if (parentId === undefined) break;
    for (const replyId of repliesByParent.get(parentId) ?? []) {
      if (excluded.has(replyId)) continue;
      excluded.add(replyId);
      queue.push(replyId);
    }
  }
  const comments = Object.fromEntries(
    Object.entries(snapshot.comments).filter(([commentId]) => !excluded.has(commentId)),
  );
  const reviews = Object.fromEntries(
    Object.entries(snapshot.reviews).map(([reviewId, review]) => {
      if (review.commentIds === undefined) return [reviewId, review];
      const commentIds = review.commentIds.filter((commentId) => !excluded.has(commentId));
      if (commentIds.length === review.commentIds.length) return [reviewId, review];
      if (
        commentIds.length === 0 &&
        baseline !== undefined &&
        baseline !== null &&
        baseline.reviews[reviewId]?.commentIds === undefined
      ) {
        const withoutCommentIds = { ...review };
        delete withoutCommentIds.commentIds;
        return [reviewId, withoutCommentIds];
      }
      return [reviewId, { ...review, commentIds }];
    }),
  );
  return CollaborationMetadataSnapshotSchema.parse({ ...snapshot, comments, reviews });
}

export function effectiveCollaborationSyncPending(recovery: {
  readonly baseline?: CollaborationMetadataSnapshot | null | undefined;
  readonly pending: CollaborationMetadataSnapshot;
  readonly dismissedRejectedComments?: readonly CollaborationCommentMetadata[] | undefined;
}): CollaborationMetadataSnapshot {
  return applyCollaborationRejectedCommentDismissals(
    recovery.pending,
    recovery.dismissedRejectedComments ?? [],
    recovery.baseline,
  );
}

/** Proves that the overlay-effective pending value is the supplied authenticated snapshot. */
export function collaborationRecoveryCanCheckpoint(
  recovery: {
    readonly baseline: CollaborationMetadataSnapshot | null;
    readonly pending: CollaborationMetadataSnapshot;
    readonly dismissedRejectedComments?: readonly CollaborationCommentMetadata[] | undefined;
  },
  authenticatedSnapshot: CollaborationMetadataSnapshot,
): boolean {
  return (
    serializeSnapshot(effectiveCollaborationSyncPending(recovery)) ===
    serializeSnapshot(authenticatedSnapshot)
  );
}

/** Proves that applying dismissals leaves no local intent beyond the durable baseline. */
export function collaborationRecoveryHasNoLocalIntent(recovery: {
  readonly baseline: CollaborationMetadataSnapshot | null;
  readonly pending: CollaborationMetadataSnapshot;
  readonly dismissedRejectedComments?: readonly CollaborationCommentMetadata[] | undefined;
}): recovery is typeof recovery & { readonly baseline: CollaborationMetadataSnapshot } {
  return (
    recovery.baseline !== null &&
    serializeSnapshot(effectiveCollaborationSyncPending(recovery)) ===
      serializeSnapshot(recovery.baseline)
  );
}

function serializeComment(comment: CollaborationCommentMetadata): string {
  return JSON.stringify(CollaborationCommentMetadataSchema.parse(comment));
}

function serializeSnapshot(snapshot: CollaborationMetadataSnapshot): string {
  return JSON.stringify(CollaborationMetadataSnapshotSchema.parse(snapshot));
}
