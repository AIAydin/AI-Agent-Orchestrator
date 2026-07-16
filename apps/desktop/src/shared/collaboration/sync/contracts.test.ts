import { describe, expect, it } from 'vitest';

import {
  CollaborationDiscardRejectedCommentInputSchema,
  CollaborationSyncRecoverySchema,
} from './contracts.js';

const snapshot = {
  canvas: {
    id: '00000000-0000-4000-8000-000000000030',
    title: 'Canvas',
    version: 1,
    updatedAt: '2026-07-15T12:00:00.000Z',
  },
  nodes: {},
  edges: {},
  groups: {},
  tasks: {},
  comments: {},
  workflow: {},
  reviews: {},
};

describe('CollaborationSyncRecoverySchema', () => {
  it('requires delivery identity and digest together for delivered states', () => {
    const base = {
      baseline: snapshot,
      pending: snapshot,
      expiresAt: '2026-08-14T12:00:00.000Z',
    };
    expect(
      CollaborationSyncRecoverySchema.safeParse({
        ...base,
        disposition: 'sent',
      }).success,
    ).toBe(false);
    expect(
      CollaborationSyncRecoverySchema.safeParse({
        ...base,
        disposition: 'sent',
        deliveryId: '00000000-0000-4000-8000-000000000090',
        snapshotDigest: 'a'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      CollaborationSyncRecoverySchema.safeParse({
        ...base,
        disposition: 'sent',
        deliveryId: '00000000-0000-4000-8000-000000000090',
        snapshotDigest: 'a'.repeat(64),
        rejectedCommentIds: [''],
      }).success,
    ).toBe(false);
    expect(
      CollaborationSyncRecoverySchema.safeParse({
        ...base,
        disposition: 'sent',
        deliveryId: '00000000-0000-4000-8000-000000000090',
        snapshotDigest: 'a'.repeat(64),
        replayedReceipt: {
          deliveryId: '00000000-0000-4000-8000-000000000091',
          snapshotDigest: 'a'.repeat(64),
          disposition: 'sent',
        },
      }).success,
    ).toBe(false);
  });

  it('requires exact comment values paired with an opaque rejected delivery token', () => {
    const comment = {
      id: 'comment-1',
      nodeId: 'node-1',
      authorId: 'local-user',
      body: 'Exact rejected text',
      createdAt: '2026-07-15T12:00:00.000Z',
    };
    const rejectedDeliveryId = '00000000-0000-4000-8000-000000000090';
    expect(
      CollaborationSyncRecoverySchema.safeParse({
        baseline: snapshot,
        pending: snapshot,
        disposition: 'synchronized',
        rejectedCommentEntries: [{ comment, rejectedDeliveryId }],
        expiresAt: '2026-08-14T12:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      CollaborationDiscardRejectedCommentInputSchema.safeParse({
        projectId: '00000000-0000-4000-8000-000000000020',
        canvasId: '00000000-0000-4000-8000-000000000030',
        comment,
        rejectedDeliveryId,
      }).success,
    ).toBe(true);
    expect(
      CollaborationDiscardRejectedCommentInputSchema.safeParse({
        projectId: '00000000-0000-4000-8000-000000000020',
        canvasId: '00000000-0000-4000-8000-000000000030',
        commentId: comment.id,
        rejectedDeliveryId,
      }).success,
    ).toBe(false);
    expect(
      CollaborationDiscardRejectedCommentInputSchema.safeParse({
        projectId: '00000000-0000-4000-8000-000000000020',
        canvasId: '00000000-0000-4000-8000-000000000030',
        comment,
        rejectedDeliveryId: 'not-a-delivery-id',
      }).success,
    ).toBe(false);
  });
});
