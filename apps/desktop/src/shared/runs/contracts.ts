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

export const RunHistoryListInputSchema = z
  .object({
    projectId: z.string().uuid(),
    limit: z.number().int().min(1).max(RUN_HISTORY_MAX_LIMIT),
  })
  .strict();
export type RunHistoryListInput = z.infer<typeof RunHistoryListInputSchema>;

/**
 * Renderer-safe persisted run metadata. Paths and internal worktree identifiers intentionally
 * remain in the main process; an opaque run id is the only authority the renderer can select.
 */
export const RunHistorySummarySchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    nodeId: z.string().min(1).max(512),
    adapterId: z.string().min(1).max(128),
    status: TerminalRunHistoryStatusSchema,
    branch: z.string().min(1).max(4_096).nullable(),
    worktreeAvailable: z.boolean(),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type RunHistorySummary = z.infer<typeof RunHistorySummarySchema>;
