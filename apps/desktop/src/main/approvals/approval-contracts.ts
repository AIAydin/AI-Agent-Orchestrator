import { ApprovalScopeSchema, EntityIdSchema } from '@forgeboard/core';
import { z } from 'zod';

export const ApprovalCreateInputSchema = z
  .object({
    scope: ApprovalScopeSchema,
    decision: z.enum(['approved', 'denied']),
    decidedBy: EntityIdSchema,
    reason: z.string().trim().min(1).max(20_000),
    expiresAt: z.string().datetime({ offset: true }),
    singleUse: z.boolean(),
  })
  .strict();
export type ApprovalCreateInput = z.infer<typeof ApprovalCreateInputSchema>;

export const ApprovalAuthorizationInputSchema = z
  .object({
    approvalId: EntityIdSchema,
    scope: ApprovalScopeSchema,
  })
  .strict();
export type ApprovalAuthorizationInput = z.infer<typeof ApprovalAuthorizationInputSchema>;
