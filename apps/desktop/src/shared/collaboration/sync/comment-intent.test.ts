import { describe, expect, it } from 'vitest';

import { CollaborationMetadataSnapshotSchema } from '../metadata-contracts.js';
import { analyzeCollaborationCommentRecovery } from './comment-intent.js';

const NOW = '2026-07-15T12:00:00.000Z';

describe('analyzeCollaborationCommentRecovery', () => {
  it('separates authenticated comment additions from graph authority and remote changes', () => {
    const baseline = snapshot();
    const comment = {
      id: 'comment-1',
      nodeId: 'node-1',
      authorId: 'reviewer-1',
      body: 'Please revise this.',
      resolved: false,
      createdAt: NOW,
    };
    const pending = CollaborationMetadataSnapshotSchema.parse({
      ...baseline,
      comments: { [comment.id]: comment },
    });
    const delivered = CollaborationMetadataSnapshotSchema.parse({
      ...pending,
      canvas: { ...pending.canvas, title: 'Remote title' },
    });

    expect(
      analyzeCollaborationCommentRecovery(baseline, pending, delivered, 'reviewer-1'),
    ).toMatchObject({ commentOnly: true, missing: [], conflictingIds: [], satisfied: true });
    expect(
      analyzeCollaborationCommentRecovery(baseline, pending, baseline, 'reviewer-1'),
    ).toMatchObject({
      commentOnly: true,
      missing: [{ id: 'comment-1' }],
      satisfied: false,
    });
    expect(
      analyzeCollaborationCommentRecovery(
        baseline,
        { ...pending, canvas: { ...pending.canvas, title: 'Local graph edit' } },
        delivered,
        'reviewer-1',
      ).commentOnly,
    ).toBe(false);
  });
});

function snapshot() {
  return CollaborationMetadataSnapshotSchema.parse({
    canvas: { id: 'canvas-1', title: 'Canvas', version: 1, updatedAt: NOW },
    nodes: {
      'node-1': {
        id: 'node-1',
        type: 'task',
        title: 'Task',
        position: { x: 1, y: 2 },
      },
    },
    edges: {},
    groups: {},
    tasks: {},
    comments: {},
    workflow: {},
    reviews: {},
  });
}
