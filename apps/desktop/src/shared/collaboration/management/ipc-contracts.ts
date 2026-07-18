import {
  CollaborationAuditListResponseSchema,
  CollaborationManagementCursorSchema,
  CollaborationManagementMemberRoleSchema,
  CollaborationManagementMembershipSchema,
  CollaborationManagementTokenVersionSchema,
  CollaborationMemberListResponseSchema,
  CollaborationMemberMutationResponseSchema,
} from '@forgeboard/core/collaboration-management';
import { z } from 'zod';

import { CollaborationConnectionSchema } from '../connection-contracts.js';
import {
  CollaborationColorSchema,
  CollaborationDisplayNameSchema,
  CollaborationManagementUrlSchema,
  CollaborationRoomIdSchema,
  CollaborationServerUrlSchema,
  CollaborationSubjectSchema,
  CollaborationTimestampSchema,
} from '../values.js';

export const CollaborationAdminTokenSchema = z
  .string()
  .trim()
  .max(8_192)
  .refine((value) => !/[\0\r\n]/u.test(value), {
    message: 'Collaboration administrator tokens cannot contain line breaks or NUL bytes.',
  });

const CollaborationOwnerAccessBaseSchema = z
  .object({
    serverUrl: CollaborationServerUrlSchema,
    managementBaseUrl: CollaborationManagementUrlSchema,
    roomId: CollaborationRoomIdSchema,
    subject: CollaborationSubjectSchema,
    displayName: CollaborationDisplayNameSchema,
    color: CollaborationColorSchema,
    adminToken: CollaborationAdminTokenSchema.optional(),
    reconnect: z.boolean().default(true),
  })
  .strict();

export const CollaborationRoomBootstrapJoinInputSchema = CollaborationOwnerAccessBaseSchema;
export type CollaborationRoomBootstrapJoinInput = z.infer<
  typeof CollaborationRoomBootstrapJoinInputSchema
>;

export const CollaborationOwnerRecoverJoinInputSchema = CollaborationOwnerAccessBaseSchema;
export type CollaborationOwnerRecoverJoinInput = z.infer<
  typeof CollaborationOwnerRecoverJoinInputSchema
>;

export const CollaborationOwnerSessionViewSchema = z
  .object({
    connection: CollaborationConnectionSchema,
    expiresAt: CollaborationTimestampSchema,
    tokenVersion: CollaborationManagementTokenVersionSchema,
  })
  .strict()
  .superRefine((view, context) => {
    if (view.connection.status !== 'connected' || view.connection.role !== 'owner') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connection'],
        message: 'An owner session view must contain a connected owner.',
      });
    }
  });
export type CollaborationOwnerSessionView = z.infer<typeof CollaborationOwnerSessionViewSchema>;

export const CollaborationRoomMemberListInputSchema = z
  .object({
    after: CollaborationManagementCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict();
export type CollaborationRoomMemberListInput = z.infer<
  typeof CollaborationRoomMemberListInputSchema
>;

export const CollaborationRoomMemberUpdateInputSchema = z
  .object({
    subject: CollaborationSubjectSchema,
    role: CollaborationManagementMemberRoleSchema,
    expectedTokenVersion: CollaborationManagementTokenVersionSchema,
  })
  .strict();
export type CollaborationRoomMemberUpdateInput = z.infer<
  typeof CollaborationRoomMemberUpdateInputSchema
>;

export const CollaborationRoomMemberRevokeInputSchema = z
  .object({
    subject: CollaborationSubjectSchema,
    expectedTokenVersion: CollaborationManagementTokenVersionSchema,
  })
  .strict();
export type CollaborationRoomMemberRevokeInput = z.infer<
  typeof CollaborationRoomMemberRevokeInputSchema
>;

export const CollaborationRoomAuditListInputSchema = z
  .object({
    after: z.number().int().nonnegative().safe().default(0),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();
export type CollaborationRoomAuditListInput = z.infer<typeof CollaborationRoomAuditListInputSchema>;

export {
  CollaborationAuditListResponseSchema as CollaborationRoomAuditPageSchema,
  CollaborationManagementMembershipSchema as CollaborationRoomMemberViewSchema,
  CollaborationMemberListResponseSchema as CollaborationRoomMemberPageSchema,
  CollaborationMemberMutationResponseSchema as CollaborationRoomMemberMutationSchema,
};
export type {
  CollaborationAuditListResponse as CollaborationRoomAuditPage,
  CollaborationManagementMembership as CollaborationRoomMemberView,
  CollaborationMemberListResponse as CollaborationRoomMemberPage,
  CollaborationMemberMutationResponse as CollaborationRoomMemberMutation,
} from '@forgeboard/core/collaboration-management';
