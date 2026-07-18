import { JsonValueSchema, RunStatusSchema } from '@forgeboard/core/domain';
import { WorkflowRunScopeSchema } from '@forgeboard/core/workflow-runtime';
import { z } from 'zod';
import {
  CheckArtifactReferenceSchema,
  CheckExecutionStatusSchema,
  ParsedCheckSummarySchema,
} from '../checks/contracts.js';

const WorkflowIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const WorkflowTimestampSchema = z.string().datetime({ offset: true });

export const WORKFLOW_IPC_CHANNELS = Object.freeze({
  start: 'workflows:start',
  get: 'workflows:get',
  list: 'workflows:list',
  approveNode: 'workflows:approve-node',
  approveHuman: 'workflows:approve-human',
  decideReview: 'workflows:decide-review',
  resolveRevisionEscape: 'workflows:resolve-revision-escape',
  cancel: 'workflows:cancel',
  cancelNode: 'workflows:cancel-node',
  revealArtifact: 'workflows:reveal-artifact',
  openArtifact: 'workflows:open-artifact',
  sendInput: 'workflows:send-input',
  interrupt: 'workflows:interrupt',
  event: 'workflows:event',
  interactionEvent: 'workflows:interaction-event',
} as const);

export const WORKFLOW_NODE_INPUT_MAX_CODE_UNITS = 65_536;
export const WORKFLOW_INTERACTION_TEXT_MAX_CODE_UNITS = 32_768;

export const WorkflowStartInputSchema = z
  .object({
    projectId: WorkflowIdSchema,
    canvasId: WorkflowIdSchema,
    scope: WorkflowRunScopeSchema,
  })
  .strict();
export type WorkflowStartInput = z.infer<typeof WorkflowStartInputSchema>;

export const WorkflowGetInputSchema = z.object({ executionId: WorkflowIdSchema }).strict();
export type WorkflowGetInput = z.infer<typeof WorkflowGetInputSchema>;

export const WorkflowListInputSchema = z
  .object({
    projectId: WorkflowIdSchema,
    canvasId: WorkflowIdSchema.optional(),
    limit: z.number().int().positive().max(200).default(50),
  })
  .strict();
export type WorkflowListInput = z.infer<typeof WorkflowListInputSchema>;

export const WorkflowApproveNodeInputSchema = z
  .object({
    executionId: WorkflowIdSchema,
    nodeId: WorkflowIdSchema,
    preparationId: WorkflowIdSchema,
    approvalFingerprint: z.string().min(8).max(512),
    confirmed: z.literal(true),
  })
  .strict();
export type WorkflowApproveNodeInput = z.infer<typeof WorkflowApproveNodeInputSchema>;

export const WorkflowCancelInputSchema = z
  .object({ executionId: WorkflowIdSchema, confirmed: z.literal(true) })
  .strict();
export type WorkflowCancelInput = z.infer<typeof WorkflowCancelInputSchema>;

const WorkflowNodeInteractionIdentitySchema = z
  .object({
    executionId: WorkflowIdSchema,
    nodeId: WorkflowIdSchema,
    attempt: z.number().int().positive().max(10_000),
  })
  .strict();

export const WorkflowNodeInputSchema = WorkflowNodeInteractionIdentitySchema.extend({
  data: z
    .string()
    .min(1)
    .max(WORKFLOW_NODE_INPUT_MAX_CODE_UNITS)
    .refine((value) => !value.includes('\0'), {
      message: 'Workflow node input cannot contain NUL bytes.',
    }),
}).strict();
export type WorkflowNodeInput = z.infer<typeof WorkflowNodeInputSchema>;

export const WorkflowNodeInterruptSchema = WorkflowNodeInteractionIdentitySchema;
export type WorkflowNodeInterrupt = z.infer<typeof WorkflowNodeInterruptSchema>;

export const WorkflowCancelNodeInputSchema = WorkflowNodeInteractionIdentitySchema.extend({
  confirmed: z.literal(true),
}).strict();
export type WorkflowCancelNodeInput = z.infer<typeof WorkflowCancelNodeInputSchema>;

export const WorkflowArtifactReferenceSchema = CheckArtifactReferenceSchema;
export type WorkflowArtifactReference = z.infer<typeof WorkflowArtifactReferenceSchema>;

export const WorkflowArtifactActionInputSchema = WorkflowArtifactReferenceSchema.pick({
  executionId: true,
  nodeId: true,
  attempt: true,
  relativePath: true,
  sha256: true,
})
  .extend({
    checkExecutionId: z.string().uuid(),
  })
  .strict();
export type WorkflowArtifactActionInput = z.infer<typeof WorkflowArtifactActionInputSchema>;

export const WorkflowTestResultSchema = WorkflowNodeInteractionIdentitySchema.extend({
  checkExecutionId: z.string().uuid(),
  status: CheckExecutionStatusSchema,
  exitCode: z.number().int().nullable(),
  output: z.string().max(1_048_576),
  outputTruncated: z.boolean(),
  summary: ParsedCheckSummarySchema.nullable(),
  artifacts: z.array(WorkflowArtifactReferenceSchema).max(32),
  startedAt: WorkflowTimestampSchema.nullable(),
  endedAt: WorkflowTimestampSchema.nullable(),
}).strict();
export type WorkflowTestResult = z.infer<typeof WorkflowTestResultSchema>;

const WorkflowHumanRequestIdentitySchema = z
  .object({
    executionId: WorkflowIdSchema,
    targetId: WorkflowIdSchema,
    targetType: z.enum(['execute-edge', 'human-review', 'review-gate']),
    targetAttempt: z.number().int().positive(),
    evidenceFingerprint: z.string().min(1).max(1_000_000),
  })
  .strict();

export const WorkflowHumanDecisionRequestSchema = WorkflowHumanRequestIdentitySchema.extend({
  evidence: JsonValueSchema,
}).strict();
export type WorkflowHumanDecisionRequest = z.infer<typeof WorkflowHumanDecisionRequestSchema>;

export const WorkflowApproveHumanDecisionInputSchema = WorkflowHumanRequestIdentitySchema.extend({
  targetType: z.enum(['execute-edge', 'review-gate']),
  confirmed: z.literal(true),
}).strict();
export type WorkflowApproveHumanDecisionInput = z.infer<
  typeof WorkflowApproveHumanDecisionInputSchema
>;

export const WorkflowReviewDecisionInputSchema = WorkflowHumanRequestIdentitySchema.extend({
  targetType: z.literal('human-review'),
  decision: z.enum(['approved', 'changes-requested']),
  feedback: z.string().trim().min(1).max(200_000).optional(),
  confirmed: z.literal(true),
})
  .strict()
  .superRefine((input, context) => {
    if (input.decision === 'changes-requested' && input.feedback === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feedback'],
        message: 'Say what should change before asking for changes.',
      });
    }
  });
export type WorkflowReviewDecisionInput = z.infer<typeof WorkflowReviewDecisionInputSchema>;

const WorkflowRevisionEscapeIdentitySchema = z
  .object({
    executionId: WorkflowIdSchema,
    loopId: WorkflowIdSchema,
    attemptsStarted: z.number().int().positive(),
    evidenceFingerprint: z.string().min(1).max(1_000_000),
  })
  .strict();
export const WorkflowRevisionEscapeRequestSchema = WorkflowRevisionEscapeIdentitySchema.extend({
  evidence: JsonValueSchema,
}).strict();
export type WorkflowRevisionEscapeRequest = z.infer<typeof WorkflowRevisionEscapeRequestSchema>;

export const WorkflowResolveRevisionEscapeInputSchema = WorkflowRevisionEscapeIdentitySchema.extend(
  {
    decision: z.enum(['accept', 'cancel']),
    confirmed: z.literal(true),
  },
).strict();
export type WorkflowResolveRevisionEscapeInput = z.infer<
  typeof WorkflowResolveRevisionEscapeInputSchema
>;

export const WorkflowNodeRunViewSchema = z
  .object({
    nodeId: WorkflowIdSchema,
    status: RunStatusSchema,
    attempt: z.number().int().positive(),
    queuedAt: WorkflowTimestampSchema,
    startedAt: WorkflowTimestampSchema.optional(),
    endedAt: WorkflowTimestampSchema.optional(),
    resumable: z.boolean(),
    failureCode: z.string().min(1).max(300).optional(),
    statusReason: z.string().min(1).max(20_000).optional(),
    execution: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('process'), pid: z.number().int().positive() }).strict(),
        z.object({ kind: z.literal('internal') }).strict(),
      ])
      .optional(),
  })
  .strict();
export type WorkflowNodeRunView = z.infer<typeof WorkflowNodeRunViewSchema>;

export const WorkflowEdgeRunViewSchema = z
  .object({
    edgeId: WorkflowIdSchema,
    type: z.enum(['context', 'execute', 'output', 'review', 'revision', 'dependency']),
    sourceNodeId: WorkflowIdSchema,
    targetNodeId: WorkflowIdSchema,
    status: RunStatusSchema,
    disposition: z.enum(['satisfied', 'waiting', 'waiting-for-approval', 'blocked', 'inactive']),
    reason: z.string().min(1).max(20_000),
  })
  .strict();
export type WorkflowEdgeRunView = z.infer<typeof WorkflowEdgeRunViewSchema>;

export const WorkflowApprovalRequestSchema = z
  .object({
    executionId: WorkflowIdSchema,
    nodeId: WorkflowIdSchema,
    attempt: z.number().int().positive(),
    executorId: WorkflowIdSchema,
    preparationId: WorkflowIdSchema,
    approvalFingerprint: z.string().min(8).max(512),
    expiresAt: WorkflowTimestampSchema,
    disclosure: JsonValueSchema,
  })
  .strict();
export type WorkflowApprovalRequest = z.infer<typeof WorkflowApprovalRequestSchema>;

const WorkflowSchedulingViewSchema = z
  .object({
    runnableNodeIds: z.array(WorkflowIdSchema),
    waitingNodeIds: z.array(WorkflowIdSchema),
    waitingForApprovalNodeIds: z.array(WorkflowIdSchema),
    blockedNodeIds: z.array(WorkflowIdSchema),
    activeNodeIds: z.array(WorkflowIdSchema),
  })
  .strict();

export const WorkflowExecutionViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: WorkflowIdSchema,
    projectId: WorkflowIdSchema,
    canvasId: WorkflowIdSchema,
    status: RunStatusSchema,
    revision: z.number().int().nonnegative(),
    scope: WorkflowRunScopeSchema,
    planNodeIds: z.array(WorkflowIdSchema),
    nodeRuns: z.array(WorkflowNodeRunViewSchema),
    edges: z.array(WorkflowEdgeRunViewSchema),
    approvals: z.array(WorkflowApprovalRequestSchema),
    humanDecisions: z.array(WorkflowHumanDecisionRequestSchema),
    revisionEscapes: z.array(WorkflowRevisionEscapeRequestSchema),
    scheduling: WorkflowSchedulingViewSchema,
    cancellationRequested: z.boolean(),
    testResults: z.array(WorkflowTestResultSchema).max(2_000).default([]),
    createdAt: WorkflowTimestampSchema,
    updatedAt: WorkflowTimestampSchema,
    endedAt: WorkflowTimestampSchema.optional(),
  })
  .strict();
export type WorkflowExecutionView = z.infer<typeof WorkflowExecutionViewSchema>;

export const WorkflowEventEnvelopeSchema = z
  .object({
    type: z.enum([
      'execution-created',
      'approval-requested',
      'node-started',
      'node-completed',
      'execution-cancelled',
      'execution-recovered',
      'decision-recorded',
      'host-error',
    ]),
    occurredAt: WorkflowTimestampSchema,
    nodeId: WorkflowIdSchema.optional(),
    payload: JsonValueSchema,
    execution: WorkflowExecutionViewSchema,
  })
  .strict();
export type WorkflowEventEnvelope = z.infer<typeof WorkflowEventEnvelopeSchema>;

export const WorkflowInteractionEventEnvelopeSchema = WorkflowNodeInteractionIdentitySchema.extend({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  occurredAt: WorkflowTimestampSchema,
  kind: z.enum(['stream', 'lifecycle', 'message', 'result', 'summary', 'error']),
  channel: z.enum(['stdout', 'stderr', 'pty', 'status']).optional(),
  text: z.string().max(WORKFLOW_INTERACTION_TEXT_MAX_CODE_UNITS),
  truncated: z.boolean(),
}).strict();
export type WorkflowInteractionEventEnvelope = z.infer<
  typeof WorkflowInteractionEventEnvelopeSchema
>;
