import { z } from 'zod';

export const PACKAGED_SMOKE_MARKER = 'FORGEBOARD_SMOKE_OK';
export const PACKAGED_SMOKE_PROFILE_FILE = '.forgeboard-smoke-profile.json';
export const PACKAGED_SMOKE_ROOT_ARGUMENT = '--forgeboard-smoke-root=';
export const PACKAGED_SMOKE_TOKEN_ARGUMENT = '--forgeboard-smoke-token=';
export const PACKAGED_SMOKE_HEADING = 'Ready to build without wiring config files?';
export const PACKAGED_SMOKE_ACTION = 'Set up Forgeboard';

export const PackagedSmokeProfileFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    token: z.string().uuid(),
  })
  .strict();

export const PackagedRendererProbeSchema = z
  .object({
    ready: z.boolean(),
    preloadReady: z.boolean(),
    ipcReady: z.boolean(),
    dataDirectory: z.string().nullable(),
    databasePath: z.string().nullable(),
    onboardingCompleted: z.boolean().nullable(),
    recentProjectCount: z.number().int(),
    heading: z.string().nullable(),
    primaryAction: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type PackagedRendererProbe = z.infer<typeof PackagedRendererProbeSchema>;

export const PackagedSmokeReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    profilePath: z.string().min(1),
    databasePath: z.string().min(1),
    gitVersion: z.string().regex(/^git version \d+\./u),
    renderer: z.literal('ready'),
    preload: z.literal('ready'),
    ipc: z.literal('ready'),
    firstRun: z.literal('ready'),
    heading: z.literal(PACKAGED_SMOKE_HEADING),
    primaryAction: z.literal(PACKAGED_SMOKE_ACTION),
    recentProjectCount: z.literal(0),
  })
  .strict();
export type PackagedSmokeReport = z.infer<typeof PackagedSmokeReportSchema>;
