import { z } from 'zod';

import {
  GitDeliveryAvailableCheckSchema,
  GitDeliveryReadinessTargetSchema,
  GitDeliveryRequiredCheckStateSchema,
  GitDeliverySha256Schema,
  GitDeliverySourceFingerprintSchema,
  GitDeliveryWorkflowBindingSchema,
  type GitDeliveryAvailableCheck,
  type GitDeliveryReadinessTarget,
  type GitDeliverySourceFingerprint,
} from '../../../shared/git/readiness/index.js';
import {
  CheckExecutionStatusSchema,
  CheckIdSchema,
  CheckKindSchema,
} from '../../../shared/checks/contracts.js';

const OidSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const TimestampSchema = z.string().datetime();
const ActorIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u);

export const DeliveryReadinessTargetSchema = GitDeliveryReadinessTargetSchema;
export type DeliveryReadinessTarget = GitDeliveryReadinessTarget;
export type DeliveryAvailableCheck = GitDeliveryAvailableCheck;
export type DeliverySourceFingerprint = GitDeliverySourceFingerprint;

export const DeliveryConfiguredCommandSchema = z
  .object({
    executable: z.string().trim().min(1).max(32_768),
    args: z.array(z.string().max(32_768)).max(512),
    cwdRelative: z.string().min(1).max(4_096).default('.'),
    environmentNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).max(256),
  })
  .strict();
export type DeliveryConfiguredCommand = z.infer<typeof DeliveryConfiguredCommandSchema>;

export const DeliveryResolvedCommandSchema = z
  .object({
    executable: z.string().min(1).max(32_768),
    arguments: z.array(z.string().max(32_768)).max(512),
    cwd: z.string().min(1).max(32_768),
    environmentVariableNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).max(256),
    fingerprint: GitDeliverySha256Schema,
  })
  .strict();
export type DeliveryResolvedCommand = z.infer<typeof DeliveryResolvedCommandSchema>;

/** Main-only evidence. Resolved paths and output digests are never copied into renderer views. */
export const DeliveryRequiredCheckRecordSchema = z
  .object({
    checkId: CheckIdSchema,
    label: z.string().trim().min(1).max(128),
    kind: CheckKindSchema,
    configurationDigest: GitDeliverySha256Schema,
    command: DeliveryConfiguredCommandSchema,
    resolvedCommand: DeliveryResolvedCommandSchema,
    state: GitDeliveryRequiredCheckStateSchema,
    executionId: z.string().uuid().nullable(),
    executionStatus: CheckExecutionStatusSchema.nullable(),
    sourceFingerprint: GitDeliverySourceFingerprintSchema.nullable(),
    startedAt: TimestampSchema.nullable(),
    endedAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
    exitCode: z.number().int().nullable(),
    outputDigest: GitDeliverySha256Schema.nullable(),
    failureReason: z.string().min(1).max(20_000).nullable(),
  })
  .strict()
  .superRefine((check, context) => {
    const missing = check.state === 'missing';
    const hasEvidence = check.executionId !== null && check.sourceFingerprint !== null;
    if (missing !== !hasEvidence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executionId'],
        message: 'Only a missing delivery check can omit exact execution evidence.',
      });
    }
    if (missing && (check.startedAt !== null || check.endedAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startedAt'],
        message: 'A missing delivery check cannot have execution timestamps.',
      });
    }
    if (check.state === 'passed' && (check.executionStatus !== 'passed' || check.exitCode !== 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A passing delivery check requires exact passed, exit-zero evidence.',
      });
    }
    if (['passed', 'failed', 'cancelled', 'lost', 'stale'].includes(check.state)) {
      if (check.endedAt === null || check.outputDigest === null || check.executionStatus === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Terminal delivery checks require status, end time, and output digest.',
        });
      }
    }
  });
export type DeliveryRequiredCheckRecord = z.infer<typeof DeliveryRequiredCheckRecordSchema>;

export const DeliveryReadinessRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    target: GitDeliveryReadinessTargetSchema,
    sourceFingerprint: GitDeliverySourceFingerprintSchema,
    workflowBinding: GitDeliveryWorkflowBindingSchema,
    sourceBranch: z.string().min(1).max(4_096),
    baseCommit: OidSchema,
    availableChecks: z.array(GitDeliveryAvailableCheckSchema).min(4).max(256),
    requiredChecks: z.array(DeliveryRequiredCheckRecordSchema).min(1).max(32),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.sourceFingerprint.runId !== record.target.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceFingerprint', 'runId'],
        message: 'The delivery source fingerprint belongs to another run.',
      });
    }
    if (
      new Set(record.requiredChecks.map((check) => check.checkId)).size !==
      record.requiredChecks.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredChecks'],
        message: 'Required delivery check IDs must be unique.',
      });
    }
    if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updatedAt'],
        message: 'Delivery readiness cannot be updated before it exists.',
      });
    }
  });
export type DeliveryReadinessRecord = z.infer<typeof DeliveryReadinessRecordSchema>;

/** Stored separately and immutable while retained so progress cannot rewrite a human decision. */
export const DeliveryHumanApprovalRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    readinessId: z.string().uuid(),
    target: GitDeliveryReadinessTargetSchema,
    authority: z.literal('human'),
    sourceFingerprint: GitDeliverySourceFingerprintSchema,
    evidenceFingerprint: GitDeliverySha256Schema,
    actorId: ActorIdSchema,
    actorLabel: z.string().trim().min(1).max(160),
    approvedAt: TimestampSchema,
  })
  .strict();
export type DeliveryHumanApprovalRecord = z.infer<typeof DeliveryHumanApprovalRecordSchema>;

export const DeliveryReadinessRevalidateInputSchema = z
  .object({
    approvalId: z.string().uuid(),
    target: GitDeliveryReadinessTargetSchema,
  })
  .strict();
export type DeliveryReadinessRevalidateInput = z.infer<
  typeof DeliveryReadinessRevalidateInputSchema
>;
