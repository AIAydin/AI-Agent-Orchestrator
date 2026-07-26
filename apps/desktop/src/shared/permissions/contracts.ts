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
  'project-write',
  'docker-isolated',
  // Legacy: no longer offered in any select, kept so saved canvases/settings still parse.
  'custom',
]);
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

const RelativePermissionRootSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value === value.trim(), 'Folder paths cannot start or end with a space.')
  .refine(hasNoControlCharacters, 'Folder paths cannot contain non-printing characters.')
  .refine((value) => !value.includes('\\'), 'Use forward slashes (/) in folder paths.')
  .refine(
    (value) => value === '.' || (!value.startsWith('/') && !/^[A-Za-z]:\//u.test(value)),
    "List folders inside the agent's worktree, not full paths from this computer.",
  )
  .refine(
    (value) =>
      value === '.' ||
      (value !== '..' &&
        !value.startsWith('../') &&
        !value.endsWith('/') &&
        !value.includes('//') &&
        value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')),
    'Folder paths must stay inside the assigned worktree. Remove any "." or ".." parts.',
  );

const PermissionRootListSchema = z
  .array(RelativePermissionRootSchema)
  .max(256)
  .superRefine((roots, context) => {
    if (new Set(roots).size !== roots.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each folder can appear only once.',
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
        message:
          "Only the selected agent's program can start it. Remove the extra programs from the list.",
      });
    }
    if (profile.executablePolicy === 'allowlist' && profile.allowedExecutables.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedExecutables'],
        message: 'Add at least one program by its full path.',
      });
    }
    if (new Set(profile.allowedExecutables).size !== profile.allowedExecutables.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedExecutables'],
        message: 'Each program can appear only once.',
      });
    }
    if (profile.filesystem === 'assigned-worktree-read-only') {
      if (profile.readPaths.length !== 1 || profile.readPaths[0] !== '.') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['readPaths'],
          message:
            'Read-only access always covers the whole assigned worktree. To narrow it, switch File access to specific folders.',
        });
      }
      if (profile.writePaths.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['writePaths'],
          message: 'Read-only access cannot include folders the agent can change.',
        });
      }
    }
    if (profile.filesystem === 'assigned-worktree-write') {
      if (profile.readPaths.length !== 1 || profile.readPaths[0] !== '.') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['readPaths'],
          message: 'With read-and-write access, the agent reads the whole assigned worktree.',
        });
      }
      if (profile.writePaths.length !== 1 || profile.writePaths[0] !== '.') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['writePaths'],
          message: 'With read-and-write access, the agent can change the whole assigned worktree.',
        });
      }
    }
    if (profile.filesystem === 'explicit-paths' && profile.readPaths.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readPaths'],
        message: 'Add at least one folder the agent can read.',
      });
    }
    profile.writePaths.forEach((writeRoot, index) => {
      if (!profile.readPaths.some((readRoot) => rootContains(readRoot, writeRoot))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['writePaths', index],
          message: 'Every folder the agent can change must also be a folder it can read.',
        });
      }
    });
    if (profile.runtime === 'docker' && profile.filesystem === 'explicit-paths') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filesystem'],
        message:
          'A Custom profile that runs in Docker can only give read-only or read-and-write access to the whole assigned worktree.',
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
          'Docker always gives the agent the whole worktree, so ignored and sensitive files in it cannot be hidden. Allow both, or run the agent on this computer instead.',
      });
    }
  });
export type CustomPermissionProfileSettings = z.infer<typeof CustomPermissionProfileSettingsSchema>;
