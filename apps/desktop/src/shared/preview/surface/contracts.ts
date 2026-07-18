import { z } from 'zod';

import { PreviewNodeKeySchema } from '../../application/contracts.js';

const MAX_CONSOLE_MESSAGE_CHARACTERS = 8_192;

export const PREVIEW_SURFACE_IPC_CHANNELS = Object.freeze({
  create: 'preview-surface:create',
  bounds: 'preview-surface:bounds',
  navigate: 'preview-surface:navigate',
  reload: 'preview-surface:reload',
  history: 'preview-surface:history',
  console: 'preview-surface:console',
  screenshot: 'preview-surface:screenshot',
  openExternal: 'preview-surface:open-external',
  close: 'preview-surface:close',
  event: 'preview-surface:event',
});

export const PreviewSurfaceIdSchema = z.string().uuid();
export type PreviewSurfaceId = z.infer<typeof PreviewSurfaceIdSchema>;

export const PreviewSurfaceBoundsSchema = z
  .object({
    x: z.number().int().min(0).max(32_768),
    y: z.number().int().min(0).max(32_768),
    width: z.number().int().min(64).max(8_192),
    height: z.number().int().min(64).max(8_192),
    visible: z.boolean(),
  })
  .strict();
export type PreviewSurfaceBounds = z.infer<typeof PreviewSurfaceBoundsSchema>;

export const PreviewSurfaceCreateInputSchema = PreviewNodeKeySchema.extend({
  url: z.string().url().max(32_768),
  bounds: PreviewSurfaceBoundsSchema,
  touchEmulation: z.boolean(),
}).strict();
export type PreviewSurfaceCreateInput = z.infer<typeof PreviewSurfaceCreateInputSchema>;

export const PreviewSurfaceTargetSchema = z
  .object({
    surfaceId: PreviewSurfaceIdSchema,
  })
  .strict();
export type PreviewSurfaceTarget = z.infer<typeof PreviewSurfaceTargetSchema>;

export const PreviewSurfaceBoundsInputSchema = PreviewSurfaceTargetSchema.extend({
  bounds: PreviewSurfaceBoundsSchema,
}).strict();
export type PreviewSurfaceBoundsInput = z.infer<typeof PreviewSurfaceBoundsInputSchema>;

export const PreviewSurfaceNavigateInputSchema = PreviewSurfaceTargetSchema.extend({
  url: z.string().url().max(32_768),
}).strict();
export type PreviewSurfaceNavigateInput = z.infer<typeof PreviewSurfaceNavigateInputSchema>;

export const PreviewSurfaceHistoryInputSchema = PreviewSurfaceTargetSchema.extend({
  direction: z.enum(['back', 'forward']),
}).strict();
export type PreviewSurfaceHistoryInput = z.infer<typeof PreviewSurfaceHistoryInputSchema>;

export const PreviewConsoleLevelSchema = z.enum(['debug', 'info', 'warning', 'error']);
export type PreviewConsoleLevel = z.infer<typeof PreviewConsoleLevelSchema>;

export const PreviewConsoleEntrySchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    capturedAt: z.string().datetime(),
    level: PreviewConsoleLevelSchema,
    message: z.string().max(MAX_CONSOLE_MESSAGE_CHARACTERS),
    source: z.string().max(2_048).nullable(),
    line: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type PreviewConsoleEntry = z.infer<typeof PreviewConsoleEntrySchema>;

export const PreviewConsoleViewSchema = z
  .object({
    entries: PreviewConsoleEntrySchema.array().max(500),
    truncated: z.boolean(),
    retainedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024),
    disclosure: z.literal(
      'Console output is captured in memory only, bounded to 500 entries and 256 KiB, and may contain application data.',
    ),
  })
  .strict();
export type PreviewConsoleView = z.infer<typeof PreviewConsoleViewSchema>;

export const PreviewSurfaceViewSchema = z
  .object({
    surfaceId: PreviewSurfaceIdSchema,
    projectId: z.string().uuid(),
    nodeId: z.string().min(1).max(256),
    slot: z.enum(['comparison-left', 'comparison-right']).optional(),
    url: z.string().url().max(32_768),
    status: z.enum(['loading', 'ready', 'failed']),
    bounds: PreviewSurfaceBoundsSchema,
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    touchEmulation: z.boolean(),
    failure: z.string().max(2_048).nullable(),
  })
  .strict();
export type PreviewSurfaceView = z.infer<typeof PreviewSurfaceViewSchema>;

export const PreviewScreenshotResultSchema = z
  .object({
    saved: z.boolean(),
    width: z.number().int().nonnegative().max(8_192),
    height: z.number().int().nonnegative().max(8_192),
  })
  .strict();
export type PreviewScreenshotResult = z.infer<typeof PreviewScreenshotResultSchema>;

export const PreviewSurfaceEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('changed'), surface: PreviewSurfaceViewSchema }).strict(),
  z.object({ type: z.literal('console'), surfaceId: PreviewSurfaceIdSchema }).strict(),
]);
export type PreviewSurfaceEvent = z.infer<typeof PreviewSurfaceEventSchema>;
