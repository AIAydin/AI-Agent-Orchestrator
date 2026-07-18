import { z } from 'zod';

import { CollaborationManagementOwnerAccessResponseSchema } from './common.js';
import {
  CollaborationManagementDisplayNameSchema,
  CollaborationManagementRoomIdSchema,
  CollaborationManagementSubjectIdSchema,
} from './primitives.js';

export const CollaborationRoomBootstrapRequestSchema = z
  .object({
    roomId: CollaborationManagementRoomIdSchema,
    owner: z
      .object({
        id: CollaborationManagementSubjectIdSchema,
        displayName: CollaborationManagementDisplayNameSchema,
      })
      .strict(),
  })
  .strict();
export type CollaborationRoomBootstrapRequest = z.infer<
  typeof CollaborationRoomBootstrapRequestSchema
>;

export const CollaborationRoomBootstrapResponseSchema =
  CollaborationManagementOwnerAccessResponseSchema;
export type CollaborationRoomBootstrapResponse = z.infer<
  typeof CollaborationRoomBootstrapResponseSchema
>;
