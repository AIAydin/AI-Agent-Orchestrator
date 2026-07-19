import { z } from 'zod';

export const GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATHS = 256;
export const GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATH_CHARACTERS = 64 * 1_024;
export const GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATH_COUNT = 1_000_000;

export const GIT_LIFECYCLE_IPC_CHANNELS = Object.freeze({
  prepareCleanup: 'git:lifecycle:prepare-cleanup',
  confirmCleanup: 'git:lifecycle:confirm-cleanup',
  openExternal: 'git:lifecycle:open-external',
  prepareRename: 'git:lifecycle:prepare-rename',
  confirmRename: 'git:lifecycle:confirm-rename',
  prepareArchive: 'git:lifecycle:prepare-archive',
  confirmArchive: 'git:lifecycle:confirm-archive',
  prepareRestore: 'git:lifecycle:prepare-restore',
  confirmRestore: 'git:lifecycle:confirm-restore',
});

const GitLifecycleIdSchema = z.string().uuid();
const GitLifecycleRefSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isRendererSafeGitRef, 'Git references must not contain machine paths or control text.');

/** A bounded canonical repository-relative path. It is display data, never path authority. */
export const GitWorktreeCleanupRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    isCanonicalRelativeGitPath,
    'Cleanup paths must be normalized repository-relative Git paths.',
  );

/** The renderer selects an agent worktree only through its persisted project/run ownership. */
export const GitWorktreeCleanupTargetInputSchema = z
  .object({
    projectId: GitLifecycleIdSchema,
    runId: GitLifecycleIdSchema,
  })
  .strict();
export type GitWorktreeCleanupTargetInput = z.infer<typeof GitWorktreeCleanupTargetInputSchema>;

const ManagedBranchNameSchema = GitLifecycleRefSchema.refine(
  (value) => value !== 'HEAD' && !value.startsWith('-'),
  'Managed branch names cannot be HEAD or start with a dash.',
);

export const GitWorktreeRenamePrepareInputSchema = GitWorktreeCleanupTargetInputSchema.extend({
  newBranch: ManagedBranchNameSchema,
}).strict();
export type GitWorktreeRenamePrepareInput = z.infer<typeof GitWorktreeRenamePrepareInputSchema>;

export const GitWorktreeMetadataConfirmationInputSchema = z
  .object({ planId: GitLifecycleIdSchema })
  .strict();
export type GitWorktreeMetadataConfirmationInput = z.infer<
  typeof GitWorktreeMetadataConfirmationInputSchema
>;

const GitWorktreeMetadataPlanBaseSchema = z.object({
  planId: GitLifecycleIdSchema,
  expiresAt: z.string().datetime(),
  branch: GitLifecycleRefSchema,
  clean: z.boolean(),
  dirtyPathCount: z.number().int().nonnegative().max(GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATH_COUNT),
});

export const GitWorktreeRenamePlanViewSchema = GitWorktreeMetadataPlanBaseSchema.extend({
  kind: z.literal('rename-worktree-branch'),
  newBranch: ManagedBranchNameSchema,
}).strict();
export type GitWorktreeRenamePlanView = z.infer<typeof GitWorktreeRenamePlanViewSchema>;

export const GitWorktreeArchivePlanViewSchema = GitWorktreeMetadataPlanBaseSchema.extend({
  kind: z.literal('archive-worktree'),
  retainsWorktree: z.literal(true),
  retainsBranch: z.literal(true),
}).strict();
export type GitWorktreeArchivePlanView = z.infer<typeof GitWorktreeArchivePlanViewSchema>;

export const GitWorktreeRestorePlanViewSchema = GitWorktreeMetadataPlanBaseSchema.extend({
  kind: z.literal('restore-worktree'),
  retainsWorktree: z.literal(true),
  retainsBranch: z.literal(true),
}).strict();
export type GitWorktreeRestorePlanView = z.infer<typeof GitWorktreeRestorePlanViewSchema>;

export const GitWorktreeMetadataResultViewSchema = z
  .object({
    action: z.enum(['renamed', 'archived', 'restored']),
    branch: GitLifecycleRefSchema,
  })
  .strict();
export type GitWorktreeMetadataResultView = z.infer<typeof GitWorktreeMetadataResultViewSchema>;

/**
 * Path-free cleanup disclosure. Main retains every authoritative root, worktree identifier, and
 * exact unbounded impact privately. The literal policy fields make force semantics impossible to
 * opt into through the renderer contract.
 */
export const GitWorktreeCleanupPlanViewSchema = z
  .object({
    kind: z.literal('cleanup-worktree'),
    recovery: z.boolean(),
    planId: GitLifecycleIdSchema,
    expiresAt: z.string().datetime(),
    branch: GitLifecycleRefSchema,
    baseRef: GitLifecycleRefSchema,
    clean: z.boolean(),
    mergedIntoBase: z.boolean(),
    dirtyPaths: z
      .array(GitWorktreeCleanupRelativePathSchema)
      .max(GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATHS),
    dirtyPathCount: z.number().int().nonnegative().max(GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATH_COUNT),
    dirtyPathsTruncated: z.boolean(),
    force: z.literal(false),
    deleteBranch: z.literal(true),
    allowDirty: z.literal(false),
    allowUnmergedBranch: z.literal(false),
  })
  .strict()
  .superRefine((plan, context) => {
    const disclosedCount = plan.dirtyPaths.length;
    const pathCharacters = plan.dirtyPaths.reduce((total, path) => total + path.length, 0);
    if (pathCharacters > GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATH_CHARACTERS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dirtyPaths'],
        message: `Cleanup disclosure exceeds ${String(
          GIT_WORKTREE_CLEANUP_MAX_DIRTY_PATH_CHARACTERS,
        )} path characters.`,
      });
    }
    if (new Set(plan.dirtyPaths).size !== disclosedCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dirtyPaths'],
        message: 'Cleanup disclosure paths must be unique.',
      });
    }
    if (!isSorted(plan.dirtyPaths)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dirtyPaths'],
        message: 'Cleanup disclosure paths must be sorted.',
      });
    }
    if (plan.dirtyPathCount < disclosedCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dirtyPathCount'],
        message: 'Cleanup dirty-path count cannot be smaller than the disclosed path list.',
      });
    }
    const actuallyTruncated = plan.dirtyPathCount > disclosedCount;
    if (plan.dirtyPathsTruncated !== actuallyTruncated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dirtyPathsTruncated'],
        message: 'Cleanup path truncation must match the authoritative dirty-path count.',
      });
    }
    if (plan.clean !== (plan.dirtyPathCount === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clean'],
        message: 'Cleanup clean state must match the authoritative dirty-path count.',
      });
    }
  });
export type GitWorktreeCleanupPlanView = z.infer<typeof GitWorktreeCleanupPlanViewSchema>;

/** Path-free completion returned when main safely reconciles a previously interrupted cleanup. */
export const GitWorktreeCleanupReconciledViewSchema = z
  .object({
    kind: z.literal('cleanup-reconciled'),
    worktreeRemoved: z.literal(true),
    branchDeleted: z.literal(true),
    metadataRemoved: z.literal(true),
  })
  .strict();
export type GitWorktreeCleanupReconciledView = z.infer<
  typeof GitWorktreeCleanupReconciledViewSchema
>;

export const GitWorktreeCleanupPrepareOutcomeSchema = z.union([
  GitWorktreeCleanupPlanViewSchema,
  GitWorktreeCleanupReconciledViewSchema,
]);
export type GitWorktreeCleanupPrepareOutcome = z.infer<
  typeof GitWorktreeCleanupPrepareOutcomeSchema
>;

/** Confirmation intentionally carries no target, path, branch, or policy overrides. */
export const GitWorktreeCleanupConfirmationInputSchema = z
  .object({ planId: GitLifecycleIdSchema })
  .strict();
export type GitWorktreeCleanupConfirmationInput = z.infer<
  typeof GitWorktreeCleanupConfirmationInputSchema
>;

export const GitWorktreeCleanupResultViewSchema = z
  .object({
    worktreeRemoved: z.boolean(),
    branchDeleted: z.boolean(),
    metadataRemoved: z.boolean(),
  })
  .strict();
export type GitWorktreeCleanupResultView = z.infer<typeof GitWorktreeCleanupResultViewSchema>;

/** Path-free result for a native-confirmed handoff to the system-registered external application. */
export const GitWorkspaceExternalOpenResultSchema = z
  .object({
    opened: z.boolean(),
    targetKind: z.enum(['primary', 'agent-worktree']),
    branch: GitLifecycleRefSchema.nullable(),
  })
  .strict();
export type GitWorkspaceExternalOpenResult = z.infer<typeof GitWorkspaceExternalOpenResultSchema>;

function isRendererSafeGitRef(value: string): boolean {
  if (value.trim() !== value || value.startsWith('/') || value.includes('\\')) return false;
  if (/^[a-zA-Z]:/u.test(value)) return false;
  return ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function isCanonicalRelativeGitPath(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\')) return false;
  if (/^[a-zA-Z]:/u.test(value)) return false;
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => {
    const previous = values[index - 1];
    return previous === undefined || previous <= value;
  });
}
