import { z } from 'zod';

import { CanonicalFilePathSchema } from '../../files/contracts.js';
import { GitReviewTargetViewSchema, GitTargetInputSchema } from '../contracts.js';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const GIT_CONFLICT_RESOLUTION_IPC_CHANNELS = Object.freeze({
  inspect: 'git:conflict-resolution:inspect',
  prepare: 'git:conflict-resolution:prepare',
  confirm: 'git:conflict-resolution:confirm',
});

export const GitConflictInspectionInputSchema = z.object({ target: GitTargetInputSchema }).strict();
export type GitConflictInspectionInput = z.infer<typeof GitConflictInspectionInputSchema>;

export const GitConflictFileViewSchema = z
  .object({
    path: CanonicalFilePathSchema,
    current: z.string().max(512 * 1024),
    currentSha256: Sha256Schema,
    base: z
      .string()
      .max(512 * 1024)
      .nullable(),
    ours: z
      .string()
      .max(512 * 1024)
      .nullable(),
    theirs: z
      .string()
      .max(512 * 1024)
      .nullable(),
  })
  .strict();
export type GitConflictFileView = z.infer<typeof GitConflictFileViewSchema>;

export const GitConflictInspectionViewSchema = z
  .object({
    target: GitReviewTargetViewSchema,
    operation: z.enum(['merge', 'rebase', 'cherry-pick', 'squash']),
    files: z.array(GitConflictFileViewSchema).min(1).max(32),
  })
  .strict();
export type GitConflictInspectionView = z.infer<typeof GitConflictInspectionViewSchema>;

export const GitConflictResolutionPrepareInputSchema = z
  .object({
    target: GitTargetInputSchema,
    path: CanonicalFilePathSchema,
    expectedSha256: Sha256Schema,
    content: z.string().max(512 * 1024),
  })
  .strict();
export type GitConflictResolutionPrepareInput = z.infer<
  typeof GitConflictResolutionPrepareInputSchema
>;

export const GitConflictResolutionPlanViewSchema = z
  .object({
    planId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    target: GitReviewTargetViewSchema,
    operation: z.enum(['merge', 'rebase', 'cherry-pick', 'squash']),
    path: CanonicalFilePathSchema,
    expectedSha256: Sha256Schema,
    resolvedSha256: Sha256Schema,
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(512 * 1024),
  })
  .strict();
export type GitConflictResolutionPlanView = z.infer<typeof GitConflictResolutionPlanViewSchema>;

export const GitConflictResolutionResultViewSchema = z
  .object({
    inspection: GitConflictInspectionViewSchema.nullable(),
    stagedPath: CanonicalFilePathSchema,
  })
  .strict();
export type GitConflictResolutionResultView = z.infer<typeof GitConflictResolutionResultViewSchema>;
