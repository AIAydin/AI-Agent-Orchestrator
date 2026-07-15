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

const GitPrimaryTargetInputSchema = z
  .object({ kind: z.literal('primary'), projectId: ProjectIdSchema })
  .strict();
const GitAgentWorktreeTargetInputSchema = z
  .object({
    kind: z.literal('agent-worktree'),
    projectId: ProjectIdSchema,
    runId: z.string().uuid(),
  })
  .strict();

export const GitTargetInputSchema = z.discriminatedUnion('kind', [
  GitPrimaryTargetInputSchema,
  GitAgentWorktreeTargetInputSchema,
]);
export type GitTargetInput = z.infer<typeof GitTargetInputSchema>;

export const GitPathSelectionInputSchema = z
  .object({
    target: GitTargetInputSchema,
    paths: z.array(GitPathSchema).min(1).max(512),
  })
  .strict();
export type GitPathSelectionInput = z.infer<typeof GitPathSelectionInputSchema>;

export const GitHunkSelectionInputSchema = z
  .object({
    target: GitTargetInputSchema,
    hunkIds: z.array(HunkIdSchema).min(1).max(2_048),
  })
  .strict();
export type GitHunkSelectionInput = z.infer<typeof GitHunkSelectionInputSchema>;

export const GitCommitPlanInputSchema = z
  .object({
    target: GitTargetInputSchema,
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

const GitComparisonCommitSchema = z
  .object({
    oid: z.string().regex(/^[a-f0-9]{40,64}$/u),
    relation: z.enum(['ahead', 'behind']),
  })
  .strict();

const MAX_COMPARISON_FILES = 4_096;
const MAX_COMPARISON_HUNKS = 16_384;
const MAX_COMPARISON_LINES = 200_000;
const MAX_COMPARISON_TEXT_CHARACTERS = 6 * 1_024 * 1_024;

export const GitAgentBaseComparisonViewSchema = z
  .object({
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    headCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    ahead: z.number().int().nonnegative().max(10_000_000),
    behind: z.number().int().nonnegative().max(10_000_000),
    commitCount: z.number().int().nonnegative().max(20_000_000),
    commits: z.array(GitComparisonCommitSchema).max(512),
    commitIdsTruncated: z.boolean(),
    diff: GitDiffViewSchema,
  })
  .strict()
  .superRefine((comparison, context) => {
    if (comparison.commitCount !== comparison.ahead + comparison.behind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commitCount'],
        message: 'Comparison commit count must equal ahead plus behind.',
      });
    }
    const aheadCommits = comparison.commits.filter((commit) => commit.relation === 'ahead').length;
    const behindCommits = comparison.commits.length - aheadCommits;
    if (aheadCommits > comparison.ahead || behindCommits > comparison.behind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commits'],
        message: 'Comparison commit identifiers exceed their authoritative relation counts.',
      });
    }
    if (
      !comparison.commitIdsTruncated &&
      (aheadCommits !== comparison.ahead || behindCommits !== comparison.behind)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commits'],
        message: 'A complete comparison must include every authoritative commit identifier.',
      });
    }
    if (comparison.commitIdsTruncated && comparison.commits.length >= comparison.commitCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commitIdsTruncated'],
        message: 'A truncated comparison must omit at least one commit identifier.',
      });
    }
    if (
      new Set(comparison.commits.map((commit) => commit.oid)).size !== comparison.commits.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commits'],
        message: 'Comparison commit identifiers must be unique.',
      });
    }
    let hunks = 0;
    let lines = 0;
    let textCharacters = 0;
    for (const file of comparison.diff.files) {
      textCharacters += (file.oldPath?.length ?? 0) + (file.newPath?.length ?? 0);
      hunks += file.hunks.length;
      for (const hunk of file.hunks) {
        textCharacters += hunk.header.length;
        lines += hunk.lines.length;
        for (const line of hunk.lines) textCharacters += line.content.length;
      }
    }
    const limits: ReadonlyArray<readonly [string, number, number, Array<string | number>]> = [
      ['files', comparison.diff.files.length, MAX_COMPARISON_FILES, ['diff', 'files']],
      ['hunks', hunks, MAX_COMPARISON_HUNKS, ['diff', 'files']],
      ['lines', lines, MAX_COMPARISON_LINES, ['diff', 'files']],
      ['text characters', textCharacters, MAX_COMPARISON_TEXT_CHARACTERS, ['diff', 'files']],
    ];
    for (const [label, count, maximum, path] of limits) {
      if (count <= maximum) continue;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `Base comparison exceeds the bounded ${label} limit of ${maximum}.`,
      });
    }
  });
export type GitAgentBaseComparisonView = z.infer<typeof GitAgentBaseComparisonViewSchema>;

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

export const GitReviewTargetViewSchema = z.discriminatedUnion('kind', [
  GitPrimaryTargetInputSchema,
  z
    .object({
      kind: z.literal('agent-worktree'),
      projectId: ProjectIdSchema,
      runId: z.string().uuid(),
      nodeId: z.string().min(1).max(512),
      worktreeId: z.string().uuid(),
      agentId: z.string().min(1).max(512),
      baseRef: z.string().min(1).max(4_096),
      baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    })
    .strict(),
]);
export type GitReviewTargetView = z.infer<typeof GitReviewTargetViewSchema>;

export const GitReviewViewSchema = z
  .object({
    target: GitReviewTargetViewSchema,
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
    baseComparison: GitAgentBaseComparisonViewSchema.optional(),
    identity: GitIdentityViewSchema,
    refreshedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.target.kind === 'primary') {
      if (review.baseComparison !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseComparison'],
          message: 'Primary-checkout reviews cannot contain an agent base comparison.',
        });
      }
      return;
    }
    if (review.baseComparison === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseComparison'],
        message: 'Agent-worktree reviews require an authoritative base comparison.',
      });
      return;
    }
    if (review.baseComparison.baseCommit !== review.target.baseCommit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseComparison', 'baseCommit'],
        message: 'Base comparison does not match the persisted worktree base commit.',
      });
    }
    if (review.headOid === null || review.baseComparison.headCommit !== review.headOid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseComparison', 'headCommit'],
        message: 'Base comparison does not match the current owned worktree HEAD.',
      });
    }
  });
export type GitReviewView = z.infer<typeof GitReviewViewSchema>;

export const GitCommitPlanViewSchema = z
  .object({
    kind: z.literal('commit'),
    planId: PlanIdSchema,
    expiresAt: z.string().datetime(),
    target: GitReviewTargetViewSchema,
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
    target: GitReviewTargetViewSchema,
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
