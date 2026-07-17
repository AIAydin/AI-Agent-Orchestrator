import { z } from 'zod';

import { CheckIdSchema } from '../../checks/contracts.js';
import { evaluateGitDeliveryReadiness } from './evaluator.js';
import {
  GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS,
  GitDeliveryAvailableCheckSchema,
  GitDeliveryReadinessEvaluationSchema,
  GitDeliveryReadinessSnapshotBaseSchema,
  GitDeliveryReadinessSnapshotSchema,
  GitDeliveryReadinessTargetSchema,
  GitDeliverySha256Schema,
  GitDeliverySourceIdentitySchema,
  WorkflowEntityIdSchema,
} from './model.js';

export const GIT_DELIVERY_READINESS_IPC_CHANNELS = Object.freeze({
  get: 'git:delivery-readiness-get',
  prepare: 'git:delivery-readiness-prepare',
  run: 'git:delivery-readiness-run',
  approve: 'git:delivery-readiness-approve',
});

export const GitDeliveryReadinessGetInputSchema = z
  .object({ target: GitDeliveryReadinessTargetSchema })
  .strict();
export type GitDeliveryReadinessGetInput = z.infer<typeof GitDeliveryReadinessGetInputSchema>;

export const GitDeliveryRequiredCheckSelectionSchema = z
  .array(CheckIdSchema)
  .max(GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS)
  .superRefine((checkIds, context) => {
    if (new Set(checkIds).size !== checkIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Required delivery checks must be unique.',
      });
    }
  });
export type GitDeliveryRequiredCheckSelection = z.infer<
  typeof GitDeliveryRequiredCheckSelectionSchema
>;

export const GitDeliveryReadinessPrepareInputSchema = z
  .object({
    target: GitDeliveryReadinessTargetSchema,
    workflowExecutionId: WorkflowEntityIdSchema,
    additionalCheckIds: GitDeliveryRequiredCheckSelectionSchema.optional(),
  })
  .strict();
export type GitDeliveryReadinessPrepareInput = z.infer<
  typeof GitDeliveryReadinessPrepareInputSchema
>;

export const GitDeliveryReadinessRunInputSchema = z
  .object({
    readinessId: z.string().uuid(),
    checkId: CheckIdSchema,
    expectedSourceFingerprint: GitDeliverySha256Schema,
  })
  .strict();
export type GitDeliveryReadinessRunInput = z.infer<typeof GitDeliveryReadinessRunInputSchema>;

export const GitDeliveryReadinessApproveInputSchema = z
  .object({
    readinessId: z.string().uuid(),
    expectedSourceFingerprint: GitDeliverySha256Schema,
    confirmed: z.literal(true),
  })
  .strict();
export type GitDeliveryReadinessApproveInput = z.infer<
  typeof GitDeliveryReadinessApproveInputSchema
>;

export const GitDeliveryReadinessViewSchema = z
  .object({
    ...GitDeliveryReadinessSnapshotBaseSchema.shape,
    evaluation: GitDeliveryReadinessEvaluationSchema,
  })
  .strict()
  .superRefine((view, context) => {
    const { evaluation, ...snapshotValue } = view;
    const snapshot = GitDeliveryReadinessSnapshotSchema.safeParse(snapshotValue);
    if (!snapshot.success) {
      for (const issue of snapshot.error.issues) context.addIssue(issue);
      return;
    }
    const expected = evaluateGitDeliveryReadiness(snapshot.data);
    if (JSON.stringify(evaluation) !== JSON.stringify(expected)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evaluation'],
        message: 'Delivery-readiness view evaluation must match its exact evidence snapshot.',
      });
    }
  });
export type GitDeliveryReadinessView = z.infer<typeof GitDeliveryReadinessViewSchema>;

export const GitDeliveryCompatibleWorkflowExecutionSchema = z
  .object({
    executionId: WorkflowEntityIdSchema,
    canvasId: WorkflowEntityIdSchema,
    executionRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    endedAt: z.string().datetime(),
    derivedCheckIds: GitDeliveryRequiredCheckSelectionSchema,
  })
  .strict();
export type GitDeliveryCompatibleWorkflowExecution = z.infer<
  typeof GitDeliveryCompatibleWorkflowExecutionSchema
>;

/**
 * Get always returns bounded path-free discovery. A null readiness is explicitly unprepared and can
 * never be mistaken for an empty set of passing requirements.
 */
export const GitDeliveryReadinessGetViewSchema = z
  .object({
    target: GitDeliveryReadinessTargetSchema,
    source: GitDeliverySourceIdentitySchema,
    availableChecks: z.array(GitDeliveryAvailableCheckSchema).max(256),
    compatibleWorkflowExecutions: z.array(GitDeliveryCompatibleWorkflowExecutionSchema).max(100),
    workflowUnavailableReason: z.string().trim().min(1).max(1_024).nullable(),
    readiness: GitDeliveryReadinessViewSchema.nullable(),
    staleReason: z.string().trim().min(1).max(1_024).nullable(),
    refreshedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((view, context) => {
    if (view.target.runId !== view.source.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source', 'runId'],
        message: 'Delivery source discovery must belong to the selected managed run.',
      });
    }
    if (
      new Set(view.availableChecks.map((check) => check.checkId)).size !==
      view.availableChecks.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['availableChecks'],
        message: 'Available delivery check identifiers must be unique.',
      });
    }
    if (
      (view.compatibleWorkflowExecutions.length === 0) !==
      (view.workflowUnavailableReason !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workflowUnavailableReason'],
        message:
          'Workflow unavailability must be explained exactly when no compatible execution exists.',
      });
    }
    if (view.readiness === null) return;
    if (view.staleReason !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['staleReason'],
        message: 'Current readiness cannot also carry a stale-evidence reason.',
      });
    }
    const readiness = view.readiness;
    const sameTarget =
      readiness.target.kind === view.target.kind &&
      readiness.target.projectId === view.target.projectId &&
      readiness.target.runId === view.target.runId;
    const sameSource =
      readiness.sourceFingerprint.sourceHead === view.source.sourceHead &&
      readiness.sourceFingerprint.sourceTree === view.source.sourceTree &&
      readiness.sourceFingerprint.worktreeId === view.source.worktreeId &&
      readiness.sourceFingerprint.runId === view.source.runId;
    if (!sameTarget || !sameSource) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readiness'],
        message: 'Prepared readiness must match the currently discovered target and source.',
      });
    }
  });
export type GitDeliveryReadinessGetView = z.infer<typeof GitDeliveryReadinessGetViewSchema>;

export const GitDeliveryReadinessPrepareViewSchema = GitDeliveryReadinessViewSchema;
export type GitDeliveryReadinessPrepareView = GitDeliveryReadinessView;

export const GitDeliveryReadinessRunViewSchema = GitDeliveryReadinessViewSchema;
export type GitDeliveryReadinessRunView = GitDeliveryReadinessView;

export const GitDeliveryReadinessApproveViewSchema = GitDeliveryReadinessViewSchema;
export type GitDeliveryReadinessApproveView = GitDeliveryReadinessView;
