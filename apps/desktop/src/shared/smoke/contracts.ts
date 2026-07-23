import { z } from 'zod';

export const PACKAGED_SMOKE_MARKER = 'FORGEBOARD_SMOKE_OK';
export const PACKAGED_SMOKE_PROFILE_FILE = '.forgeboard-smoke-profile.json';
export const PACKAGED_SMOKE_ROOT_ARGUMENT = '--forgeboard-smoke-root=';
export const PACKAGED_SMOKE_TOKEN_ARGUMENT = '--forgeboard-smoke-token=';
export const PACKAGED_SMOKE_HEADING = 'Ready to build without wiring config files?';
export const PACKAGED_SMOKE_ACTION = 'Set up Forgeboard';
export const PACKAGED_SMOKE_SAFE_DEFAULTS_ACTION = 'Use safe defaults';
export const PACKAGED_SMOKE_DEMO_ACTION = 'Explore the safe demo';
export const PACKAGED_SMOKE_DEMO_PROJECT_NAME = 'forgeboard-demo';
export const PACKAGED_SMOKE_CANVAS_NAME = 'Workshop';

export const PackagedSmokeProfileFileSchema = z
  .object({
    schemaVersion: z.literal(2),
    token: z.string().uuid(),
    profileRoot: z.string().min(1),
    profileParent: z.string().min(1),
    systemTempRoot: z.string().min(1),
    profileKind: z.enum(['packaged-runtime', 'installer']),
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

export const PackagedRendererActionSchema = z
  .object({
    clicked: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();
export type PackagedRendererAction = z.infer<typeof PackagedRendererActionSchema>;

export const PackagedRendererWelcomeProbeSchema = z
  .object({
    ready: z.boolean(),
    preloadReady: z.boolean(),
    ipcReady: z.boolean(),
    onboardingCompleted: z.boolean().nullable(),
    recentProjectCount: z.number().int(),
    demoAction: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type PackagedRendererWelcomeProbe = z.infer<typeof PackagedRendererWelcomeProbeSchema>;

export const PackagedRendererDemoProbeSchema = z
  .object({
    ready: z.boolean(),
    preloadReady: z.boolean(),
    ipcReady: z.boolean(),
    onboardingCompleted: z.boolean().nullable(),
    recentProjectCount: z.number().int(),
    projectId: z.string().uuid().nullable(),
    projectName: z.string().nullable(),
    projectPath: z.string().nullable(),
    projectMissing: z.boolean().nullable(),
    projectGitReady: z.boolean().nullable(),
    canvasId: z.string().uuid().nullable(),
    canvasName: z.string().nullable(),
    canvasProjectId: z.string().uuid().nullable(),
    workspaceProjectName: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type PackagedRendererDemoProbe = z.infer<typeof PackagedRendererDemoProbeSchema>;

export const PackagedSmokeReportSchema = z
  .object({
    schemaVersion: z.literal(2),
    profilePath: z.string().min(1),
    databasePath: z.string().min(1),
    gitVersion: z.string().regex(/^git version \d+\./u),
    renderer: z.literal('ready'),
    preload: z.literal('ready'),
    ipc: z.literal('ready'),
    firstRun: z.literal('ready'),
    heading: z.literal(PACKAGED_SMOKE_HEADING),
    primaryAction: z.literal(PACKAGED_SMOKE_ACTION),
    safeDefaults: z.literal('applied'),
    demoWorkspace: z.literal('ready'),
    recentProjectCount: z.literal(1),
    demoProjectId: z.string().uuid(),
    demoProjectName: z.literal(PACKAGED_SMOKE_DEMO_PROJECT_NAME),
    demoProjectPath: z.string().min(1),
    demoCanvasId: z.string().uuid(),
    demoCanvasName: z.literal(PACKAGED_SMOKE_CANVAS_NAME),
  })
  .strict();
export type PackagedSmokeReport = z.infer<typeof PackagedSmokeReportSchema>;
