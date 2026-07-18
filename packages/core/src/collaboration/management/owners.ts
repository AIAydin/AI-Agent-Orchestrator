import { z } from 'zod';

import { CollaborationManagementOwnerAccessResponseSchema } from './common.js';
import { CollaborationManagementSubjectIdSchema } from './primitives.js';

/** Refresh is authenticated by the current owner bearer and has no request body. */
export const CollaborationOwnerRefreshRequestBodySchema = z.undefined();

export const CollaborationOwnerRefreshResponseSchema =
  CollaborationManagementOwnerAccessResponseSchema;
export type CollaborationOwnerRefreshResponse = z.infer<
  typeof CollaborationOwnerRefreshResponseSchema
>;

export const CollaborationOwnerRecoverRequestSchema = z
  .object({ ownerId: CollaborationManagementSubjectIdSchema })
  .strict();
export type CollaborationOwnerRecoverRequest = z.infer<
  typeof CollaborationOwnerRecoverRequestSchema
>;

export const CollaborationOwnerRecoverResponseSchema =
  CollaborationManagementOwnerAccessResponseSchema;
export type CollaborationOwnerRecoverResponse = z.infer<
  typeof CollaborationOwnerRecoverResponseSchema
>;
