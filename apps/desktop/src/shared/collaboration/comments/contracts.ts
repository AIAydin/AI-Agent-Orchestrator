import { z } from 'zod';

import { CollaborationCommentMetadataSchema } from '../metadata-contracts.js';
import { CollaborationIdSchema } from '../values.js';
import { CollaborationLocalCanvasScopeSchema } from '../sync/contracts.js';
import { CollaborationPublishReceiptSchema } from '@forgeboard/core/collaboration-delivery';

export const CollaborationCreateCommentInputSchema = CollaborationLocalCanvasScopeSchema.extend({
  nodeId: CollaborationIdSchema,
  body: z.string().trim().min(1).max(4_000),
}).strict();
export type CollaborationCreateCommentInput = z.infer<typeof CollaborationCreateCommentInputSchema>;

export const CollaborationCreateCommentResultSchema = z
  .object({
    comment: CollaborationCommentMetadataSchema,
    receipt: CollaborationPublishReceiptSchema,
  })
  .strict();
export type CollaborationCreateCommentResult = z.infer<
  typeof CollaborationCreateCommentResultSchema
>;
