import { EntityIdSchema, RelativePathSchema } from '@forgeboard/core/domain';
import { z } from 'zod';

import type { WorkflowCanvasContextSource } from '../context/canvas-source.js';

const Sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const WORKFLOW_EVIDENCE_VERIFIER_ID = EntityIdSchema.parse(
  'forgeboard.workflow-evidence-v1',
);

/**
 * A canonical file selected by ID on the canvas. This deliberately carries only a project-relative
 * path. The trusted resolver owns repository-root containment, ignore, sensitivity, and file-I/O
 * policy; callers must never reinterpret an attachment ID as a path.
 */
export const WorkflowContextFileReferenceSchema = z
  .object({
    attachmentId: EntityIdSchema,
    fileNodeId: EntityIdSchema,
    relativePath: RelativePathSchema,
    readOnly: z.boolean(),
    lastKnownHash: z.string().min(8).max(256).optional(),
  })
  .strict()
  .superRefine((reference, context) => {
    if (reference.attachmentId !== reference.fileNodeId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A workflow context attachment must identify its canonical File node.',
      });
    }
  });
export type WorkflowContextFileReference = z.infer<typeof WorkflowContextFileReferenceSchema>;

export interface WorkflowContextEvidenceRequest {
  readonly executionId: string;
  readonly projectId: string;
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly targetAttempt: number;
  readonly attachmentIds: readonly string[];
  readonly files: readonly WorkflowContextFileReference[];
  readonly canvasSources: readonly WorkflowCanvasContextSource[];
}

/**
 * Proof returned by a trusted main-process file policy. The resolver must reject missing,
 * non-regular, ignored, sensitive, symlink-escaped, or otherwise unapproved files before hashing
 * them. Returning absolute paths or file contents is intentionally outside this contract.
 */
export const WorkflowContextEvidenceProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    attachmentIds: z
      .array(EntityIdSchema)
      .min(1)
      .max(256)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Verified workflow context attachment IDs must be unique.',
      }),
    contentDigest: Sha256DigestSchema,
  })
  .strict();
export type WorkflowContextEvidenceProof = z.infer<typeof WorkflowContextEvidenceProofSchema>;

/** Trusted main-process seam shared by workflow and agent-context composition. */
export type WorkflowContextEvidenceResolver = (
  request: WorkflowContextEvidenceRequest,
) => Promise<unknown>;
