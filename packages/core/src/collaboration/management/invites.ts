import { z } from 'zod';

import {
  CollaborationManagementCursorSchema,
  CollaborationManagementMemberRoleSchema,
  CollaborationManagementRoomIdSchema,
  CollaborationManagementTimestampSchema,
} from './primitives.js';

const InviteLimitQueryValueSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,2}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));

export const CollaborationInviteListQuerySchema = z
  .object({
    after: CollaborationManagementCursorSchema.optional(),
    limit: InviteLimitQueryValueSchema.default('50'),
  })
  .strict();
export type CollaborationInviteListQuery = z.infer<typeof CollaborationInviteListQuerySchema>;

export const CollaborationManagementInviteStatusSchema = z.enum([
  'active',
  'expired',
  'exhausted',
  'revoked',
  'invalidated',
]);
export type CollaborationManagementInviteStatus = z.infer<
  typeof CollaborationManagementInviteStatusSchema
>;

/** Durable, token-free invite history safe to return to an authenticated room owner. */
export const CollaborationManagementInviteFieldsSchema = z
  .object({
    id: z.string().uuid(),
    roomId: CollaborationManagementRoomIdSchema,
    role: CollaborationManagementMemberRoleSchema,
    createdAt: CollaborationManagementTimestampSchema,
    expiresAt: CollaborationManagementTimestampSchema,
    maxUses: z.number().int().min(1).max(100),
    useCount: z.number().int().nonnegative().max(100),
    revokedAt: CollaborationManagementTimestampSchema.nullable(),
    status: CollaborationManagementInviteStatusSchema,
  })
  .strict();

export const CollaborationManagementInviteSchema =
  CollaborationManagementInviteFieldsSchema.superRefine((invite, context) => {
    if ((invite.revokedAt !== null) !== (invite.status === 'revoked')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Revoked invite state is inconsistent.',
      });
    }
    if (invite.revokedAt === null && invite.useCount > invite.maxUses) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['useCount'],
        message: 'Invite use count cannot exceed its maximum uses.',
      });
    }
  });
export type CollaborationManagementInvite = z.infer<typeof CollaborationManagementInviteSchema>;

export const CollaborationInviteListResponseFieldsSchema = z
  .object({
    invites: z.array(CollaborationManagementInviteSchema).max(100),
    nextCursor: CollaborationManagementCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export const CollaborationInviteListResponseSchema =
  CollaborationInviteListResponseFieldsSchema.superRefine((page, context) => {
    if (page.hasMore !== (page.nextCursor !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invite pagination cursor does not match hasMore.',
      });
    }
    if (page.invites.length === 0 && page.nextCursor !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An empty invite page cannot advance the cursor.',
      });
    }
  });
export type CollaborationInviteListResponse = z.infer<typeof CollaborationInviteListResponseSchema>;

export const CollaborationInviteRevokeResponseSchema = z
  .object({ invite: CollaborationManagementInviteSchema })
  .strict();
export type CollaborationInviteRevokeResponse = z.infer<
  typeof CollaborationInviteRevokeResponseSchema
>;
