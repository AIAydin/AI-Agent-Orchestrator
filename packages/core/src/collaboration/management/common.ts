import { z } from 'zod';

import {
  CollaborationManagementAccessTokenSchema,
  CollaborationManagementIdempotencyKeySchema,
  CollaborationManagementOwnerMembershipSchema,
  CollaborationManagementRoomSchema,
  CollaborationManagementTimestampSchema,
} from './primitives.js';

export const COLLABORATION_MANAGEMENT_IDEMPOTENCY_HEADER = 'Idempotency-Key' as const;
export const COLLABORATION_MANAGEMENT_EXPECTED_VERSION_HEADER = 'If-Match' as const;

/** Projection of the idempotency header after Node normalizes its name to lowercase. */
export const CollaborationManagementIdempotencyHeadersSchema = z
  .object({ 'idempotency-key': CollaborationManagementIdempotencyKeySchema })
  .strict();
export type CollaborationManagementIdempotencyHeaders = z.infer<
  typeof CollaborationManagementIdempotencyHeadersSchema
>;

export const CollaborationManagementOwnerAccessResponseSchema = z
  .object({
    room: CollaborationManagementRoomSchema,
    membership: CollaborationManagementOwnerMembershipSchema,
    accessToken: CollaborationManagementAccessTokenSchema,
    expiresAt: CollaborationManagementTimestampSchema,
  })
  .strict();
export type CollaborationManagementOwnerAccessResponse = z.infer<
  typeof CollaborationManagementOwnerAccessResponseSchema
>;

/** Token-free durable projection used to reconstruct an idempotent access response. */
export const CollaborationManagementOwnerAccessReplaySchema =
  CollaborationManagementOwnerAccessResponseSchema.omit({ accessToken: true }).strict();
export type CollaborationManagementOwnerAccessReplay = z.infer<
  typeof CollaborationManagementOwnerAccessReplaySchema
>;

export const CollaborationManagementErrorCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]*$/);

export const CollaborationManagementErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: CollaborationManagementErrorCodeSchema,
        message: z.string().trim().min(1).max(4_096),
        retryAfterSeconds: z.number().int().positive().max(2_147_483_647).optional(),
      })
      .strict(),
  })
  .strict();
export type CollaborationManagementErrorResponse = z.infer<
  typeof CollaborationManagementErrorResponseSchema
>;
