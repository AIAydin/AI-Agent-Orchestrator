import { ContextAttachmentSchema, type ContextAttachment } from '@forgeboard/agent-adapters';
import { EntityIdSchema, TimestampSchema } from '@forgeboard/core/domain';
import { z } from 'zod';

import { GeneratedAgentContextArtifactSchema } from '../../agent-execution/contracts.js';

import type { WorkflowExecutionRuntime } from '@forgeboard/core';

const FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const WorkflowReviewerFinalRecordSchema = z
  .object({
    type: z.literal('forgeboard.reviewer-assessment.final'),
    schemaVersion: z.literal(1),
    executionId: EntityIdSchema,
    reviewerNodeId: EntityIdSchema,
    reviewerAttempt: z.number().int().positive().max(10_000),
    assessments: z
      .array(
        z
          .object({
            reviewEdgeId: EntityIdSchema,
            reviewedNodeId: EntityIdSchema,
            reviewedNodeAttempt: z.number().int().positive().max(10_000),
            reviewedOutputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            verdict: z.enum(['approved', 'changes-requested']),
            findings: z
              .array(
                z
                  .object({
                    id: EntityIdSchema,
                    severity: z.enum(['info', 'warning', 'error']),
                    message: z.string().min(1).max(100_000),
                    blocking: z.boolean().default(false),
                    path: z.string().min(1).max(4_096).nullable().default(null),
                    line: z.number().int().positive().nullable().default(null),
                  })
                  .strict(),
              )
              .max(256)
              .default([]),
            summary: z.string().max(16_384).nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      new Set(record.assessments.map(({ reviewEdgeId }) => reviewEdgeId)).size !==
      record.assessments.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assessments'],
        message: 'Final reviewer assessments must target unique review edges.',
      });
    }
  });

export const WorkflowAgentResolvedAttachmentSchema = z
  .object({
    attachmentId: EntityIdSchema,
    attachment: ContextAttachmentSchema,
  })
  .strict();
export type WorkflowAgentResolvedAttachment = z.infer<typeof WorkflowAgentResolvedAttachmentSchema>;

export const WorkflowAgentContextResolutionSchema = z
  .object({
    attachments: z.array(WorkflowAgentResolvedAttachmentSchema).max(256),
    generatedArtifacts: z
      .array(
        z
          .object({
            attachmentId: EntityIdSchema,
            artifact: GeneratedAgentContextArtifactSchema,
          })
          .strict(),
      )
      .max(256)
      .optional(),
    manifestId: z.string().min(1).max(128).optional(),
    manifestDigest: FingerprintSchema.optional(),
    projectRoot: z.string().min(1).max(32_768).optional(),
  })
  .strict()
  .superRefine((resolution, context) => {
    if ((resolution.manifestId === undefined) !== (resolution.manifestDigest === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Context manifest ID and digest must be provided together.',
      });
    }
    const attachmentIds = new Set(resolution.attachments.map(({ attachmentId }) => attachmentId));
    const generatedIds = new Set<string>();
    for (const [index, generated] of (resolution.generatedArtifacts ?? []).entries()) {
      if (!attachmentIds.has(generated.attachmentId) || generatedIds.has(generated.attachmentId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['generatedArtifacts', index, 'attachmentId'],
          message: 'Generated workflow context must identify one unique resolved attachment.',
        });
      }
      generatedIds.add(generated.attachmentId);
    }
  });
export type WorkflowAgentContextResolution = z.infer<typeof WorkflowAgentContextResolutionSchema>;

export interface WorkflowAgentContextResolutionRequest {
  readonly executionId: string;
  readonly projectId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly attachmentIds: readonly string[];
  readonly runtime: WorkflowExecutionRuntime;
}

export type WorkflowAgentContextResolver = (
  request: WorkflowAgentContextResolutionRequest,
) => Promise<unknown>;

export interface ResolvedWorkflowAgentContext {
  readonly attachments: readonly ContextAttachment[];
  readonly generatedArtifacts?: readonly z.infer<typeof GeneratedAgentContextArtifactSchema>[];
  readonly manifestId?: string;
  readonly manifestDigest?: string;
  readonly projectRoot?: string;
}

export const WorkflowAgentEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('agent-run'),
    runId: z.string().uuid(),
    nodeId: EntityIdSchema,
    status: z.enum(['succeeded', 'failed', 'interrupted', 'terminated']),
    exitCode: z.number().int().nullable(),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
    outputDigest: FingerprintSchema,
    branch: z.string().max(512).nullable(),
    branchTruncated: z.boolean(),
    worktreePath: z.string().max(2_048).nullable(),
    worktreePathTruncated: z.boolean(),
    changedFiles: z.array(z.string().max(512)).max(256),
    changedFileCount: z.number().int().nonnegative().max(100_000),
    changedFilesTruncated: z.boolean(),
    providerSessionId: z.string().max(512).nullable(),
    providerSessionIdTruncated: z.boolean(),
    reviewerFinalRecord: WorkflowReviewerFinalRecordSchema.nullable().default(null),
    reviewArtifact: z
      .object({
        sourceRunId: z.string().uuid(),
        worktreePath: z.string().min(1).max(32_768),
        content: z.string().max(600_000),
        sha256: FingerprintSchema,
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type WorkflowAgentEvidence = z.infer<typeof WorkflowAgentEvidenceSchema>;
