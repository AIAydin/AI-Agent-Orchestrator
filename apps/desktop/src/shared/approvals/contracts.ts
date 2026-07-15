import { EntityIdSchema } from '@forgeboard/core/domain';
import { ApprovalActionSchema, ApprovalRecordSchema } from '@forgeboard/core/permissions';
import { z } from 'zod';

export const ApprovalStatusSchema = z.enum(['active', 'denied', 'expired', 'revoked', 'consumed']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRevocationInputSchema = z
  .object({
    approvalId: EntityIdSchema,
    projectId: EntityIdSchema,
  })
  .strict();
export type ApprovalRevocationInput = z.infer<typeof ApprovalRevocationInputSchema>;

export const ApprovalListInputSchema = z
  .object({
    projectId: EntityIdSchema.optional(),
    action: ApprovalActionSchema.optional(),
    includeInactive: z.boolean().default(true),
    limit: z.number().int().min(1).max(1_000).default(200),
  })
  .strict();
export type ApprovalListInput = z.input<typeof ApprovalListInputSchema>;

export const ApprovalViewSchema = z
  .object({
    record: ApprovalRecordSchema,
    status: ApprovalStatusSchema,
  })
  .strict();
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;
