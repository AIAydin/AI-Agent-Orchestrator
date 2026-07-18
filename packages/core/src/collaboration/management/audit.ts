import { z } from 'zod';

const AuditLimitQueryValueSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,2}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(500));
const AuditAfterQueryValueSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());

export const CollaborationAuditListQuerySchema = z
  .object({
    after: AuditAfterQueryValueSchema.default('0'),
    limit: AuditLimitQueryValueSchema.default('100'),
  })
  .strict();
export type CollaborationAuditListQuery = z.infer<typeof CollaborationAuditListQuerySchema>;

export const CollaborationAuditCategorySchema = z.enum([
  'authorization',
  'room',
  'invite',
  'membership',
  'document',
  'connection',
]);
export const CollaborationAuditOutcomeSchema = z.enum(['allowed', 'denied', 'failed']);
export const CollaborationAuditDetailValueSchema = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const CollaborationAuditDetailKeySchema = z.enum([
  'roomId',
  'actorId',
  'targetId',
  'role',
  'inviteId',
  'reason',
  'bytes',
  'ipHash',
  'origin',
  'route',
  'expiresAt',
  'maxUses',
  'connections',
  'deliveryId',
]);
export const CollaborationAuditDetailsSchema = z
  .record(CollaborationAuditDetailKeySchema, CollaborationAuditDetailValueSchema)
  .superRefine((details, context) => {
    if (Object.keys(details).length > 32) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Too many audit detail fields.' });
    }
  });

export const CollaborationAuditEventSchema = z
  .object({
    sequence: z.number().int().positive().safe(),
    occurredAt: z.string().datetime({ offset: true }),
    category: CollaborationAuditCategorySchema,
    action: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9._-]*$/),
    outcome: CollaborationAuditOutcomeSchema,
    details: CollaborationAuditDetailsSchema,
    previousHash: z.string().regex(/^[a-f0-9]{64}$/),
    eventHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CollaborationAuditEvent = z.infer<typeof CollaborationAuditEventSchema>;

export const CollaborationAuditListResponseSchema = z
  .object({
    events: z.array(CollaborationAuditEventSchema).max(500),
    nextAfter: z.number().int().positive().safe().nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((page, context) => {
    if (page.hasMore !== (page.nextAfter !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Audit pagination cursor does not match hasMore.',
      });
    }
    if (page.events.length === 0 && page.nextAfter !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An empty audit page cannot advance the cursor.',
      });
    }
    if (page.nextAfter !== null && page.events.at(-1)?.sequence !== page.nextAfter) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The audit cursor must identify the last returned event.',
      });
    }
  });
export type CollaborationAuditListResponse = z.infer<typeof CollaborationAuditListResponseSchema>;
