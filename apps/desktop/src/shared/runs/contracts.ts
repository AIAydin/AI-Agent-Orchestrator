import { z } from 'zod';

import { PermissionProfileSchema } from '../permissions/contracts.js';

export const RUN_HISTORY_MAX_LIMIT = 200;
export const RUN_HISTORY_OUTPUT_PREVIEW_MAX_LENGTH = 16_384;

export const RunHistoryStatusSchema = z.enum([
  'prepared',
  'running',
  'paused',
  'succeeded',
  'failed',
  'interrupted',
  'terminated',
  'lost',
]);
export type RunHistoryStatus = z.infer<typeof RunHistoryStatusSchema>;

export const TerminalRunHistoryStatusSchema = RunHistoryStatusSchema.exclude([
  'prepared',
  'running',
  'paused',
]);
export type TerminalRunHistoryStatus = z.infer<typeof TerminalRunHistoryStatusSchema>;

export const RunHistoryActionSchema = z.enum(['launch', 'resume', 'retry']);
export type RunHistoryAction = z.infer<typeof RunHistoryActionSchema>;

export const RunHistoryTokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
    cachedInputTokens: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
    outputTokens: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
    totalTokens: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
  })
  .strict()
  .refine((usage) => Object.keys(usage).length > 0, 'Token usage cannot be empty.');
export type RunHistoryTokenUsage = z.infer<typeof RunHistoryTokenUsageSchema>;

export const RunHistoryWorktreeStateSchema = z.enum([
  'none',
  'active',
  'archived',
  'cleanup-pending',
  'cleaned',
]);
export type RunHistoryWorktreeState = z.infer<typeof RunHistoryWorktreeStateSchema>;

export const RunHistoryListInputSchema = z
  .object({
    projectId: z.string().uuid(),
    nodeId: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(RUN_HISTORY_MAX_LIMIT),
  })
  .strict();
export type RunHistoryListInput = z.infer<typeof RunHistoryListInputSchema>;

export const RunHistoryGetInputSchema = z
  .object({
    projectId: z.string().uuid(),
    runId: z.string().uuid(),
  })
  .strict();
export type RunHistoryGetInput = z.infer<typeof RunHistoryGetInputSchema>;

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
    model: z.string().min(1).max(200).nullable(),
    permissionProfile: PermissionProfileSchema.nullable(),
    providerSessionAvailable: z.boolean(),
    resumeSupported: z.boolean(),
    resumeCapabilitySource: z.enum(['manifest', 'probe']).nullable(),
    action: RunHistoryActionSchema,
    parentRunId: z.string().uuid().nullable(),
    status: RunHistoryStatusSchema,
    branch: z.string().min(1).max(4_096).nullable(),
    worktreeState: RunHistoryWorktreeStateSchema,
    worktreeAvailable: z.boolean(),
    supersededByNewerAttempt: z.boolean(),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime().nullable(),
    exitCode: z.number().int().nullable(),
    outputDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
    changedFileCount: z.number().int().nonnegative().max(100_000).nullable(),
    tokenUsage: RunHistoryTokenUsageSchema.nullable(),
    costUsd: z.number().finite().nonnegative().max(1_000_000_000).nullable(),
    outputPreview: z
      .string()
      .max(RUN_HISTORY_OUTPUT_PREVIEW_MAX_LENGTH)
      .refine((value) => !value.includes('\0'), 'Run output previews cannot contain NUL bytes.'),
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
    if (summary.supersededByNewerAttempt && summary.worktreeAvailable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['worktreeAvailable'],
        message: 'A superseded attempt cannot remain the active worktree authority.',
      });
    }
    if (summary.action === 'launch' && summary.parentRunId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parentRunId'],
        message: 'A fresh launch cannot claim a parent run.',
      });
    }
    if (summary.action !== 'launch' && summary.parentRunId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parentRunId'],
        message: 'A resumed or retried attempt requires its parent run.',
      });
    }
    if (summary.parentRunId === summary.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parentRunId'],
        message: 'An attempt cannot be its own parent.',
      });
    }
    if (summary.resumeSupported && summary.resumeCapabilitySource === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resumeCapabilitySource'],
        message: 'Resumable support must identify whether it was declared or probed.',
      });
    }
  });
export type RunHistorySummary = z.infer<typeof RunHistorySummarySchema>;
