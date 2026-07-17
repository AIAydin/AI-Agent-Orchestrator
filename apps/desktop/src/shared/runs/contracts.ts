import { z } from 'zod';

export const RUN_HISTORY_MAX_LIMIT = 200;

export const TerminalRunHistoryStatusSchema = z.enum([
  'succeeded',
  'failed',
  'interrupted',
  'terminated',
  'lost',
]);
export type TerminalRunHistoryStatus = z.infer<typeof TerminalRunHistoryStatusSchema>;

export const RunHistoryWorktreeStateSchema = z.enum(['active', 'cleanup-pending', 'cleaned']);
export type RunHistoryWorktreeState = z.infer<typeof RunHistoryWorktreeStateSchema>;

export const RunHistoryListInputSchema = z
  .object({
    projectId: z.string().uuid(),
    limit: z.number().int().min(1).max(RUN_HISTORY_MAX_LIMIT),
  })
  .strict();
export type RunHistoryListInput = z.infer<typeof RunHistoryListInputSchema>;

/**
 * Renderer-safe persisted run metadata. The path-free lifecycle state distinguishes reviewable,
 * interrupted-cleanup, and cleaned targets without disclosing internal ownership. Paths and
 * internal worktree identifiers remain in main; an opaque run id is the only selectable identity.
 */
export const RunHistorySummarySchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    nodeId: z.string().min(1).max(512),
    adapterId: z.string().min(1).max(128),
    status: TerminalRunHistoryStatusSchema,
    branch: z.string().min(1).max(4_096).nullable(),
    worktreeState: RunHistoryWorktreeStateSchema,
    worktreeAvailable: z.boolean(),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.worktreeState !== 'active' && summary.worktreeAvailable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['worktreeAvailable'],
        message: 'Only an active run worktree can be available for Git review.',
      });
    }
  });
export type RunHistorySummary = z.infer<typeof RunHistorySummarySchema>;
