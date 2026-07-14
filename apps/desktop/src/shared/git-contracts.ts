import { z } from 'zod';

const ProjectIdSchema = z.string().uuid();
const PlanIdSchema = z.string().uuid();
const GitPathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes('\0'), 'Git paths cannot contain NUL bytes.');
const HunkIdSchema = z.string().regex(/^[a-f0-9]{20,64}$/u);
const OidSchema = z
  .string()
  .regex(/^[a-f0-9]{40,64}$/u)
  .nullable();

export const GitTargetInputSchema = z.object({ projectId: ProjectIdSchema }).strict();
export type GitTargetInput = z.infer<typeof GitTargetInputSchema>;

export const GitPathSelectionInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    paths: z.array(GitPathSchema).min(1).max(512),
  })
  .strict();
export type GitPathSelectionInput = z.infer<typeof GitPathSelectionInputSchema>;

export const GitHunkSelectionInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    hunkIds: z.array(HunkIdSchema).min(1).max(2_048),
  })
  .strict();
export type GitHunkSelectionInput = z.infer<typeof GitHunkSelectionInputSchema>;

export const GitCommitPlanInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    message: z
      .string()
      .trim()
      .min(1)
      .max(16_384)
      .refine((value) => !value.includes('\0'), 'Commit messages cannot contain NUL bytes.'),
  })
  .strict();
export type GitCommitPlanInput = z.infer<typeof GitCommitPlanInputSchema>;

export const GitPlanConfirmationInputSchema = z.object({ planId: PlanIdSchema }).strict();
export type GitPlanConfirmationInput = z.infer<typeof GitPlanConfirmationInputSchema>;

export const GitStatusEntryViewSchema = z
  .object({
    kind: z.enum(['ordinary', 'renamed-or-copied', 'unmerged', 'untracked']),
    path: GitPathSchema,
    originalPath: GitPathSchema.optional(),
    index: z.enum(['.', 'A', 'C', 'D', 'M', 'R', 'T', 'U', '?']),
    worktree: z.enum(['.', 'A', 'C', 'D', 'M', 'R', 'T', 'U', '?']),
    score: z.string().max(32).optional(),
  })
  .strict();
export type GitStatusEntryView = z.infer<typeof GitStatusEntryViewSchema>;

export const GitDiffLineViewSchema = z
  .object({
    kind: z.enum(['context', 'addition', 'deletion', 'metadata']),
    content: z.string().max(1_000_000),
    oldLine: z.number().int().nonnegative().nullable(),
    newLine: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type GitDiffLineView = z.infer<typeof GitDiffLineViewSchema>;

export const GitDiffHunkViewSchema = z
  .object({
    id: HunkIdSchema,
    header: z.string().min(1).max(65_536),
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    lines: z.array(GitDiffLineViewSchema).max(100_000),
  })
  .strict();
export type GitDiffHunkView = z.infer<typeof GitDiffHunkViewSchema>;

export const GitDiffFileViewSchema = z
  .object({
    oldPath: GitPathSchema.nullable(),
    newPath: GitPathSchema.nullable(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'binary', 'unknown']),
    binary: z.boolean(),
    hunks: z.array(GitDiffHunkViewSchema).max(10_000),
  })
  .strict();
export type GitDiffFileView = z.infer<typeof GitDiffFileViewSchema>;

export const GitDiffViewSchema = z
  .object({
    files: z.array(GitDiffFileViewSchema).max(50_000),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();
export type GitDiffView = z.infer<typeof GitDiffViewSchema>;

export const GitIdentityViewSchema = z
  .object({
    name: z.string().max(512),
    email: z.string().max(512),
    nameSource: z.enum(['settings', 'git-config', 'missing']),
    emailSource: z.enum(['settings', 'git-config', 'missing']),
    ready: z.boolean(),
  })
  .strict();
export type GitIdentityView = z.infer<typeof GitIdentityViewSchema>;

export const GitReviewViewSchema = z
  .object({
    projectId: ProjectIdSchema,
    branch: z.string().max(4_096).nullable(),
    detached: z.boolean(),
    headOid: OidSchema,
    upstream: z.string().max(4_096).nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    dirty: z.boolean(),
    conflicted: z.boolean(),
    entries: z.array(GitStatusEntryViewSchema).max(100_000),
    staged: GitDiffViewSchema,
    unstaged: GitDiffViewSchema,
    identity: GitIdentityViewSchema,
    refreshedAt: z.string().datetime(),
  })
  .strict();
export type GitReviewView = z.infer<typeof GitReviewViewSchema>;

export const GitCommitPlanViewSchema = z
  .object({
    kind: z.literal('commit'),
    planId: PlanIdSchema,
    expiresAt: z.string().datetime(),
    projectId: ProjectIdSchema,
    message: z.string().min(1).max(16_384),
    branch: z.string().max(4_096).nullable(),
    headOid: OidSchema,
    stagedPaths: z.array(GitPathSchema).min(1).max(100_000),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    identity: GitIdentityViewSchema,
  })
  .strict();
export type GitCommitPlanView = z.infer<typeof GitCommitPlanViewSchema>;

export const GitDiscardPlanViewSchema = z
  .object({
    kind: z.literal('discard-hunks'),
    planId: PlanIdSchema,
    expiresAt: z.string().datetime(),
    projectId: ProjectIdSchema,
    branch: z.string().max(4_096).nullable(),
    headOid: OidSchema,
    hunkIds: z.array(HunkIdSchema).min(1).max(2_048),
    paths: z.array(GitPathSchema).min(1).max(2_048),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();
export type GitDiscardPlanView = z.infer<typeof GitDiscardPlanViewSchema>;

export const GitCommitResultViewSchema = z
  .object({
    headBefore: z.string().min(1).max(64),
    headAfter: z.string().min(1).max(64),
    review: GitReviewViewSchema,
  })
  .strict();
export type GitCommitResultView = z.infer<typeof GitCommitResultViewSchema>;
