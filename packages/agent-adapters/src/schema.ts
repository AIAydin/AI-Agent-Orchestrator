import path from 'node:path';

import { z } from 'zod';

import { AgentAdapterIdSchema } from './identifiers.js';

export { AgentAdapterIdSchema, NamespacedAgentAdapterIdSchema } from './identifiers.js';

export const AGENT_ADAPTER_API_VERSION = 1 as const;
export const AGENT_ADAPTERS_PACKAGE_VERSION = '0.1.0';

const withoutNul = (value: string): boolean => !value.includes('\0');
const withoutLineBreak = (value: string): boolean => !/[\r\n]/u.test(value);
const DOCKER_CONTEXT_SNAPSHOT_ROOT = '/forgeboard-context';

const ArgumentSchema = z
  .string()
  .max(1_000_000)
  .refine(withoutNul, 'Arguments cannot contain NUL bytes.');

const ExecutableSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(withoutNul, 'Executable cannot contain NUL bytes.')
  .refine(withoutLineBreak, 'Executable cannot contain line breaks.');

const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

const CapabilityMarkerSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(withoutNul, 'Capability markers cannot contain NUL bytes.');

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine(withoutNul, 'Paths cannot contain NUL bytes.')
  .refine(withoutLineBreak, 'Paths cannot contain line breaks.')
  .refine((value) => path.isAbsolute(value) || value.startsWith('/'), 'Path must be absolute.');

const CrossPlatformAbsoluteExecutableSchema = z
  .string()
  .trim()
  .min(1)
  .max(32_768)
  .refine(withoutNul, 'Executable paths cannot contain NUL bytes.')
  .refine(withoutLineBreak, 'Executable paths cannot contain line breaks.')
  .refine(
    (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\'),
    'Executable paths must be absolute.',
  );

export const PermissionModeSchema = z.enum([
  'plan-read-only',
  'worktree-write',
  'docker-isolated',
  'custom',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

const customPermissionDisclosureShape = {
  filesystem: z.enum(['assigned-worktree-read-only', 'assigned-worktree-write', 'explicit-paths']),
  ignoredFileRead: z.enum(['deny', 'allow']),
  sensitiveFileRead: z.enum(['deny', 'allow']),
  launchExecutablePolicy: z.enum(['selected-agent-only', 'allowlist']),
  allowedLaunchExecutables: z.array(CrossPlatformAbsoluteExecutableSchema).max(256),
  forgeboardManagedActions: z
    .object({
      developmentServers: z.enum(['deny', 'allow']),
      tests: z.enum(['deny', 'allow']),
    })
    .strict(),
  requireReviewBeforePrimary: z.literal(true),
  policyLimitations: z.array(z.string().trim().min(1).max(4_096)).max(32),
} as const;

export const CustomPermissionDisclosureSchema = z.discriminatedUnion('runtime', [
  z
    .object({
      ...customPermissionDisclosureShape,
      runtime: z.literal('host'),
    })
    .strict(),
  z
    .object({
      ...customPermissionDisclosureShape,
      runtime: z.literal('docker'),
      docker: z
        .object({
          network: z.enum(['disabled', 'enabled']),
          cpuLimit: z.number().finite().min(0.1).max(128),
          memoryMb: z.number().int().min(128).max(1_048_576),
          mountHostCredentials: z.literal(false),
        })
        .strict(),
    })
    .strict(),
]);
export type CustomPermissionDisclosure = z.infer<typeof CustomPermissionDisclosureSchema>;

export const PermissionProfileSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/u),
    name: z.string().trim().min(1).max(128),
    mode: PermissionModeSchema,
    enforcement: z.enum(['provider', 'docker', 'disclosure-only']),
    readRoots: z.array(AbsolutePathSchema).max(256),
    writeRoots: z.array(AbsolutePathSchema).max(256),
    network: z.enum(['allowed', 'blocked', 'provider-controlled']),
    approvalPolicy: z.string().trim().min(1).max(1_024),
    disclosure: z.string().trim().min(1).max(4_096),
    custom: CustomPermissionDisclosureSchema.optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.mode === 'plan-read-only' && profile.writeRoots.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writeRoots'],
        message: 'A plan/read-only profile cannot declare writable roots.',
      });
    }

    if (profile.mode === 'docker-isolated' && profile.enforcement !== 'docker') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['enforcement'],
        message: 'Docker-isolated profiles must be enforced by a Docker runtime.',
      });
    }

    if (profile.custom !== undefined && profile.mode !== 'custom') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['custom'],
        message: 'Custom policy disclosure is valid only for the Custom permission mode.',
      });
    }
    if (profile.mode === 'custom' && profile.custom === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['custom'],
        message: 'Custom permission mode requires an exact structured Custom policy disclosure.',
      });
    }
    if (profile.custom !== undefined) {
      const custom = profile.custom;
      if (
        custom.runtime === 'host' &&
        (profile.enforcement !== 'disclosure-only' || profile.network !== 'provider-controlled')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['enforcement'],
          message: 'Host Custom profiles are disclosure-only with provider-controlled network.',
        });
      }
      if (custom.runtime === 'docker' && profile.enforcement !== 'docker') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['enforcement'],
          message: 'Docker Custom profiles require Docker enforcement.',
        });
      }
      if (custom.runtime === 'docker') {
        const expectedNetwork = custom.docker.network === 'enabled' ? 'allowed' : 'blocked';
        if (profile.network !== expectedNetwork) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['network'],
            message: 'Docker Custom network disclosure must match its effective Docker policy.',
          });
        }
        if (custom.ignoredFileRead !== 'allow' || custom.sensitiveFileRead !== 'allow') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['custom', 'sensitiveFileRead'],
            message:
              'A whole-worktree Docker bind requires explicit ignored and sensitive visibility.',
          });
        }
      }
      const filesystemReadRoots =
        custom.runtime === 'docker'
          ? profile.readRoots.filter((root) => root !== DOCKER_CONTEXT_SNAPSHOT_ROOT)
          : profile.readRoots;
      const snapshotRootCount = profile.readRoots.length - filesystemReadRoots.length;
      const wholeRead =
        filesystemReadRoots.length === 1 && (custom.runtime !== 'docker' || snapshotRootCount <= 1);
      const wholeWrite =
        profile.writeRoots.length === 1 &&
        wholeRead &&
        profile.writeRoots[0] === filesystemReadRoots[0];
      if (
        custom.filesystem === 'assigned-worktree-read-only' &&
        (!wholeRead || profile.writeRoots.length > 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['writeRoots'],
          message: 'Read-only Custom profiles require one read root and no write roots.',
        });
      }
      if (custom.filesystem === 'assigned-worktree-write' && !wholeWrite) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['writeRoots'],
          message: 'Writable Custom profiles require the same single read and write root.',
        });
      }
      if (custom.runtime === 'docker' && custom.filesystem === 'explicit-paths') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['custom', 'filesystem'],
          message: 'Docker Custom profiles support only a whole-worktree bind.',
        });
      }
      for (const [index, writeRoot] of profile.writeRoots.entries()) {
        if (!profile.readRoots.some((readRoot) => pathContains(readRoot, writeRoot))) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['writeRoots', index],
            message: 'Every Custom write root must be covered by a read root.',
          });
        }
      }
      if (
        new Set(custom.allowedLaunchExecutables).size !== custom.allowedLaunchExecutables.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['custom', 'allowedLaunchExecutables'],
          message: 'Custom launch executable paths must be unique.',
        });
      }
      if (
        custom.launchExecutablePolicy === 'selected-agent-only' &&
        custom.allowedLaunchExecutables.length !== 1
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['custom', 'allowedLaunchExecutables'],
          message: 'Selected-agent-only disclosure requires exactly one resolved executable.',
        });
      }
      if (
        custom.launchExecutablePolicy === 'allowlist' &&
        custom.allowedLaunchExecutables.length === 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['custom', 'allowedLaunchExecutables'],
          message: 'Custom allowlist disclosure requires at least one executable.',
        });
      }
    }
  });
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export const ContextAttachmentSchema = z
  .object({
    path: AbsolutePathSchema,
    kind: z.enum(['file', 'directory']),
    label: z.string().trim().min(1).max(256).optional(),
    explicitlyApproved: z.literal(true),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
  })
  .strict();
export type ContextAttachment = z.infer<typeof ContextAttachmentSchema>;

const TemplateArgumentSchema = ArgumentSchema.refine((value) => {
  if (!/^\{[A-Za-z]+\}$/u.test(value)) return true;
  return [
    '{prompt}',
    '{sessionId}',
    '{model}',
    '{modelArgs}',
    '{permissionArgs}',
    '{contextArgs}',
    '{extraArgs}',
    '{contextPath}',
  ].includes(value);
}, 'Invocation contains an unknown template placeholder.');

const InvocationSchema = z
  .object({
    runtime: z.enum(['pty', 'pipes']).default('pty'),
    launchArguments: z.array(TemplateArgumentSchema).max(512),
    resumeArguments: z.array(TemplateArgumentSchema).max(512).optional(),
    promptTransport: z.enum(['argument', 'stdin']).default('argument'),
    promptTerminator: z.enum(['', '\n', '\r\n']).default('\n'),
    modelArguments: z.array(TemplateArgumentSchema).max(32).default([]),
    context: z
      .discriminatedUnion('strategy', [
        z.object({ strategy: z.literal('prompt-references') }).strict(),
        z
          .object({
            strategy: z.literal('repeat-arguments'),
            arguments: z.array(TemplateArgumentSchema).min(1).max(16),
            supportedKinds: z.array(z.enum(['file', 'directory'])).min(1),
          })
          .strict(),
        z.object({ strategy: z.literal('none') }).strict(),
      ])
      .default({ strategy: 'prompt-references' }),
    permissionArguments: z
      .object({
        'plan-read-only': z.array(ArgumentSchema).max(32).optional(),
        'worktree-write': z.array(ArgumentSchema).max(32).optional(),
        'docker-isolated': z.array(ArgumentSchema).max(64).optional(),
        custom: z.array(ArgumentSchema).max(64).optional(),
      })
      .strict()
      .default({}),
    permissionArgumentPolicy: z.enum(['provider-required', 'optional-disclosure']).optional(),
    output: z.enum(['text', 'json-lines']).default('text'),
  })
  .strict();

export const AgentCapabilitiesSchema = z
  .object({
    interactiveInput: z.boolean(),
    interrupt: z.boolean(),
    terminate: z.boolean(),
    /**
     * True only when the adapter runtime can suspend and continue the same local process on every
     * supported Forgeboard platform. API version 1 intentionally has no such runtime primitive.
     */
    pause: z.literal(false).default(false),
    resume: z.boolean(),
    ansiStreaming: z.boolean(),
    structuredOutput: z.boolean(),
    modelSelection: z.boolean(),
    contextAttachments: z.boolean(),
    permissionModes: z.array(PermissionModeSchema),
  })
  .strict();
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/** Controls that the concrete launched session can truthfully enforce. */
export const AgentSessionCapabilitiesSchema = AgentCapabilitiesSchema.pick({
  interactiveInput: true,
  interrupt: true,
  terminate: true,
  resume: true,
})
  .extend({
    /** True only when the concrete runtime can suspend and continue this exact process tree. */
    pause: z.boolean(),
    source: z.enum(['manifest', 'probe']),
  })
  .strict();
export type AgentSessionCapabilities = z.infer<typeof AgentSessionCapabilitiesSchema>;

export const AgentAdapterManifestSchema = z
  .object({
    schemaVersion: z.literal(AGENT_ADAPTER_API_VERSION),
    id: AgentAdapterIdSchema,
    name: z.string().trim().min(1).max(128),
    provider: z
      .object({
        name: z.string().trim().min(1).max(128),
        website: z.string().url().optional(),
        sendsContextOffDevice: z.boolean(),
        disclosure: z.string().trim().min(1).max(4_096),
      })
      .strict(),
    executable: z
      .object({
        command: ExecutableSchema,
        versionArguments: z.array(ArgumentSchema).max(16).default(['--version']),
        versionPattern: z.string().max(512).optional(),
        detectionTimeoutMs: z.number().int().min(100).max(30_000).default(3_000),
        capabilityProbe: z
          .object({
            arguments: z.array(ArgumentSchema).min(1).max(16).default(['--help']),
            resume: z.array(CapabilityMarkerSchema).min(1).max(16).optional(),
            modelSelection: z.array(CapabilityMarkerSchema).min(1).max(16).optional(),
            permissionModes: z
              .object({
                'plan-read-only': z.array(CapabilityMarkerSchema).min(1).max(16).optional(),
                'worktree-write': z.array(CapabilityMarkerSchema).min(1).max(16).optional(),
                'docker-isolated': z.array(CapabilityMarkerSchema).min(1).max(16).optional(),
                custom: z.array(CapabilityMarkerSchema).min(1).max(16).optional(),
              })
              .strict()
              .default({}),
          })
          .strict()
          .optional(),
      })
      .strict(),
    invocation: InvocationSchema,
    capabilities: AgentCapabilitiesSchema,
    suggestedEnvironmentVariables: z.array(EnvironmentNameSchema).max(128).default([]),
  })
  .strict()
  .superRefine((manifest, context) => {
    const launchArguments = manifest.invocation.launchArguments;
    const resumeArguments = manifest.invocation.resumeArguments;

    if (
      manifest.invocation.promptTransport === 'argument' &&
      !launchArguments.includes('{prompt}')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocation', 'launchArguments'],
        message: 'Argument prompt transport requires a standalone {prompt} argument.',
      });
    }

    if (!launchArguments.includes('{extraArgs}')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocation', 'launchArguments'],
        message: 'Launch arguments require an {extraArgs} expansion slot.',
      });
    }

    if (manifest.capabilities.resume !== (resumeArguments !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', 'resume'],
        message: 'Resume capability must exactly match the presence of resumeArguments.',
      });
    }

    if (resumeArguments !== undefined && !resumeArguments.includes('{sessionId}')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocation', 'resumeArguments'],
        message: 'Resume arguments require a standalone {sessionId} argument.',
      });
    }

    if (resumeArguments !== undefined && !resumeArguments.includes('{extraArgs}')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocation', 'resumeArguments'],
        message: 'Resume arguments require an {extraArgs} expansion slot.',
      });
    }

    if (manifest.capabilities.modelSelection !== manifest.invocation.modelArguments.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', 'modelSelection'],
        message: 'Model selection capability must match modelArguments.',
      });
    }

    if (
      manifest.capabilities.modelSelection &&
      (!launchArguments.includes('{modelArgs}') ||
        (resumeArguments !== undefined && !resumeArguments.includes('{modelArgs}')))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocation'],
        message: 'Model-capable launch and resume arguments require a {modelArgs} slot.',
      });
    }

    if (
      manifest.invocation.context.strategy === 'repeat-arguments' &&
      !manifest.invocation.context.arguments.includes('{contextPath}')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocation', 'context', 'arguments'],
        message: 'Repeated context arguments require a standalone {contextPath} argument.',
      });
    }

    if (
      manifest.invocation.context.strategy === 'repeat-arguments' &&
      (!launchArguments.includes('{contextArgs}') ||
        (resumeArguments !== undefined && !resumeArguments.includes('{contextArgs}')))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocation'],
        message: 'Context argument attachment requires a {contextArgs} expansion slot.',
      });
    }

    if (
      manifest.capabilities.contextAttachments !==
      (manifest.invocation.context.strategy !== 'none')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', 'contextAttachments'],
        message: 'Context capability must match the configured context strategy.',
      });
    }

    const providerPermissionArgumentsRequired =
      manifest.invocation.permissionArgumentPolicy !== 'optional-disclosure';
    if (
      manifest.invocation.permissionArgumentPolicy === 'optional-disclosure' &&
      manifest.id !== 'custom'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocation', 'permissionArgumentPolicy'],
        message:
          "Disclosure-only permission arguments are reserved for Forgeboard's Settings-owned custom adapter.",
      });
    }
    for (const mode of manifest.capabilities.permissionModes) {
      if (
        providerPermissionArgumentsRequired &&
        manifest.invocation.permissionArguments[mode] === undefined &&
        mode !== 'custom'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['invocation', 'permissionArguments', mode],
          message: `Permission mode ${mode} requires explicit provider arguments.`,
        });
      }
    }

    if (
      providerPermissionArgumentsRequired &&
      manifest.capabilities.permissionModes.some((mode) => mode !== 'custom') &&
      (!launchArguments.includes('{permissionArgs}') ||
        (resumeArguments !== undefined && !resumeArguments.includes('{permissionArgs}')))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocation'],
        message: 'Provider permission modes require a {permissionArgs} expansion slot.',
      });
    }
    if (
      Object.values(manifest.invocation.permissionArguments).some(
        (arguments_) => arguments_ !== undefined && arguments_.length > 0,
      ) &&
      (!launchArguments.includes('{permissionArgs}') ||
        (resumeArguments !== undefined && !resumeArguments.includes('{permissionArgs}')))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocation'],
        message: 'Configured permission arguments require a {permissionArgs} expansion slot.',
      });
    }

    if (manifest.executable.versionPattern !== undefined) {
      try {
        new RegExp(manifest.executable.versionPattern, 'u');
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['executable', 'versionPattern'],
          message: 'Version pattern must be a valid regular expression.',
        });
      }
    }
  });
export type AgentAdapterManifest = z.infer<typeof AgentAdapterManifestSchema>;

export const LaunchEnvironmentSchema = z
  .object({
    inherit: z.enum(['none', 'safe', 'all']).default('safe'),
    variables: z.record(EnvironmentNameSchema, z.string().refine(withoutNul)).default({}),
    unset: z.array(EnvironmentNameSchema).max(256).default([]),
  })
  .strict()
  .default({ inherit: 'safe', variables: {}, unset: [] });

export const AgentLaunchRequestSchema = z
  .object({
    prompt: z.string().min(1).max(1_000_000).refine(withoutNul),
    cwd: AbsolutePathSchema,
    permissionProfile: PermissionProfileSchema,
    contextAttachments: z.array(ContextAttachmentSchema).max(256).default([]),
    model: z.string().trim().min(1).max(512).refine(withoutNul).optional(),
    executable: ExecutableSchema.optional(),
    extraArguments: z.array(ArgumentSchema).max(256).default([]),
    environment: LaunchEnvironmentSchema,
  })
  .strict();
export type AgentLaunchRequest = z.input<typeof AgentLaunchRequestSchema>;
export type ParsedAgentLaunchRequest = z.output<typeof AgentLaunchRequestSchema>;

export const AgentResumeRequestSchema = AgentLaunchRequestSchema.extend({
  sessionId: z.string().trim().min(1).max(1_024).refine(withoutNul),
}).strict();
export type AgentResumeRequest = z.input<typeof AgentResumeRequestSchema>;
export type ParsedAgentResumeRequest = z.output<typeof AgentResumeRequestSchema>;

export const LaunchDisclosureSchema = z
  .object({
    adapterId: z.string(),
    provider: z.string(),
    executable: z.string(),
    arguments: z.array(z.string()),
    cwd: z.string(),
    shell: z.literal(false),
    runtime: z.enum(['pty', 'pipes']),
    environmentVariableNames: z.array(z.string()),
    contextAttachments: z.array(ContextAttachmentSchema),
    permissionProfile: PermissionProfileSchema,
    warnings: z.array(z.string()),
  })
  .strict();
export type LaunchDisclosure = z.infer<typeof LaunchDisclosureSchema>;

export const PreparedAgentLaunchSchema = z
  .object({
    apiVersion: z.literal(AGENT_ADAPTER_API_VERSION),
    manifest: AgentAdapterManifestSchema,
    disclosure: LaunchDisclosureSchema,
    environment: z.record(z.string(), z.string()),
    initialStdin: z.string().optional(),
    resumeSessionId: z.string().optional(),
  })
  .strict();
export type PreparedAgentLaunch = z.infer<typeof PreparedAgentLaunchSchema>;

export const AgentDetectionResultSchema = z
  .object({
    adapterId: z.string(),
    executable: z.string(),
    available: z.boolean(),
    version: z.string().optional(),
    rawVersion: z.string().optional(),
    reason: z.string().optional(),
    effectiveCapabilities: AgentCapabilitiesSchema.optional(),
    capabilityWarnings: z.array(z.string()).default([]),
    checkedAt: z.string().datetime(),
  })
  .strict();
export type AgentDetectionResult = z.infer<typeof AgentDetectionResultSchema>;

const EventBaseSchema = z.object({
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
});

export const AgentLifecycleEventSchema = EventBaseSchema.extend({
  type: z.literal('lifecycle'),
  phase: z.enum([
    'starting',
    'running',
    'input-sent',
    'pausing',
    'paused',
    'continuing',
    'interrupting',
    'terminating',
    'exited',
  ]),
  detail: z.string().optional(),
}).strict();

export const AgentStreamEventSchema = EventBaseSchema.extend({
  type: z.literal('stream'),
  channel: z.enum(['stdout', 'stderr', 'pty']),
  data: z.string(),
}).strict();

export const AgentMessageEventSchema = EventBaseSchema.extend({
  type: z.literal('message'),
  channel: z.enum(['stdout', 'stderr', 'pty']),
  payload: z.unknown(),
}).strict();

export const AgentUsageMetadataSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
    cachedInputTokens: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
    outputTokens: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
    totalTokens: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
    costUsd: z.number().finite().nonnegative().max(1_000_000_000).optional(),
  })
  .strict()
  .refine((usage) => Object.keys(usage).length > 0, 'Usage metadata cannot be empty.');
export type AgentUsageMetadata = z.infer<typeof AgentUsageMetadataSchema>;

export const AgentResultMetadataSchema = z
  .object({
    status: z.enum(['succeeded', 'failed', 'interrupted', 'terminated']),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    durationMs: z.number().nonnegative(),
    providerSessionId: z.string().trim().min(1).max(1_024).refine(withoutNul).optional(),
    usage: AgentUsageMetadataSchema.optional(),
  })
  .strict();
export type AgentResultMetadata = z.infer<typeof AgentResultMetadataSchema>;

export const AgentResultEventSchema = EventBaseSchema.extend({
  type: z.literal('result'),
  result: AgentResultMetadataSchema,
}).strict();

export const AgentEventSchema = z.discriminatedUnion('type', [
  AgentLifecycleEventSchema,
  AgentStreamEventSchema,
  AgentMessageEventSchema,
  AgentResultEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export function parseAgentAdapterManifest(value: unknown): AgentAdapterManifest {
  return AgentAdapterManifestSchema.parse(value);
}
