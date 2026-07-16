import { describe, expect, it } from 'vitest';

import type { CollaborationMetadataSnapshot } from '../metadata-contracts.js';
import {
  applyCollaborationRejectedCommentDismissals,
  collaborationCommentMetadataEquals,
  collaborationRecoveryCanCheckpoint,
  collaborationRecoveryHasNoLocalIntent,
} from './dismissals.js';

const rejected = {
  id: 'comment-1',
  nodeId: 'node-1',
  authorId: 'local-user',
  body: 'Exact rejected text',
  createdAt: '2026-07-16T12:00:00.000Z',
} as const;

describe('rejected collaboration comment dismissal overlay', () => {
  it('removes only an exact typed value and leaves the delivery candidate immutable', () => {
    const candidate = snapshot(rejected);
    const effective = applyCollaborationRejectedCommentDismissals(candidate, [rejected]);

    expect(effective.comments).toEqual({});
    expect(candidate.comments).toEqual({ [rejected.id]: rejected });
  });

  it('does not remove stale same-ID content', () => {
    const changed = { ...rejected, body: 'New same-ID text' };
    const candidate = snapshot(changed);

    expect(applyCollaborationRejectedCommentDismissals(candidate, [rejected])).toEqual(candidate);
    expect(collaborationCommentMetadataEquals(changed, rejected)).toBe(false);
  });

  it('cascades effective reply and review references without mutating raw evidence', () => {
    const reply = {
      ...rejected,
      id: 'comment-reply',
      body: 'Reply retained independently',
      replyToId: rejected.id,
    };
    const nestedReply = {
      ...rejected,
      id: 'comment-nested-reply',
      body: 'Nested reply retained independently',
      replyToId: reply.id,
    };
    const base = snapshot(rejected);
    const candidate: CollaborationMetadataSnapshot = {
      ...base,
      comments: { [rejected.id]: rejected, [reply.id]: reply, [nestedReply.id]: nestedReply },
      reviews: {
        'review-1': {
          id: 'review-1',
          nodeId: 'node-1',
          reviewerId: 'local-user',
          status: 'changes-requested',
          commentIds: [rejected.id, reply.id, nestedReply.id],
          createdAt: '2026-07-16T12:00:00.000Z',
        },
      },
    };

    const effective = applyCollaborationRejectedCommentDismissals(candidate, [rejected]);
    expect(effective.comments).toEqual({});
    expect(effective.reviews['review-1']?.commentIds).toEqual([]);
    expect(candidate.comments).toEqual({
      [rejected.id]: rejected,
      [reply.id]: reply,
      [nestedReply.id]: nestedReply,
    });
    expect(candidate.reviews['review-1']?.commentIds).toEqual([
      rejected.id,
      reply.id,
      nestedReply.id,
    ]);
  });

  it('separates strict snapshot equality from the no-local-intent baseline proof', () => {
    const baseline = snapshot(rejected);
    const remote = {
      ...snapshot(rejected),
      canvas: { ...snapshot(rejected).canvas, title: 'Remote C' },
    };

    const noLocalIntent = { baseline, pending: baseline, dismissedRejectedComments: [] };
    expect(collaborationRecoveryCanCheckpoint(noLocalIntent, remote)).toBe(false);
    expect(collaborationRecoveryHasNoLocalIntent(noLocalIntent)).toBe(true);
    expect(
      collaborationRecoveryCanCheckpoint(
        {
          baseline,
          pending: { ...baseline, canvas: { ...baseline.canvas, title: 'Local graph edit' } },
          dismissedRejectedComments: [],
        },
        remote,
      ),
    ).toBe(false);
    expect(
      collaborationRecoveryHasNoLocalIntent({
        baseline,
        pending: { ...baseline, canvas: { ...baseline.canvas, title: 'Local graph edit' } },
        dismissedRejectedComments: [],
      }),
    ).toBe(false);
  });

  it('restores an absent review commentIds field when the rejected reference was the only change', () => {
    const base = snapshot(rejected);
    const review = {
      id: 'review-1',
      nodeId: 'node-1',
      reviewerId: 'local-user',
      status: 'changes-requested' as const,
      createdAt: '2026-07-16T12:00:00.000Z',
    };
    const baseline: CollaborationMetadataSnapshot = {
      ...base,
      comments: {},
      reviews: { [review.id]: review },
    };
    const pending: CollaborationMetadataSnapshot = {
      ...baseline,
      comments: { [rejected.id]: rejected },
      reviews: { [review.id]: { ...review, commentIds: [rejected.id] } },
    };

    expect(
      collaborationRecoveryHasNoLocalIntent({
        baseline,
        pending,
        dismissedRejectedComments: [rejected],
      }),
    ).toBe(true);
  });
});

function snapshot(
  comment: CollaborationMetadataSnapshot['comments'][string],
): CollaborationMetadataSnapshot {
  return {
    canvas: {
      id: '00000000-0000-4000-8000-000000000002',
      title: 'Canvas',
      version: 1,
      updatedAt: '2026-07-16T12:00:00.000Z',
    },
    nodes: {
      'node-1': {
        id: 'node-1',
        type: 'task',
        title: 'Task',
        position: { x: 0, y: 0 },
      },
    },
    edges: {},
    groups: {},
    tasks: {},
    comments: { [comment.id]: comment },
    workflow: {},
    reviews: {},
  };
}
