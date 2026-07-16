import { z } from 'zod';

const MAX_MACHINE_VALUE_BYTES = 32_768;

const LegacyCommandArgumentSchema = z
  .string()
  .max(MAX_MACHINE_VALUE_BYTES)
  .refine(
    (value) =>
      !value.includes('\0') &&
      new TextEncoder().encode(value).byteLength <= MAX_MACHINE_VALUE_BYTES,
  );

export const LegacyCommandConfigurationSchema = z
  .object({
    executable: LegacyCommandArgumentSchema.refine((value) => !/[\r\n]/u.test(value)).default(''),
    arguments: z.array(LegacyCommandArgumentSchema).max(512).default([]),
  })
  .strict();

export const LegacyAgentExecutableOverridesSchema = z
  .record(z.string(), z.string().max(MAX_MACHINE_VALUE_BYTES))
  .default({});

const LegacyCustomAgentArgumentSchema = z
  .string()
  .max(MAX_MACHINE_VALUE_BYTES)
  .refine((value) => !value.includes('\0'))
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
  );

export const LegacyCustomAgentConfigurationSchema = z
  .object({
    enabled: z.boolean().default(false),
    name: z.string().trim().min(1).max(128).default('Custom CLI'),
    providerName: z.string().trim().min(1).max(128).default('Custom provider'),
    providerDisclosure: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .default(
        'This user-configured CLI may send the prompt and selected context to its configured provider.',
      ),
    sendsContextOffDevice: z.boolean().default(true),
    executable: z
      .string()
      .max(MAX_MACHINE_VALUE_BYTES)
      .refine((value) => !value.includes('\0') && !/[\r\n]/u.test(value))
      .default(''),
    versionArguments: z
      .array(LegacyCustomAgentArgumentSchema)
      .min(1)
      .max(16)
      .default(['--version']),
    launchArguments: z.array(LegacyCustomAgentArgumentSchema).max(256).default([]),
    promptTransport: z.enum(['argument', 'stdin']).default('argument'),
    runtime: z.enum(['pty', 'pipes']).default('pty'),
    output: z.enum(['text', 'json-lines']).default('text'),
  })
  .strict();

const LegacyPermissionRootSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes('\0'))
  .refine((value) => !value.includes('\\'))
  .refine((value) => value === '.' || (!value.startsWith('/') && !/^[A-Za-z]:\//u.test(value)))
  .refine(
    (value) =>
      value === '.' ||
      (value !== '..' &&
        !value.startsWith('../') &&
        !value.endsWith('/') &&
        !value.includes('//') &&
        value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')),
  );

const LegacyPermissionRootListSchema = z
  .array(LegacyPermissionRootSchema)
  .max(256)
  .refine((roots) => new Set(roots).size === roots.length);

const LegacyLaunchExecutableSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MACHINE_VALUE_BYTES)
  .refine((value) => !value.includes('\0') && !/[\r\n]/u.test(value))
  .refine(
    (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\'),
  );

function rootContains(parent: string, candidate: string): boolean {
  return parent === '.' || candidate === parent || candidate.startsWith(`${parent}/`);
}

export const LegacyCustomPermissionProfileSchema = z
  .object({
    runtime: z.enum(['host', 'docker']).default('host'),
    filesystem: z
      .enum(['assigned-worktree-read-only', 'assigned-worktree-write', 'explicit-paths'])
      .default('assigned-worktree-read-only'),
    readPaths: LegacyPermissionRootListSchema.default(['.']),
    writePaths: LegacyPermissionRootListSchema.default([]),
    ignoredFileRead: z.enum(['deny', 'allow']).default('deny'),
    sensitiveFileRead: z.enum(['deny', 'allow']).default('deny'),
    executablePolicy: z.enum(['selected-agent-only', 'allowlist']).default('selected-agent-only'),
    allowedExecutables: z.array(LegacyLaunchExecutableSchema).max(256).default([]),
    forgeboardManagedActions: z
      .object({
        developmentServers: z.enum(['deny', 'allow']).default('deny'),
        tests: z.enum(['deny', 'allow']).default('deny'),
      })
      .strict()
      .default({}),
    requireReviewBeforePrimary: z.literal(true).default(true),
    docker: z
      .object({
        network: z.enum(['disabled', 'enabled']).default('disabled'),
        cpuLimit: z.number().finite().min(0.1).max(128).default(2),
        memoryMb: z.number().int().min(128).max(1_048_576).default(4_096),
        mountHostCredentials: z.literal(false).default(false),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      (profile.executablePolicy === 'selected-agent-only' &&
        profile.allowedExecutables.length > 0) ||
      (profile.executablePolicy === 'allowlist' && profile.allowedExecutables.length === 0) ||
      new Set(profile.allowedExecutables).size !== profile.allowedExecutables.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedExecutables'],
        message: 'invalid',
      });
    }
    if (
      profile.filesystem === 'assigned-worktree-read-only' &&
      (profile.readPaths.length !== 1 ||
        profile.readPaths[0] !== '.' ||
        profile.writePaths.length > 0)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['filesystem'], message: 'invalid' });
    }
    if (
      profile.filesystem === 'assigned-worktree-write' &&
      (profile.readPaths.length !== 1 ||
        profile.readPaths[0] !== '.' ||
        profile.writePaths.length !== 1 ||
        profile.writePaths[0] !== '.')
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['filesystem'], message: 'invalid' });
    }
    if (profile.filesystem === 'explicit-paths' && profile.readPaths.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['readPaths'], message: 'invalid' });
    }
    if (
      profile.writePaths.some(
        (writeRoot) => !profile.readPaths.some((readRoot) => rootContains(readRoot, writeRoot)),
      )
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['writePaths'], message: 'invalid' });
    }
    if (
      profile.runtime === 'docker' &&
      (profile.filesystem === 'explicit-paths' ||
        profile.ignoredFileRead === 'deny' ||
        profile.sensitiveFileRead === 'deny')
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['runtime'], message: 'invalid' });
    }
  });

export const LegacyPreviewTrustedHostsSchema = z
  .array(z.string().min(1).max(512))
  .default(['127.0.0.1', 'localhost']);

const safeSingleLine = (value: string): boolean => !value.includes('\0') && !/[\r\n]/u.test(value);

export const LegacyDockerExecutableSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MACHINE_VALUE_BYTES)
  .refine(safeSingleLine);

export const LegacyDockerContainerExecutableSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(safeSingleLine)
  .refine((value) => value.startsWith('/'))
  .refine((value) =>
    value
      .split('/')
      .slice(1)
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  );

export const LegacyBackupDirectorySchema = z.string().max(MAX_MACHINE_VALUE_BYTES).default('');
export const LegacyWorktreeRootSchema = z.string();
export const LegacyTerminalShellSchema = z.string();

export const LegacyCustomChecksSchema = z
  .array(
    z
      .object({
        id: z.string().uuid(),
        label: z.string().trim().min(1).max(128),
        command: LegacyCommandConfigurationSchema,
      })
      .strict(),
  )
  .max(32)
  .refine((checks) => new Set(checks.map((check) => check.id)).size === checks.length);
