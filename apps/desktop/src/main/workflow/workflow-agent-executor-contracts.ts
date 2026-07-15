import { ContextAttachmentSchema, type ContextAttachment } from '@forgeboard/agent-adapters';
import { EntityIdSchema, TimestampSchema } from '@forgeboard/core/domain';
import { z } from 'zod';

import type { WorkflowExecutionRuntime } from '@forgeboard/core';

const FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);

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
    manifestId: z.string().min(1).max(128).optional(),
    manifestDigest: FingerprintSchema.optional(),
  })
  .strict()
  .superRefine((resolution, context) => {
    if ((resolution.manifestId === undefined) !== (resolution.manifestDigest === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Context manifest ID and digest must be provided together.',
      });
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
  readonly manifestId?: string;
  readonly manifestDigest?: string;
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
  })
  .strict();
export type WorkflowAgentEvidence = z.infer<typeof WorkflowAgentEvidenceSchema>;
