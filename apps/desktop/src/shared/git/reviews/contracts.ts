import { z } from 'zod';

import { GitTargetInputSchema } from '../contracts.js';

const ReviewNoteIdSchema = z.string().uuid();
const ReviewRevisionIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ReviewHunkIdSchema = z.string().regex(/^[a-f0-9]{20,64}$/u);
const GitOidSchema = z
  .string()
  .regex(/^[a-f0-9]{40,64}$/u)
  .nullable();

export const GitReviewAreaSchema = z.enum(['base', 'staged', 'unstaged']);
export type GitReviewArea = z.infer<typeof GitReviewAreaSchema>;

export const GitReviewSideSchema = z.enum(['old', 'new']);
export type GitReviewSide = z.infer<typeof GitReviewSideSchema>;

/** A bounded canonical Git path. Backslashes and dot segments are intentionally not normalized. */
export const GitReviewRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    isCanonicalRelativeGitPath,
    'Review paths must be normalized project-relative Git paths.',
  );
export type GitReviewRelativePath = z.infer<typeof GitReviewRelativePathSchema>;

export const GitReviewRevisionViewSchema = z
  .object({
    area: GitReviewAreaSchema,
    revisionId: ReviewRevisionIdSchema,
    baseCommit: GitOidSchema,
    headCommit: GitOidSchema,
  })
  .strict();
export type GitReviewRevisionView = z.infer<typeof GitReviewRevisionViewSchema>;

export const GitReviewAnchorInputSchema = z
  .object({
    area: GitReviewAreaSchema,
    revisionId: ReviewRevisionIdSchema,
    path: GitReviewRelativePathSchema,
    hunkId: ReviewHunkIdSchema,
    side: GitReviewSideSchema,
    line: z.number().int().positive().max(10_000_000),
  })
  .strict();
export type GitReviewAnchorInput = z.infer<typeof GitReviewAnchorInputSchema>;

export const GitReviewAnchorViewSchema = GitReviewAnchorInputSchema.extend({
  lineContentSha256: ReviewRevisionIdSchema,
}).strict();
export type GitReviewAnchorView = z.infer<typeof GitReviewAnchorViewSchema>;

export const GitReviewNoteKindSchema = z.enum(['comment', 'revision-request']);
export type GitReviewNoteKind = z.infer<typeof GitReviewNoteKindSchema>;

export const GitReviewNoteStatusSchema = z.enum(['open', 'resolved']);
export type GitReviewNoteStatus = z.infer<typeof GitReviewNoteStatusSchema>;

export const GitReviewAnchorStateSchema = z.enum(['current', 'stale-review', 'line-missing']);
export type GitReviewAnchorState = z.infer<typeof GitReviewAnchorStateSchema>;

const ReviewBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(16_384)
  .refine((value) => !value.includes('\0'), 'Review notes cannot contain NUL bytes.');

export const GitReviewNoteCreateInputSchema = z
  .object({
    target: GitTargetInputSchema,
    kind: GitReviewNoteKindSchema,
    anchor: GitReviewAnchorInputSchema,
    body: ReviewBodySchema,
  })
  .strict();
export type GitReviewNoteCreateInput = z.infer<typeof GitReviewNoteCreateInputSchema>;

export const GitReviewNotesListInputSchema = z.object({ target: GitTargetInputSchema }).strict();
export type GitReviewNotesListInput = z.infer<typeof GitReviewNotesListInputSchema>;

export const GitReviewNoteUpdateInputSchema = z
  .object({
    target: GitTargetInputSchema,
    noteId: ReviewNoteIdSchema,
    expectedUpdatedAt: z.string().datetime(),
    body: ReviewBodySchema.optional(),
    status: GitReviewNoteStatusSchema.optional(),
  })
  .strict()
  .refine((value) => value.body !== undefined || value.status !== undefined, {
    message: 'A review-note update must change its body or status.',
  });
export type GitReviewNoteUpdateInput = z.infer<typeof GitReviewNoteUpdateInputSchema>;

export const GitReviewNoteDeleteInputSchema = z
  .object({
    target: GitTargetInputSchema,
    noteId: ReviewNoteIdSchema,
    expectedUpdatedAt: z.string().datetime(),
  })
  .strict();
export type GitReviewNoteDeleteInput = z.infer<typeof GitReviewNoteDeleteInputSchema>;

const StoredGitReviewNoteObjectSchema = z
  .object({
    id: ReviewNoteIdSchema,
    projectId: z.string().uuid(),
    target: GitTargetInputSchema,
    kind: GitReviewNoteKindSchema,
    anchor: GitReviewAnchorViewSchema,
    body: ReviewBodySchema,
    status: GitReviewNoteStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
  })
  .strict();

export const StoredGitReviewNoteSchema = StoredGitReviewNoteObjectSchema.superRefine(
  validateReviewNoteLifecycle,
);
export type StoredGitReviewNote = z.infer<typeof StoredGitReviewNoteSchema>;

export const GitReviewNoteViewSchema = StoredGitReviewNoteObjectSchema.extend({
  anchorState: GitReviewAnchorStateSchema,
})
  .strict()
  .superRefine(validateReviewNoteLifecycle);
export type GitReviewNoteView = z.infer<typeof GitReviewNoteViewSchema>;

export const GitReviewNotesViewSchema = z
  .object({
    target: GitTargetInputSchema,
    revisions: z.array(GitReviewRevisionViewSchema).max(3),
    notes: z.array(GitReviewNoteViewSchema).max(500),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((view, context) => {
    if (new Set(view.revisions.map((revision) => revision.area)).size !== view.revisions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revisions'],
        message: 'Each review area can expose only one current revision.',
      });
    }
    if (view.notes.some((note) => !sameTarget(note.target, view.target))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notes'],
        message: 'Every note must belong to the requested review target.',
      });
    }
  });
export type GitReviewNotesView = z.infer<typeof GitReviewNotesViewSchema>;

export const GIT_REVIEW_NOTE_IPC_CHANNELS = Object.freeze({
  list: 'git:review-notes:list',
  create: 'git:review-notes:create',
  update: 'git:review-notes:update',
  delete: 'git:review-notes:delete',
} as const);

function validateReviewNoteLifecycle(
  note: z.infer<typeof StoredGitReviewNoteObjectSchema>,
  context: z.RefinementCtx,
): void {
  if (note.target.projectId !== note.projectId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target', 'projectId'],
      message: 'The review-note target must belong to its project.',
    });
  }
  if (Date.parse(note.updatedAt) < Date.parse(note.createdAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'A review note cannot be updated before it was created.',
    });
  }
  if (note.status === 'open' && note.resolvedAt !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resolvedAt'],
      message: 'An open review note cannot have a resolution time.',
    });
  }
  if (note.status === 'resolved' && note.resolvedAt === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resolvedAt'],
      message: 'A resolved review note requires a resolution time.',
    });
  }
}

function isCanonicalRelativeGitPath(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  if (/^[a-zA-Z]:/u.test(value)) return false;
  if ([...value].some((character) => (character.codePointAt(0) ?? 0) < 32)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function sameTarget(
  left: z.infer<typeof GitTargetInputSchema>,
  right: z.infer<typeof GitTargetInputSchema>,
): boolean {
  return (
    left.kind === right.kind &&
    left.projectId === right.projectId &&
    (left.kind === 'primary' || (right.kind === 'agent-worktree' && left.runId === right.runId))
  );
}
