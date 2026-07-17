import { z } from 'zod';

import { EntityIdSchema, TimestampSchema } from '../model/domain.js';

export const OutputPublicationSchema = z
  .object({
    edgeId: EntityIdSchema,
    runId: EntityIdSchema,
    producerNodeId: EntityIdSchema,
    producerAttempt: z.number().int().positive(),
    outputKind: z.enum(['branch', 'diff', 'preview', 'test-result', 'artifact']),
    referenceIds: z
      .array(EntityIdSchema)
      .min(1)
      .max(10_000)
      .refine((values) => new Set(values).size === values.length, {
        message: 'Output reference IDs must be unique',
      }),
    contentDigest: z.string().min(8).max(256),
    verifiedAt: TimestampSchema,
    verifierId: EntityIdSchema,
  })
  .strict();

export const NodeCompletionOutputSchema = z
  .object({
    runId: EntityIdSchema,
    nodeId: EntityIdSchema,
    nodeAttempt: z.number().int().positive(),
    contentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    sourceRunId: EntityIdSchema,
    worktreePath: z.string().min(1).max(32_768),
    artifactContent: z.string().max(600_000),
    verifiedAt: TimestampSchema,
    verifierId: EntityIdSchema,
  })
  .strict();

export const ContextResolutionSchema = z
  .object({
    edgeId: EntityIdSchema,
    runId: EntityIdSchema,
    sourceNodeId: EntityIdSchema,
    targetNodeId: EntityIdSchema,
    targetAttempt: z.number().int().positive(),
    attachmentIds: z.array(EntityIdSchema).max(10_000),
    contentDigest: z.string().min(8).max(256),
    verifiedAt: TimestampSchema,
    verifierId: EntityIdSchema,
  })
  .strict();

export const WorkflowHumanApprovalRequestSchema = z
  .object({
    runId: EntityIdSchema,
    targetId: EntityIdSchema,
    targetType: z.enum(['execute-edge', 'human-review', 'review-gate']),
    targetAttempt: z.number().int().positive(),
    evidenceFingerprint: z.string().min(1).max(1_000_000),
  })
  .strict();

export const WorkflowHumanApprovalSchema = WorkflowHumanApprovalRequestSchema.extend({
  approvalId: EntityIdSchema,
  approvedBy: EntityIdSchema,
  approvedAt: TimestampSchema,
}).strict();

export const WorkflowHumanReviewDecisionSchema = WorkflowHumanApprovalRequestSchema.extend({
  decisionId: EntityIdSchema,
  decision: z.enum(['approved', 'changes-requested']),
  feedback: z.string().min(1).max(200_000).optional(),
  decidedBy: EntityIdSchema,
  decidedAt: TimestampSchema,
})
  .strict()
  .superRefine((decision, context) => {
    if (decision.decision === 'changes-requested' && decision.feedback === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feedback'],
        message: 'A human change request requires actionable feedback',
      });
    }
  });

export const RevisionEscapeRequestSchema = z
  .object({
    runId: EntityIdSchema,
    loopId: EntityIdSchema,
    attemptsStarted: z.number().int().positive(),
    evidenceFingerprint: z.string().min(1).max(1_000_000),
  })
  .strict();

export const RevisionEscapeResolutionSchema = RevisionEscapeRequestSchema.extend({
  decision: z.enum(['accept', 'cancel']),
  decidedBy: EntityIdSchema,
  decidedAt: TimestampSchema,
}).strict();
