import type {
  CollaborationCommentMetadata,
  CollaborationMetadataSnapshot,
} from '../metadata-contracts.js';

export interface CollaborationCommentRecoveryAnalysis {
  readonly commentOnly: boolean;
  readonly additions: readonly CollaborationCommentMetadata[];
  readonly missing: readonly CollaborationCommentMetadata[];
  readonly conflictingIds: readonly string[];
  readonly satisfied: boolean;
}

/** Identifies main-authored comment additions without treating them as reviewer graph authority. */
export function analyzeCollaborationCommentRecovery(
  baseline: CollaborationMetadataSnapshot | null,
  pending: CollaborationMetadataSnapshot,
  remote: CollaborationMetadataSnapshot,
  subject: string,
): CollaborationCommentRecoveryAnalysis {
  const baselineComments = baseline?.comments ?? {};
  const additions = Object.values(pending.comments).filter(
    (comment) => baselineComments[comment.id] === undefined && comment.authorId === subject,
  );
  const additionIds = new Set(additions.map((comment) => comment.id));
  const missing: CollaborationCommentMetadata[] = [];
  const conflictingIds: string[] = [];
  for (const comment of additions) {
    const current = remote.comments[comment.id];
    if (current === undefined) missing.push(comment);
    else if (!jsonValuesEqual(current, comment)) conflictingIds.push(comment.id);
  }

  const commentsChangedOnlyBySubjectAdditions =
    baseline !== null &&
    Object.entries(baseline.comments).every(([id, comment]) =>
      jsonValuesEqual(pending.comments[id], comment),
    ) &&
    Object.values(pending.comments).every(
      (comment) =>
        baseline.comments[comment.id] !== undefined ||
        (comment.authorId === subject && additionIds.has(comment.id)),
    );
  const commentOnly =
    commentsChangedOnlyBySubjectAdditions &&
    jsonValuesEqual(withoutComments(baseline), withoutComments(pending));
  return {
    commentOnly,
    additions,
    missing,
    conflictingIds,
    satisfied: commentOnly && missing.length === 0 && conflictingIds.length === 0,
  };
}

function withoutComments(snapshot: CollaborationMetadataSnapshot | null): unknown {
  if (snapshot === null) return null;
  return { ...snapshot, comments: {} };
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (isJsonRecord(left) && isJsonRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]))
    );
  }
  return false;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
