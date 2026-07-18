import { NamespacedAgentAdapterIdSchema } from '@forgeboard/agent-adapters/identifiers';
import { CanvasSchema as CanonicalCanvasSchema, type Canvas } from '@forgeboard/core/domain';
import { z } from 'zod';

import { PreviewCommandSchema, PreviewTargetSchema } from '../preview/targets.js';

import {
  DockerContainerExecutableSchema,
  DockerExecutableSettingSchema,
  DockerImageReferenceSchema,
} from '../docker/contracts.js';
import {
  CollaborationColorSchema,
  CollaborationDisplayNameSchema,
  CollaborationRoomIdSchema,
  CollaborationServerUrlSchema,
  CollaborationSubjectSchema,
} from '../collaboration/values.js';
import {
  CustomPermissionProfileSettingsSchema,
  PermissionProfileSchema,
} from '../permissions/contracts.js';
import { CommandConfigurationSchema } from '../commands/configuration.js';
import {
  MachineSpecificPathSchema,
  OptionalMachineSpecificPathSchema,
  OptionalMachineSpecificValueSchema,
  PreviewTrustedHostsSchema,
} from '../settings/values.js';

export {
  CustomPermissionProfileSettingsSchema,
  PermissionProfileSchema,
  type CustomPermissionProfileSettings,
  type PermissionProfile,
} from '../permissions/contracts.js';
export {
  CommandConfigurationSchema,
  type CommandConfiguration,
} from '../commands/configuration.js';

export const ThemeSchema = z.enum(['system', 'light', 'dark']);
export type Theme = z.infer<typeof ThemeSchema>;

const EnvironmentAllowlistSchema = z
  .array(
    z
      .string()
      .max(512)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  )
  .max(256)
  .superRefine((names, context) => {
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each environment variable name can appear only once.',
      });
    }
  });

export const CustomCheckConfigurationSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().trim().min(1).max(128),
    command: CommandConfigurationSchema,
  })
  .strict();
export type CustomCheckConfiguration = z.infer<typeof CustomCheckConfigurationSchema>;

export const CustomChecksSchema = z
  .array(CustomCheckConfigurationSchema)
  .max(32)
  .superRefine((checks, context) => {
    if (new Set(checks.map((check) => check.id)).size !== checks.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Custom check IDs must be unique.',
      });
    }
  });

function isValidBranchPrefix(value: string): boolean {
  const prefix = value.endsWith('/') ? value.slice(0, -1) : value;
  if (
    prefix === '' ||
    prefix.startsWith('/') ||
    prefix.startsWith('-') ||
    prefix.toLowerCase().startsWith('refs/') ||
    prefix.includes('\\') ||
    prefix.includes('//') ||
    prefix.includes('..') ||
    prefix.includes('@{') ||
    ['~', '^', ':', '?', '*', '[', ']'].some((character) => prefix.includes(character)) ||
    [...prefix].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 32 || code === 127;
    })
  ) {
    return false;
  }
  return prefix
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        !segment.startsWith('.') &&
        !segment.endsWith('.') &&
        !segment.toLowerCase().endsWith('.lock'),
    );
}

export const BranchPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(isValidBranchPrefix, 'Use a branch prefix such as forgeboard/ or team/agents/.');

const CustomAgentArgumentSchema = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes('\0'), 'Custom agent arguments cannot contain NUL bytes.')
  .refine(
    (value) =>
      ![
        '{prompt}',
        '{sessionId}',
        '{model}',
        '{modelArgs}',
        '{permissionArgs}',
        '{contextArgs}',
        '{extraArgs}',
        '{contextPath}',
      ].includes(value),
    'Placeholders such as {prompt} are reserved for Forgeboard. Use a different argument.',
  );

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

export const CustomAgentConfigurationSchema = z
  .object({
    enabled: z.boolean().default(false),
    name: z.string().trim().min(1).max(128).default('Custom agent'),
    providerName: z.string().trim().min(1).max(128).default('Custom provider'),
    providerDisclosure: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .default(
        'This custom agent may send the prompt and selected context to its configured provider.',
      ),
    sendsContextOffDevice: z.boolean().default(true),
    executable: OptionalMachineSpecificValueSchema.default(''),
    versionArguments: z.array(CustomAgentArgumentSchema).min(1).max(16).default(['--version']),
    launchArguments: z.array(CustomAgentArgumentSchema).max(256).default([]),
    promptTransport: z.enum(['argument', 'stdin']).default('argument'),
    runtime: z.enum(['pty', 'pipes']).default('pty'),
    output: z.enum(['text', 'json-lines']).default('text'),
  })
  .strict();
export type CustomAgentConfiguration = z.infer<typeof CustomAgentConfigurationSchema>;

/** UI-configured Git remote name. The main process still resolves it from the selected repository. */
export const GitRemoteSettingSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 'Use letters, numbers, dots, underscores, or hyphens.');

export const AppSettingsSchema = z
  .object({
    onboardingCompleted: z.boolean().default(false),
    theme: ThemeSchema,
    reducedMotion: z.boolean(),
    density: z.enum(['comfortable', 'compact']),
    canvasGridSize: z.number().int().min(4).max(128).default(16),
    canvasSnapToGrid: z.boolean().default(true),
    keyboardPreset: z.enum(['standard', 'vscode']).default('standard'),
    defaultAgent: z.enum(['test-agent', 'codex', 'claude', 'gemini', 'opencode', 'custom']),
    defaultPermissionProfile: PermissionProfileSchema,
    agentExecutableOverrides: z.record(z.string(), OptionalMachineSpecificValueSchema).default({}),
    agentDefaultModels: z.record(z.string(), z.string().max(512)).default({}),
    customAgent: CustomAgentConfigurationSchema.default({}),
    customPermissionProfile: CustomPermissionProfileSettingsSchema.default({}),
    worktreeRoot: MachineSpecificPathSchema,
    worktreeCleanupPolicy: z.enum(['manual', 'after-merge', 'after-retention']).default('manual'),
    branchPrefix: BranchPrefixSchema.default('forgeboard/'),
    gitIdentityName: z
      .string()
      .max(512)
      .refine((value) => !containsControlCharacter(value))
      .default(''),
    gitIdentityEmail: z
      .string()
      .max(512)
      .refine((value) => !containsControlCharacter(value))
      .default(''),
    gitRemote: GitRemoteSettingSchema.default('origin'),
    terminalShell: OptionalMachineSpecificValueSchema,
    envAllowlist: EnvironmentAllowlistSchema,
    developmentCommand: CommandConfigurationSchema.default({
      executable: '',
      arguments: [],
    }),
    testCommand: CommandConfigurationSchema.default({
      executable: '',
      arguments: [],
    }),
    lintCommand: CommandConfigurationSchema.default({
      executable: '',
      arguments: [],
    }),
    typecheckCommand: CommandConfigurationSchema.default({
      executable: '',
      arguments: [],
    }),
    buildCommand: CommandConfigurationSchema.default({
      executable: '',
      arguments: [],
    }),
    customChecks: CustomChecksSchema.optional(),
    previewPortStart: z.number().int().min(1024).max(65534),
    previewPortEnd: z.number().int().min(1025).max(65535),
    previewTrustedHosts: PreviewTrustedHostsSchema.default(['127.0.0.1', 'localhost']),
    dockerEnabled: z.boolean().default(false),
    dockerExecutable: DockerExecutableSettingSchema.default('docker'),
    dockerImage: z.union([z.literal(''), DockerImageReferenceSchema]).default(''),
    dockerContainerExecutable: z
      .union([z.literal(''), DockerContainerExecutableSchema])
      .default(''),
    dockerNetwork: z.enum(['disabled', 'enabled']).default('disabled'),
    dockerCpuLimit: z.number().positive().max(128).default(2),
    dockerMemoryMb: z.number().int().min(128).max(1_048_576).default(4096),
    dockerMountHostCredentials: z.boolean().default(false),
    transcriptRetentionDays: z.number().int().min(1).max(3650),
    auditRetentionDays: z.number().int().min(1).max(3650).default(365),
    snapshotRetentionCount: z.number().int().min(1).max(10_000).default(100),
    autosaveIntervalMs: z.number().int().min(250).max(60_000).default(2000),
    backupsEnabled: z.boolean().default(true),
    backupDirectory: OptionalMachineSpecificPathSchema.default(''),
    backupIntervalHours: z.number().int().min(1).max(168).default(24),
    backupOnQuit: z.boolean().default(true),
    backupRetentionCount: z.number().int().min(1).max(365).default(30),
    collaborationEnabled: z.boolean(),
    collaborationUrl: z.union([z.literal(''), CollaborationServerUrlSchema]),
    collaborationDisplayName: CollaborationDisplayNameSchema.default('Local user'),
    collaborationSubject: CollaborationSubjectSchema.default('local-user'),
    collaborationColor: CollaborationColorSchema.default('#6d5efc'),
    collaborationRoom: CollaborationRoomIdSchema.default('default'),
    collaborationReconnect: z.boolean().default(true),
    updateChannel: z.enum(['stable', 'prerelease', 'disabled']).default('stable'),
    automaticUpdateDownloads: z.boolean().default(false),
  })
  .superRefine((settings, context) => {
    if (settings.previewPortEnd <= settings.previewPortStart) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['previewPortEnd'],
        message: 'Preview port end must be higher than preview port start.',
      });
    }
    if (settings.collaborationEnabled && settings.collaborationUrl === '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collaborationUrl'],
        message: 'Enter a collaboration server URL before enabling collaboration.',
      });
    }
    if (settings.customAgent.enabled && settings.customAgent.executable.trim() === '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customAgent', 'executable'],
        message: "Choose the custom agent's program file before enabling it.",
      });
    }
    if (settings.defaultAgent === 'custom' && !settings.customAgent.enabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultAgent'],
        message: 'Enable and set up the custom agent before making it the default agent.',
      });
    }
    if (settings.dockerEnabled && settings.dockerImage === '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dockerImage'],
        message: 'Choose a container image before enabling Docker profiles.',
      });
    }
    if (settings.dockerEnabled && settings.dockerContainerExecutable === '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dockerContainerExecutable'],
        message: 'Choose the agent executable inside the image before enabling Docker profiles.',
      });
    }
    if (settings.defaultPermissionProfile === 'docker-isolated' && !settings.dockerEnabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultPermissionProfile'],
        message: 'Enable and set up Docker before making it the default permission profile.',
      });
    }
    if (settings.customPermissionProfile.runtime === 'docker' && !settings.dockerEnabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customPermissionProfile', 'runtime'],
        message: 'Enable and set up Docker before using it for the Custom profile.',
      });
    }
    if (
      settings.defaultAgent === 'test-agent' &&
      settings.defaultPermissionProfile === 'custom' &&
      settings.customPermissionProfile.runtime === 'docker'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultAgent'],
        message:
          'The built-in test agent cannot run in Docker. Choose a different default agent, or run the Custom profile on this computer.',
      });
    }
    const hasGitIdentityName = settings.gitIdentityName.trim() !== '';
    const hasGitIdentityEmail = settings.gitIdentityEmail.trim() !== '';
    if (hasGitIdentityName !== hasGitIdentityEmail) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasGitIdentityName ? ['gitIdentityEmail'] : ['gitIdentityName'],
        message:
          'Fill in both Git identity fields, or leave both blank to use the Git settings from this repository.',
      });
    }
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

export const ProjectRecoveryAssessmentSchema = z
  .object({
    confirmationId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    projectId: z.string().uuid(),
    original: z
      .object({
        name: z.string().min(1).max(4_096),
        path: z.string().min(1).max(32_768),
        health: GitHealthSchema,
      })
      .strict(),
    candidate: z
      .object({
        name: z.string().min(1).max(4_096),
        path: z.string().min(1).max(32_768),
        health: GitHealthSchema,
      })
      .strict(),
    warnings: z.array(z.string().min(1).max(4_096)).max(32),
  })
  .strict();
export type ProjectRecoveryAssessment = z.infer<typeof ProjectRecoveryAssessmentSchema>;

export const LocateProjectRecoveryInputSchema = z.object({ projectId: z.string().uuid() }).strict();
export type LocateProjectRecoveryInput = z.infer<typeof LocateProjectRecoveryInputSchema>;

export const ConfirmProjectRecoveryInputSchema = z
  .object({
    projectId: z.string().uuid(),
    confirmationId: z.string().uuid(),
    confirmed: z.literal(true),
  })
  .strict();
export type ConfirmProjectRecoveryInput = z.infer<typeof ConfirmProjectRecoveryInputSchema>;

export const AgentDetectionSchema = z.object({
  id: z.union([
    z.enum(['test-agent', 'codex', 'claude', 'gemini', 'opencode', 'custom', 'gh', 'docker']),
    NamespacedAgentAdapterIdSchema,
  ]),
  label: z.string(),
  installed: z.boolean(),
  executable: z.string().nullable(),
  version: z.string().nullable(),
  providerDisclosure: z.string(),
});
export type AgentDetection = z.infer<typeof AgentDetectionSchema>;

export const RunAdapterIdSchema = z.union([
  z.enum(['test-agent', 'codex', 'claude', 'gemini', 'opencode', 'custom']),
  NamespacedAgentAdapterIdSchema,
]);
export type RunAdapterId = z.infer<typeof RunAdapterIdSchema>;

export const PrepareRunInputSchema = z
  .object({
    projectId: z.string().uuid(),
    nodeId: z.string().min(1),
    adapterId: RunAdapterIdSchema,
    prompt: z.string().trim().min(1).max(1_000_000),
    permissionProfile: PermissionProfileSchema,
  })
  .strict();
export type PrepareRunInput = z.infer<typeof PrepareRunInputSchema>;

const RunPermissionProfileBaseSchema = z
  .object({
    name: z.string(),
    mode: z.enum(['plan-read-only', 'worktree-write', 'docker-isolated']),
    enforcement: z.string(),
    readRoots: z.array(z.string()),
    writeRoots: z.array(z.string()),
    network: z.string(),
  })
  .strict();

const RunCustomPermissionProfileSchema = RunPermissionProfileBaseSchema.extend({
  mode: z.literal('custom'),
  custom: z.discriminatedUnion('runtime', [
    z
      .object({
        runtime: z.literal('host'),
        filesystem: z.enum([
          'assigned-worktree-read-only',
          'assigned-worktree-write',
          'explicit-paths',
        ]),
        ignoredFileRead: z.enum(['deny', 'allow']),
        sensitiveFileRead: z.enum(['deny', 'allow']),
        launchExecutablePolicy: z.enum(['selected-agent-only', 'allowlist']),
        allowedLaunchExecutables: z.array(z.string()),
        forgeboardManagedActions: z
          .object({
            developmentServers: z.enum(['deny', 'allow']),
            tests: z.enum(['deny', 'allow']),
          })
          .strict(),
        requireReviewBeforePrimary: z.literal(true),
        policyLimitations: z.array(z.string()),
      })
      .strict(),
    z
      .object({
        runtime: z.literal('docker'),
        filesystem: z.enum([
          'assigned-worktree-read-only',
          'assigned-worktree-write',
          'explicit-paths',
        ]),
        ignoredFileRead: z.enum(['deny', 'allow']),
        sensitiveFileRead: z.enum(['deny', 'allow']),
        launchExecutablePolicy: z.enum(['selected-agent-only', 'allowlist']),
        allowedLaunchExecutables: z.array(z.string()),
        forgeboardManagedActions: z
          .object({
            developmentServers: z.enum(['deny', 'allow']),
            tests: z.enum(['deny', 'allow']),
          })
          .strict(),
        requireReviewBeforePrimary: z.literal(true),
        policyLimitations: z.array(z.string()),
        docker: z
          .object({
            network: z.enum(['disabled', 'enabled']),
            cpuLimit: z.number(),
            memoryMb: z.number().int(),
            mountHostCredentials: z.literal(false),
          })
          .strict(),
      })
      .strict(),
  ]),
}).strict();

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
  contextAttachments: z.array(
    z.object({
      path: z.string(),
      kind: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
  ),
  contextManifestId: z.string().min(1).max(128).nullable(),
  contextManifestDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable(),
  permissionProfile: z.union([RunCustomPermissionProfileSchema, RunPermissionProfileBaseSchema]),
  warnings: z.array(z.string()),
  branch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  primaryWasDirty: z.boolean(),
});
export type RunDisclosure = z.infer<typeof RunDisclosureSchema>;

export const RunApprovalViewSchema = RunDisclosureSchema.extend({
  disclosureFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  expiresAt: z.string().datetime(),
}).strict();
export type RunApprovalView = z.infer<typeof RunApprovalViewSchema>;

export const RunEventEnvelopeSchema = z.object({
  runId: z.string().uuid(),
  nodeId: z.string(),
  kind: z.enum(['agent-event', 'run-summary', 'run-error']),
  payload: z.unknown(),
});
export type RunEventEnvelope = z.infer<typeof RunEventEnvelopeSchema>;

export const PreviewNodeKeySchema = z
  .object({
    projectId: z.string().uuid(),
    nodeId: z.string().min(1).max(512),
  })
  .strict();
export type PreviewNodeKey = z.infer<typeof PreviewNodeKeySchema>;

const PreviewPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('\0'), {
    message: 'Preview paths must be absolute URL paths.',
  });

export const PreviewStartInputSchema = PreviewNodeKeySchema.extend({
  target: PreviewTargetSchema.optional(),
  command: PreviewCommandSchema.optional(),
  cwdRelative: z.string().min(1).max(4096),
  readinessPath: PreviewPathSchema,
  urlPath: PreviewPathSchema,
  packageScript: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u)
    .optional(),
}).strict();
export type PreviewStartInput = z.infer<typeof PreviewStartInputSchema>;

export const PreviewNavigateInputSchema = PreviewNodeKeySchema.extend({
  url: z.string().min(1).max(32_768),
}).strict();
export type PreviewNavigateInput = z.infer<typeof PreviewNavigateInputSchema>;

export const PreviewLogSchema = z
  .object({
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    stream: z.enum(['stdout', 'stderr']),
    data: z.string(),
  })
  .strict();
export type PreviewLog = z.infer<typeof PreviewLogSchema>;

export const PreviewProcessSnapshotSchema = z
  .object({
    id: z.string(),
    pid: z.number().int().positive().nullable(),
    cwd: z.string(),
    port: z.number().int().min(1).max(65_535).nullable(),
    previewUrl: z.string().url().nullable(),
    status: z.enum(['starting', 'ready', 'exited']),
    exitCode: z.number().int().nullable(),
    exitSignal: z.string().nullable(),
    retainedLogBytes: z.number().int().nonnegative(),
    logs: z.array(PreviewLogSchema),
  })
  .strict();
export type PreviewProcessSnapshot = z.infer<typeof PreviewProcessSnapshotSchema>;

export const PreviewSessionSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum([
      'starting',
      'ready',
      'stopping',
      'stopped',
      'interrupted',
      'killed',
      'cancelled',
      'failed',
    ]),
    startedAt: z.string().datetime(),
    readyAt: z.string().datetime().nullable(),
    stoppedAt: z.string().datetime().nullable(),
    failure: z.string().nullable(),
    trustedHosts: z.array(z.string()),
    processes: z.array(PreviewProcessSnapshotSchema),
  })
  .strict();
export type PreviewSessionSnapshot = z.infer<typeof PreviewSessionSnapshotSchema>;

export const PreviewEventEnvelopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('state'),
      nodeId: z.string().min(1).max(512),
      session: PreviewSessionSnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('output'),
      nodeId: z.string().min(1).max(512),
      sessionId: z.string().uuid(),
      processId: z.string(),
      timestamp: z.string().datetime(),
      stream: z.enum(['stdout', 'stderr']),
      data: z.string().max(65_536),
    })
    .strict(),
]);
export type PreviewEventEnvelope = z.infer<typeof PreviewEventEnvelopeSchema>;

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

export const ExtensionSelectionKindSchema = z.enum(['folder', 'manifest']);
export type ExtensionSelectionKind = z.infer<typeof ExtensionSelectionKindSchema>;

export const LocalReferenceSelectionInputSchema = z
  .object({
    kind: z.enum(['file', 'directory']),
    multiple: z.boolean(),
  })
  .strict();
export type LocalReferenceSelectionInput = z.infer<typeof LocalReferenceSelectionInputSchema>;

export const LocalReferenceSelectionResultSchema = z.array(z.string().min(1).max(32_768)).max(256);

export const ExtensionPermissionViewSchema = z.enum([
  'agent.adapter.register',
  'agent.process.launch',
  'agent.context.selected-read',
  'agent.provider.network',
  'canvas.node.register',
  'canvas.data.persist',
]);

const ExtensionCanvasFieldBaseViewSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  description: z.string().min(1).max(1_024).optional(),
  required: z.boolean(),
});

export const ExtensionCanvasFieldViewSchema = z.discriminatedUnion('kind', [
  ExtensionCanvasFieldBaseViewSchema.extend({
    kind: z.enum(['text', 'multiline', 'markdown']),
    defaultValue: z.string().max(100_000).optional(),
    maxLength: z.number().int().min(1).max(100_000).optional(),
  }).strict(),
  ExtensionCanvasFieldBaseViewSchema.extend({
    kind: z.literal('number'),
    defaultValue: z.number().finite().optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
  }).strict(),
  ExtensionCanvasFieldBaseViewSchema.extend({
    kind: z.literal('boolean'),
    defaultValue: z.boolean().optional(),
  }).strict(),
  ExtensionCanvasFieldBaseViewSchema.extend({
    kind: z.literal('select'),
    options: z
      .array(z.object({ label: z.string(), value: z.string() }).strict())
      .min(1)
      .max(128),
    defaultValue: z.string().min(1).max(512).optional(),
  }).strict(),
  ExtensionCanvasFieldBaseViewSchema.extend({
    kind: z.enum(['file-reference', 'directory-reference']),
    multiple: z.boolean(),
  }).strict(),
]);
export type ExtensionCanvasFieldView = z.infer<typeof ExtensionCanvasFieldViewSchema>;

export const ExtensionCanvasPortViewSchema = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(128),
    direction: z.enum(['input', 'output']),
    dataType: z.enum(['context', 'execute', 'output', 'review', 'revision', 'dependency', 'any']),
    multiple: z.boolean(),
  })
  .strict();
export type ExtensionCanvasPortView = z.infer<typeof ExtensionCanvasPortViewSchema>;

export const ExtensionCanvasNodeTypeViewSchema = z
  .object({
    id: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128),
    description: z.string().min(1).max(2_048),
    category: z.string().min(1).max(128),
    icon: z.enum([
      'bot',
      'box',
      'check-circle',
      'file',
      'git-branch',
      'image',
      'layout',
      'note',
      'play',
      'terminal',
      'workflow',
    ]),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
    capabilities: z.array(z.string().min(1).max(128)).max(16),
    fields: z.array(ExtensionCanvasFieldViewSchema).max(64),
    ports: z.array(ExtensionCanvasPortViewSchema).max(32),
  })
  .strict();
export type ExtensionCanvasNodeTypeView = z.infer<typeof ExtensionCanvasNodeTypeViewSchema>;

const ExtensionManifestViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    description: z.string().min(1).max(4_096),
    publisher: z.string().min(1).max(256),
    requestedPermissions: z.array(ExtensionPermissionViewSchema).max(16),
    documentationFile: z.string().min(1).max(1_024).optional(),
    contributes: z
      .object({
        agentAdapters: z
          .array(
            z
              .object({
                id: z.string().min(1).max(128),
                name: z.string().min(1).max(128),
                providerName: z.string().min(1).max(128),
                providerDisclosure: z.string().min(1).max(4_096),
                sendsContextOffDevice: z.boolean(),
                executable: z.string().min(1).max(4_096),
                permissionModes: z
                  .array(z.enum(['plan-read-only', 'worktree-write', 'docker-isolated', 'custom']))
                  .max(4),
              })
              .strict(),
          )
          .max(16),
        canvasNodeTypes: z.array(ExtensionCanvasNodeTypeViewSchema).max(32),
      })
      .strict(),
  })
  .strict();
export type ExtensionManifestView = z.infer<typeof ExtensionManifestViewSchema>;

const InstalledExtensionRecordViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    extensionId: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    grantedPermissions: z.array(ExtensionPermissionViewSchema).max(16),
    sourcePath: z.string().min(1).max(32_768),
    installedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const ExtensionInstallPlanViewSchema = z
  .object({
    planId: z.string().uuid(),
    operation: z.enum(['install', 'update']),
    currentVersion: z.string().nullable(),
    manifest: ExtensionManifestViewSchema,
    manifestJson: z.string().min(2).max(1_048_576),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    sourcePath: z.string().min(1).max(32_768),
    requestedPermissions: z.array(ExtensionPermissionViewSchema).max(16),
    documentationText: z.string().max(262_144).optional(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ExtensionInstallPlanView = z.infer<typeof ExtensionInstallPlanViewSchema>;

const ExtensionSnapshotViewSchema = z
  .object({
    record: InstalledExtensionRecordViewSchema,
    manifest: ExtensionManifestViewSchema,
    manifestJson: z.string().min(2).max(1_048_576),
    documentationText: z.string().max(262_144).optional(),
  })
  .strict();

export const InstalledExtensionViewSchema = ExtensionSnapshotViewSchema.extend({
  trustState: z.literal('active'),
  approvedAt: z.string().datetime(),
}).strict();
export type InstalledExtensionView = z.infer<typeof InstalledExtensionViewSchema>;

export const QuarantinedExtensionViewSchema = z
  .object({
    extensionId: z.string().min(1).max(128),
    ledgerState: z.enum(['missing', 'pending', 'active', 'revoked']),
    reason: z.string().min(1).max(65_536),
    snapshot: ExtensionSnapshotViewSchema.optional(),
  })
  .strict();
export type QuarantinedExtensionView = z.infer<typeof QuarantinedExtensionViewSchema>;

export const InvalidInstalledExtensionViewSchema = z
  .object({
    entryName: z.string().min(1).max(32_768),
    reason: z.string().min(1).max(65_536),
  })
  .strict();
export type InvalidInstalledExtensionView = z.infer<typeof InvalidInstalledExtensionViewSchema>;

export const ExtensionDiscoveryViewSchema = z
  .object({
    registryPath: z.string().min(1).max(32_768),
    installed: z.array(InstalledExtensionViewSchema).max(1_024),
    quarantined: z.array(QuarantinedExtensionViewSchema).max(1_024),
    invalid: z.array(InvalidInstalledExtensionViewSchema).max(1_024),
  })
  .strict();
export type ExtensionDiscoveryView = z.infer<typeof ExtensionDiscoveryViewSchema>;

export const ExtensionApproveInputSchema = z
  .object({
    planId: z.string().uuid(),
    confirmed: z.literal(true),
  })
  .strict();
export type ExtensionApproveInput = z.infer<typeof ExtensionApproveInputSchema>;

export const ExtensionRemoveInputSchema = z
  .object({
    extensionId: z.string().min(1).max(128),
    confirmation: z.string().min(1).max(128),
  })
  .strict();
export type ExtensionRemoveInput = z.infer<typeof ExtensionRemoveInputSchema>;

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
  sourceHandle: z.string().nullable().optional(),
  targetHandle: z.string().nullable().optional(),
  type: z.enum(['context', 'execute', 'output', 'review', 'revision', 'dependency']),
  data: z.record(z.unknown()).optional(),
});

const EmbeddedCanonicalCanvasSchema = z.custom<Canvas>(
  (value) => CanonicalCanvasSchema.safeParse(value).success,
  'Invalid canonical canvas document',
);

export const CanvasDocumentSchema = z.object({
  schemaVersion: z.literal(2).optional(),
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema),
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().positive(),
  }),
  updatedAt: z.string().datetime(),
  canonical: EmbeddedCanonicalCanvasSchema.optional(),
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

export const BackupResultSchema = z
  .object({
    path: z.string().min(1).max(32_768),
    createdAt: z.string().datetime(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
export type BackupResult = z.infer<typeof BackupResultSchema>;

export const BackupHealthSchema = z
  .object({
    lastAttemptAt: z.string().datetime().nullable(),
    lastAttemptOutcome: z.enum(['verified', 'failed']).nullable(),
    lastError: z.string().max(4_096).nullable(),
    lastVerifiedAt: z.string().datetime().nullable(),
    lastVerifiedSizeBytes: z.number().int().positive().nullable(),
    lastVerifiedSha256Prefix: z
      .string()
      .regex(/^[a-f0-9]{12}$/u)
      .nullable(),
    verifiedBackupCount: z.number().int().nonnegative(),
  })
  .strict();
export type BackupHealth = z.infer<typeof BackupHealthSchema>;

export const AppCloseRequestSchema = z
  .object({
    requestId: z.string().uuid(),
  })
  .strict();
export type AppCloseRequest = z.infer<typeof AppCloseRequestSchema>;

export const AppCloseResponseSchema = z
  .object({
    requestId: z.string().uuid(),
    saved: z.boolean(),
  })
  .strict();
export type AppCloseResponse = z.infer<typeof AppCloseResponseSchema>;

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

export function ipcResultSchema<Schema extends z.ZodTypeAny>(
  valueSchema: Schema,
): z.ZodType<IpcResult<z.output<Schema>>, z.ZodTypeDef, unknown> {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: valueSchema }).strict(),
    z
      .object({
        ok: z.literal(false),
        error: z
          .object({
            code: z.string().min(1).max(128),
            message: z.string().min(1).max(65_536),
          })
          .strict(),
      })
      .strict(),
  ]) as unknown as z.ZodType<IpcResult<z.output<Schema>>, z.ZodTypeDef, unknown>;
}

export const IPC_CHANNELS = Object.freeze({
  appInfo: 'app:get-info',
  appCloseRequested: 'app:close-requested',
  appCloseResponse: 'app:close-response',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',
  settingsExport: 'settings:export',
  settingsImport: 'settings:import',
  settingsRepairList: 'settings:repair-list',
  settingsRepairGet: 'settings:repair-get',
  settingsRepairExport: 'settings:repair-export',
  settingsCheckFolderReadiness: 'settings:check-folder-readiness',
  agentsDetect: 'agents:detect',
  agentsCheckReadiness: 'agents:check-readiness',
  commandsCheckReadiness: 'commands:check-readiness',
  approvalsList: 'approvals:list',
  approvalsRevoke: 'approvals:revoke',
  projectsRecent: 'projects:recent',
  projectsPick: 'projects:pick',
  projectsPickParent: 'projects:pick-parent',
  projectsPickExecutable: 'projects:pick-executable',
  projectsPickReferences: 'projects:pick-references',
  projectsLocateMoved: 'projects:locate-moved',
  projectsConfirmMoved: 'projects:confirm-moved',
  projectsOpen: 'projects:open',
  projectsCreate: 'projects:create',
  projectsClone: 'projects:clone',
  projectsDemo: 'projects:demo',
  projectsInitializeGit: 'projects:initialize-git',
  canvasLoad: 'canvas:load',
  canvasSave: 'canvas:save',
  privacyExport: 'privacy:export',
  privacyDelete: 'privacy:delete',
  storageCreateBackup: 'storage:create-backup',
  storageBackupHealth: 'storage:backup-health',
  storageCheckIntegrity: 'storage:check-integrity',
  dockerCheck: 'docker:check',
  dockerPull: 'docker:pull',
  runsList: 'runs:list',
  runsPrepare: 'runs:prepare',
  runsApprove: 'runs:approve',
  runsInput: 'runs:input',
  runsInterrupt: 'runs:interrupt',
  runsTerminate: 'runs:terminate',
  runsEvent: 'runs:event',
  checksPrepare: 'checks:prepare',
  checksConfirm: 'checks:confirm',
  checksList: 'checks:list',
  checksCancel: 'checks:cancel',
  checksEvent: 'checks:event',
  previewsStart: 'previews:start',
  previewsRestart: 'previews:restart',
  previewsStop: 'previews:stop',
  previewsGet: 'previews:get',
  previewsNavigate: 'previews:navigate',
  previewsEvent: 'previews:event',
  auditList: 'audit:list',
  extensionsList: 'extensions:list',
  extensionsChoose: 'extensions:choose',
  extensionsApprove: 'extensions:approve',
  extensionsRemove: 'extensions:remove',
  gitReview: 'git:review',
  gitStagePaths: 'git:stage-paths',
  gitStageHunks: 'git:stage-hunks',
  gitUnstagePaths: 'git:unstage-paths',
  gitUnstageHunks: 'git:unstage-hunks',
  gitPrepareDiscard: 'git:prepare-discard',
  gitConfirmDiscard: 'git:confirm-discard',
  gitPrepareCommit: 'git:prepare-commit',
  gitConfirmCommit: 'git:confirm-commit',
  gitPrepareShipping: 'git:prepare-shipping',
  gitConfirmShipping: 'git:confirm-shipping',
} as const);
