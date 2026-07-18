import { z } from 'zod';

export const CollaborationManagementRoleSchema = z.enum(['owner', 'editor', 'reviewer', 'viewer']);
export type CollaborationManagementRole = z.infer<typeof CollaborationManagementRoleSchema>;

export const CollaborationManagementMemberRoleSchema = z.enum(['editor', 'reviewer', 'viewer']);
export type CollaborationManagementMemberRole = z.infer<
  typeof CollaborationManagementMemberRoleSchema
>;

export const CollaborationManagementRoomIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const CollaborationManagementSubjectIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:@._-]*$/);

export const CollaborationManagementDisplayNameSchema = z.string().trim().min(1).max(80);
export const CollaborationManagementTokenVersionSchema = z.number().int().nonnegative().safe();
export const CollaborationManagementTimestampSchema = z.string().datetime({ offset: true });
export const CollaborationManagementAccessTokenSchema = z.string().min(1).max(8_192);
export const CollaborationManagementIdempotencyKeySchema = z.string().uuid();
export const CollaborationManagementCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const CollaborationManagementRoomSchema = z
  .object({ id: CollaborationManagementRoomIdSchema })
  .strict();
export type CollaborationManagementRoom = z.infer<typeof CollaborationManagementRoomSchema>;

export const CollaborationManagementMembershipSchema = z
  .object({
    subject: CollaborationManagementSubjectIdSchema,
    displayName: CollaborationManagementDisplayNameSchema,
    role: CollaborationManagementRoleSchema,
    tokenVersion: CollaborationManagementTokenVersionSchema,
  })
  .strict();
export type CollaborationManagementMembership = z.infer<
  typeof CollaborationManagementMembershipSchema
>;

export const CollaborationManagementOwnerMembershipSchema =
  CollaborationManagementMembershipSchema.extend({ role: z.literal('owner') }).strict();
export type CollaborationManagementOwnerMembership = z.infer<
  typeof CollaborationManagementOwnerMembershipSchema
>;
