import { z } from 'zod';

import { CollaborationPublishReceiptSchema } from '@forgeboard/core/collaboration-delivery';

import { CollaborationMetadataSnapshotSchema } from '../metadata-contracts.js';
import { CollaborationCommentMetadataSchema } from '../metadata-contracts.js';
import { CollaborationIdSchema, CollaborationTimestampSchema } from '../values.js';

export const CollaborationLocalCanvasScopeSchema = z
  .object({
    projectId: z.string().uuid(),
    canvasId: z.string().uuid(),
  })
  .strict();
export type CollaborationLocalCanvasScope = z.infer<typeof CollaborationLocalCanvasScopeSchema>;

export const CollaborationRejectedCommentEntrySchema = z
  .object({
    comment: CollaborationCommentMetadataSchema,
    rejectedDeliveryId: z.string().uuid(),
  })
  .strict();
export type CollaborationRejectedCommentEntry = z.infer<
  typeof CollaborationRejectedCommentEntrySchema
>;

export const CollaborationSyncRecoverySchema = z
  .object({
    baseline: CollaborationMetadataSnapshotSchema.nullable(),
    pending: CollaborationMetadataSnapshotSchema,
    deliveryId: z.string().uuid().optional(),
    snapshotDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    disposition: z.enum([
      'staged',
      'sent',
      'queued-offline',
      'acknowledged',
      'rejected',
      'synchronized',
    ]),
    // Optional on the wire for compatibility with an in-flight renderer during desktop updates.
    // Current main-process recovery always supplies the storage-derived list.
    rejectedCommentIds: z.array(CollaborationIdSchema).max(50_000).optional(),
    // Exact bounded values let the renderer surface rejected user work without replaying it.
    rejectedComments: z.array(CollaborationCommentMetadataSchema).max(50_000).optional(),
    // Sequence-bound entries prevent a stale UI from dismissing a newer same-value rejection.
    rejectedCommentEntries: z.array(CollaborationRejectedCommentEntrySchema).max(50_000).optional(),
    // Local-only exact values overlay pending candidates without rewriting delivery evidence.
    dismissedRejectedComments: z.array(CollaborationCommentMetadataSchema).max(50_000).optional(),
    dismissedRejectedCommentEntries: z
      .array(CollaborationRejectedCommentEntrySchema)
      .max(50_000)
      .optional(),
    expiresAt: CollaborationTimestampSchema,
    replayedReceipt: CollaborationPublishReceiptSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const delivered =
      value.disposition === 'sent' ||
      value.disposition === 'queued-offline' ||
      value.disposition === 'acknowledged' ||
      value.disposition === 'rejected';
    if (delivered !== (value.deliveryId !== undefined && value.snapshotDigest !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Delivery identity and digest must match the recovery disposition.',
      });
    }
    if (
      value.replayedReceipt !== undefined &&
      (value.replayedReceipt.deliveryId !== value.deliveryId ||
        value.replayedReceipt.snapshotDigest !== value.snapshotDigest)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A replayed comment receipt must match the durable delivery identity.',
      });
    }
  });
export type CollaborationSyncRecovery = z.infer<typeof CollaborationSyncRecoverySchema>;

export const CollaborationSyncRecoverInputSchema = CollaborationLocalCanvasScopeSchema;
export type CollaborationSyncRecoverInput = CollaborationLocalCanvasScope;

export const CollaborationDiscardRejectedCommentInputSchema =
  CollaborationLocalCanvasScopeSchema.extend({
    comment: CollaborationCommentMetadataSchema,
    rejectedDeliveryId: z.string().uuid(),
  }).strict();
export type CollaborationDiscardRejectedCommentInput = z.infer<
  typeof CollaborationDiscardRejectedCommentInputSchema
>;

export const CollaborationSyncCheckpointInputSchema = CollaborationLocalCanvasScopeSchema.extend({
  snapshot: CollaborationMetadataSnapshotSchema,
}).strict();
export type CollaborationSyncCheckpointInput = z.infer<
  typeof CollaborationSyncCheckpointInputSchema
>;

export const CollaborationDurablePublishInputSchema = CollaborationLocalCanvasScopeSchema.extend({
  baseline: CollaborationMetadataSnapshotSchema.nullable(),
  snapshot: CollaborationMetadataSnapshotSchema,
}).strict();
export type CollaborationDurablePublishInput = z.infer<
  typeof CollaborationDurablePublishInputSchema
>;
