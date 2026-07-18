import { z } from 'zod';

import {
  CollaborationManagementCursorSchema,
  CollaborationManagementIdempotencyKeySchema,
  CollaborationManagementMemberRoleSchema,
  CollaborationManagementMembershipSchema,
  CollaborationManagementTokenVersionSchema,
} from './primitives.js';

const ExpectedTokenVersionHeaderSchema = z
  .string()
  .regex(/^"(0|[1-9][0-9]*)"$/)
  .transform((value) => Number(value.slice(1, -1)))
  .pipe(CollaborationManagementTokenVersionSchema.safe());

const PageLimitQueryValueSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,2}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));

/** Parses the raw values returned by URLSearchParams. */
export const CollaborationMemberListQuerySchema = z
  .object({
    after: CollaborationManagementCursorSchema.optional(),
    limit: PageLimitQueryValueSchema.default('100'),
  })
  .strict();
export type CollaborationMemberListQuery = z.infer<typeof CollaborationMemberListQuerySchema>;

export const CollaborationMemberListResponseSchema = z
  .object({
    members: z.array(CollaborationManagementMembershipSchema).max(100),
    nextCursor: CollaborationManagementCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((page, context) => {
    if (page.hasMore !== (page.nextCursor !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Member pagination cursor does not match hasMore.',
      });
    }
    if (page.members.length === 0 && page.nextCursor !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An empty member page cannot advance the cursor.',
      });
    }
  });
export type CollaborationMemberListResponse = z.infer<typeof CollaborationMemberListResponseSchema>;

export const CollaborationMemberUpdateRequestSchema = z
  .object({
    role: CollaborationManagementMemberRoleSchema,
    expectedTokenVersion: CollaborationManagementTokenVersionSchema,
  })
  .strict();
export type CollaborationMemberUpdateRequest = z.infer<
  typeof CollaborationMemberUpdateRequestSchema
>;

export const CollaborationMemberMutationResponseSchema = z
  .object({
    membership: CollaborationManagementMembershipSchema,
    changed: z.boolean(),
  })
  .strict();
export type CollaborationMemberMutationResponse = z.infer<
  typeof CollaborationMemberMutationResponseSchema
>;

/** Member DELETE requests and successful 204 responses carry no JSON body. */
export const CollaborationMemberDeleteHeadersSchema = z
  .object({
    'idempotency-key': CollaborationManagementIdempotencyKeySchema,
    'if-match': ExpectedTokenVersionHeaderSchema,
  })
  .strict()
  .transform((headers) => ({
    idempotencyKey: headers['idempotency-key'],
    expectedTokenVersion: headers['if-match'],
  }));
export type CollaborationMemberDeleteHeaders = z.infer<
  typeof CollaborationMemberDeleteHeadersSchema
>;

export const CollaborationMemberDeleteRequestBodySchema = z.undefined();
export const CollaborationMemberDeleteResponseBodySchema = z.undefined();
