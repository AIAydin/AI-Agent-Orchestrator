import { z } from 'zod';

export const ThemeSchema = z.enum(['system', 'light', 'dark']);
export type Theme = z.infer<typeof ThemeSchema>;

export const PermissionProfileSchema = z.enum([
  'plan-read-only',
  'worktree-write',
  'docker-isolated',
  'custom',
]);
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

export const CommandConfigurationSchema = z.object({
  executable: z.string().max(32_768).default(''),
  arguments: z.array(z.string().max(32_768)).max(512).default([]),
});
export type CommandConfiguration = z.infer<typeof CommandConfigurationSchema>;

export const AppSettingsSchema = z.object({
  theme: ThemeSchema,
  reducedMotion: z.boolean(),
  density: z.enum(['comfortable', 'compact']),
  canvasGridSize: z.number().int().min(4).max(128).default(16),
  canvasSnapToGrid: z.boolean().default(true),
  keyboardPreset: z.enum(['standard', 'vscode']).default('standard'),
  defaultAgent: z.enum(['test-agent', 'codex', 'claude', 'gemini', 'opencode', 'custom']),
  defaultPermissionProfile: PermissionProfileSchema,
  agentExecutableOverrides: z.record(z.string(), z.string().max(32_768)).default({}),
  agentDefaultModels: z.record(z.string(), z.string().max(512)).default({}),
  worktreeRoot: z.string(),
  worktreeCleanupPolicy: z.enum(['manual', 'after-merge', 'after-retention']).default('manual'),
  branchPrefix: z.string().min(1).max(128).default('forgeboard/'),
  gitIdentityName: z.string().max(512).default(''),
  gitIdentityEmail: z.string().max(512).default(''),
  gitRemote: z.string().min(1).max(512).default('origin'),
  terminalShell: z.string(),
  envAllowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  developmentCommand: CommandConfigurationSchema.default({ executable: '', arguments: [] }),
  testCommand: CommandConfigurationSchema.default({ executable: '', arguments: [] }),
  lintCommand: CommandConfigurationSchema.default({ executable: '', arguments: [] }),
  typecheckCommand: CommandConfigurationSchema.default({ executable: '', arguments: [] }),
  buildCommand: CommandConfigurationSchema.default({ executable: '', arguments: [] }),
  previewPortStart: z.number().int().min(1024).max(65534),
  previewPortEnd: z.number().int().min(1025).max(65535),
  previewTrustedHosts: z.array(z.string().min(1).max(512)).default(['127.0.0.1', 'localhost']),
  dockerEnabled: z.boolean().default(false),
  dockerExecutable: z.string().min(1).max(32_768).default('docker'),
  dockerImage: z.string().min(1).max(1024).default('node:22-bookworm'),
  dockerNetwork: z.enum(['disabled', 'enabled']).default('disabled'),
  dockerCpuLimit: z.number().positive().max(128).default(2),
  dockerMemoryMb: z.number().int().min(128).max(1_048_576).default(4096),
  dockerMountHostCredentials: z.boolean().default(false),
  transcriptRetentionDays: z.number().int().min(1).max(3650),
  auditRetentionDays: z.number().int().min(1).max(3650).default(365),
  snapshotRetentionCount: z.number().int().min(1).max(10_000).default(100),
  autosaveIntervalMs: z.number().int().min(250).max(60_000).default(2000),
  backupsEnabled: z.boolean().default(true),
  backupDirectory: z.string().max(32_768).default(''),
  collaborationEnabled: z.boolean(),
  collaborationUrl: z.string(),
  collaborationDisplayName: z.string().min(1).max(200).default('Local user'),
  collaborationRoom: z.string().min(1).max(200).default('default'),
  collaborationReconnect: z.boolean().default(true),
  updateChannel: z.enum(['stable', 'prerelease', 'disabled']).default('stable'),
  automaticUpdateDownloads: z.boolean().default(false),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const GitHealthSchema = z.object({
  isGitRepository: z.boolean(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  remotes: z.array(z.object({ name: z.string(), url: z.string() })),
  packageManager: z.enum(['pnpm', 'npm', 'yarn', 'bun', 'unknown']),
  frameworks: z.array(z.string()),
  scripts: z.record(z.string()),
  hasSubmodules: z.boolean(),
  sensitiveWarnings: z.array(z.string()),
});
export type GitHealth = z.infer<typeof GitHealthSchema>;

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  path: z.string().min(1),
  openedAt: z.string().datetime(),
  missing: z.boolean(),
  health: GitHealthSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const AgentDetectionSchema = z.object({
  id: z.enum(['test-agent', 'codex', 'claude', 'gemini', 'opencode', 'gh', 'docker']),
  label: z.string(),
  installed: z.boolean(),
  executable: z.string().nullable(),
  version: z.string().nullable(),
  providerDisclosure: z.string(),
});
export type AgentDetection = z.infer<typeof AgentDetectionSchema>;

export const RunAdapterIdSchema = z.enum(['test-agent', 'codex', 'claude', 'gemini', 'opencode']);
export type RunAdapterId = z.infer<typeof RunAdapterIdSchema>;

export const PrepareRunInputSchema = z.object({
  projectId: z.string().uuid(),
  repositoryPath: z.string().min(1),
  nodeId: z.string().min(1),
  adapterId: RunAdapterIdSchema,
  prompt: z.string().trim().min(1).max(1_000_000),
  permissionProfile: z.enum(['plan-read-only', 'worktree-write']),
});
export type PrepareRunInput = z.infer<typeof PrepareRunInputSchema>;

export const RunDisclosureSchema = z.object({
  runId: z.string().uuid(),
  nodeId: z.string(),
  adapterId: RunAdapterIdSchema,
  provider: z.string(),
  executable: z.string(),
  arguments: z.array(z.string()),
  cwd: z.string(),
  runtime: z.enum(['pty', 'pipes']),
  environmentVariableNames: z.array(z.string()),
  contextAttachments: z.array(z.object({ path: z.string(), kind: z.string() })),
  permissionProfile: z.object({
    name: z.string(),
    mode: z.string(),
    enforcement: z.string(),
    readRoots: z.array(z.string()),
    writeRoots: z.array(z.string()),
    network: z.string(),
  }),
  warnings: z.array(z.string()),
  branch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  primaryWasDirty: z.boolean(),
});
export type RunDisclosure = z.infer<typeof RunDisclosureSchema>;

export const RunEventEnvelopeSchema = z.object({
  runId: z.string().uuid(),
  nodeId: z.string(),
  kind: z.enum(['agent-event', 'run-summary', 'run-error']),
  payload: z.unknown(),
});
export type RunEventEnvelope = z.infer<typeof RunEventEnvelopeSchema>;

export const AuditListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200),
  })
  .strict();
export type AuditListInput = z.infer<typeof AuditListInputSchema>;

export const AuditEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    category: z.string().min(1),
    action: z.string().min(1),
    outcome: z.enum(['allowed', 'denied', 'failed']),
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const CanvasNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  width: z.number().optional(),
  height: z.number().optional(),
  data: z.record(z.unknown()),
});

export const CanvasEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  type: z.enum(['context', 'execute', 'output', 'review', 'revision', 'dependency']),
  data: z.record(z.unknown()).optional(),
});

export const CanvasDocumentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() }),
  updatedAt: z.string().datetime(),
});
export type CanvasDocument = z.infer<typeof CanvasDocumentSchema>;

export const CreateProjectInputSchema = z.object({
  parentPath: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[^/\\:\0]+$/),
  initializeGit: z.boolean(),
});

export const CloneProjectInputSchema = z.object({
  remoteUrl: z.string().min(1).max(2048),
  destinationPath: z.string().min(1),
});

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string(),
  dataDirectory: z.string(),
  databasePath: z.string(),
  transcriptDirectory: z.string(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

export const IPC_CHANNELS = Object.freeze({
  appInfo: 'app:get-info',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',
  settingsExport: 'settings:export',
  settingsImport: 'settings:import',
  agentsDetect: 'agents:detect',
  projectsRecent: 'projects:recent',
  projectsPick: 'projects:pick',
  projectsPickParent: 'projects:pick-parent',
  projectsPickExecutable: 'projects:pick-executable',
  projectsOpen: 'projects:open',
  projectsCreate: 'projects:create',
  projectsClone: 'projects:clone',
  projectsDemo: 'projects:demo',
  canvasLoad: 'canvas:load',
  canvasSave: 'canvas:save',
  privacyExport: 'privacy:export',
  privacyDelete: 'privacy:delete',
  runsPrepare: 'runs:prepare',
  runsApprove: 'runs:approve',
  runsInput: 'runs:input',
  runsInterrupt: 'runs:interrupt',
  runsTerminate: 'runs:terminate',
  runsEvent: 'runs:event',
  auditList: 'audit:list',
} as const);
