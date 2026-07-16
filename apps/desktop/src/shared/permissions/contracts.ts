import { z } from 'zod';

import { MachineSpecificPathSchema } from '../settings/values.js';

function hasNoControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 31 && code !== 127;
  });
}

export const PermissionProfileSchema = z.enum([
  'plan-read-only',
  'worktree-write',
  'docker-isolated',
  'custom',
]);
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

const RelativePermissionRootSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => value === value.trim(),
    'Permission roots cannot start or end with whitespace.',
  )
  .refine(hasNoControlCharacters, 'Permission roots cannot contain control characters.')
  .refine((value) => !value.includes('\\'), 'Use forward slashes in permission roots.')
  .refine(
    (value) => value === '.' || (!value.startsWith('/') && !/^[A-Za-z]:\//u.test(value)),
    'Permission roots must be relative to the assigned project or worktree.',
  )
  .refine(
    (value) =>
      value === '.' ||
      (value !== '..' &&
        !value.startsWith('../') &&
        !value.endsWith('/') &&
        !value.includes('//') &&
        value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')),
    'Permission roots must be normalized and cannot traverse outside the assigned root.',
  );

const PermissionRootListSchema = z
  .array(RelativePermissionRootSchema)
  .max(256)
  .superRefine((roots, context) => {
    if (new Set(roots).size !== roots.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Permission roots must be unique.',
      });
    }
  });

const LaunchExecutableSchema = MachineSpecificPathSchema;

function rootContains(parent: string, candidate: string): boolean {
  return parent === '.' || candidate === parent || candidate.startsWith(`${parent}/`);
}

/**
 * UI-owned policy for the single Custom profile.
 *
 * Host roots and child-process controls are disclosure policy, not an operating-system sandbox.
 * Docker can enforce only a whole assigned-worktree bind, its access mode, network, and resources.
 */
export const CustomPermissionProfileSettingsSchema = z
  .object({
    runtime: z.enum(['host', 'docker']).default('host'),
    filesystem: z
      .enum(['assigned-worktree-read-only', 'assigned-worktree-write', 'explicit-paths'])
      .default('assigned-worktree-read-only'),
    readPaths: PermissionRootListSchema.default(['.']),
    writePaths: PermissionRootListSchema.default([]),
    ignoredFileRead: z.enum(['deny', 'allow']).default('deny'),
    sensitiveFileRead: z.enum(['deny', 'allow']).default('deny'),
    executablePolicy: z.enum(['selected-agent-only', 'allowlist']).default('selected-agent-only'),
    allowedExecutables: z.array(LaunchExecutableSchema).max(256).default([]),
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
      profile.executablePolicy === 'selected-agent-only' &&
      profile.allowedExecutables.length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedExecutables'],
        message: 'Clear the launch allowlist when only the selected agent executable is allowed.',
      });
    }
    if (profile.executablePolicy === 'allowlist' && profile.allowedExecutables.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedExecutables'],
        message: 'Add at least one exact executable before enabling the launch allowlist.',
      });
    }
    if (new Set(profile.allowedExecutables).size !== profile.allowedExecutables.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedExecutables'],
        message: 'Launch allowlist entries must be unique.',
      });
    }
    if (profile.filesystem === 'assigned-worktree-read-only') {
      if (profile.readPaths.length !== 1 || profile.readPaths[0] !== '.') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['readPaths'],
          message: 'The read-only preset reads the assigned root. Use explicit paths to narrow it.',
        });
      }
      if (profile.writePaths.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['writePaths'],
          message: 'The read-only preset cannot declare writable roots.',
        });
      }
    }
    if (profile.filesystem === 'assigned-worktree-write') {
      if (profile.readPaths.length !== 1 || profile.readPaths[0] !== '.') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['readPaths'],
          message: 'The worktree-write preset reads the whole assigned worktree.',
        });
      }
      if (profile.writePaths.length !== 1 || profile.writePaths[0] !== '.') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['writePaths'],
          message: 'The worktree-write preset writes the whole assigned worktree.',
        });
      }
    }
    if (profile.filesystem === 'explicit-paths' && profile.readPaths.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readPaths'],
        message: 'An explicit-path policy needs at least one readable root.',
      });
    }
    profile.writePaths.forEach((writeRoot, index) => {
      if (!profile.readPaths.some((readRoot) => rootContains(readRoot, writeRoot))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['writePaths', index],
          message: 'Every writable root must also be covered by a readable root.',
        });
      }
    });
    if (profile.runtime === 'docker' && profile.filesystem === 'explicit-paths') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filesystem'],
        message:
          'Docker Custom profiles support only a whole assigned-worktree read-only or read-write bind.',
      });
    }
    if (
      profile.runtime === 'docker' &&
      (profile.ignoredFileRead === 'deny' || profile.sensitiveFileRead === 'deny')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [profile.ignoredFileRead === 'deny' ? 'ignoredFileRead' : 'sensitiveFileRead'],
        message:
          'A whole-worktree Docker bind cannot hide ignored or sensitive files. Explicitly allow both or use a host disclosure-only profile.',
      });
    }
  });
export type CustomPermissionProfileSettings = z.infer<typeof CustomPermissionProfileSettingsSchema>;
