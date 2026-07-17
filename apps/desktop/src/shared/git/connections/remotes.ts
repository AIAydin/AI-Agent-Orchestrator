import { z } from 'zod';

import { GitRemoteDescriptorViewSchema } from '../remote/index.js';
import {
  GIT_CONNECTION_MAX_TRACKING_REFS,
  GitConnectionPlanConfirmationInputSchema,
  GitConnectionProjectInputSchema,
  GitConnectionProjectNameSchema,
  GitConnectionRemoteNameSchema,
  GitConnectionRemoteTrackingRefSchema,
  GitConnectionRemoteViewSchema,
  GitConnectionRevisionSchema,
  GitConnectionTimestampSchema,
  GitConnectionUuidSchema,
  validateExactTrackingRefs,
} from './common.js';

export const GitConnectionMutationOperationSchema = z.enum(['add', 'replace', 'remove']);
export type GitConnectionMutationOperation = z.infer<typeof GitConnectionMutationOperationSchema>;

const GitConnectionPrepareBaseFields = {
  projectId: GitConnectionProjectInputSchema.shape.projectId,
  expectedRevision: GitConnectionRevisionSchema,
  remoteName: GitConnectionRemoteNameSchema,
} as const;

export const GitConnectionNetworkUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(isSafeNetworkRemoteUrl, 'Use a credential-free HTTPS or SSH Git remote URL.');
export type GitConnectionNetworkUrl = z.infer<typeof GitConnectionNetworkUrlSchema>;

export const GitConnectionPrepareNetworkInputSchema = z
  .object({
    ...GitConnectionPrepareBaseFields,
    operation: z.enum(['add', 'replace']),
    url: GitConnectionNetworkUrlSchema,
  })
  .strict();
export type GitConnectionPrepareNetworkInput = z.infer<
  typeof GitConnectionPrepareNetworkInputSchema
>;

/** The main process owns the native directory picker; no local path crosses this boundary. */
export const GitConnectionPrepareLocalInputSchema = z
  .object({
    ...GitConnectionPrepareBaseFields,
    operation: z.enum(['add', 'replace']),
  })
  .strict();
export type GitConnectionPrepareLocalInput = z.infer<typeof GitConnectionPrepareLocalInputSchema>;

export const GitConnectionPrepareRemoveInputSchema = z
  .object({
    ...GitConnectionPrepareBaseFields,
    operation: z.literal('remove'),
  })
  .strict();
export type GitConnectionPrepareRemoveInput = z.infer<typeof GitConnectionPrepareRemoveInputSchema>;

export const GitConnectionMutationPlanViewSchema = z
  .object({
    kind: z.literal('git-remote-mutation'),
    planId: GitConnectionUuidSchema,
    expiresAt: GitConnectionTimestampSchema,
    projectId: GitConnectionProjectInputSchema.shape.projectId,
    projectName: GitConnectionProjectNameSchema,
    sourceRevision: GitConnectionRevisionSchema,
    operation: GitConnectionMutationOperationSchema,
    remoteName: GitConnectionRemoteNameSchema,
    before: GitConnectionRemoteViewSchema.nullable(),
    after: GitRemoteDescriptorViewSchema.nullable(),
    remoteTrackingRefs: z
      .array(GitConnectionRemoteTrackingRefSchema)
      .max(GIT_CONNECTION_MAX_TRACKING_REFS),
    networkAccess: z.literal(false),
  })
  .strict()
  .superRefine((plan, context) => {
    const shapeMatches =
      (plan.operation === 'add' && plan.before === null && plan.after !== null) ||
      (plan.operation === 'replace' && plan.before !== null && plan.after !== null) ||
      (plan.operation === 'remove' && plan.before !== null && plan.after === null);
    if (!shapeMatches) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Remote mutation before/after disclosures do not match the operation.',
      });
    }
    if (plan.before !== null && plan.before.name !== plan.remoteName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['before', 'name'],
        message: 'The previous remote disclosure must match the selected remote.',
      });
    }
    if (plan.after !== null && plan.after.name !== plan.remoteName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['after', 'name'],
        message: 'The replacement remote disclosure must match the selected remote.',
      });
    }
    if (plan.operation !== 'remove' && plan.remoteTrackingRefs.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remoteTrackingRefs'],
        message: 'Only remote removal can delete remote-tracking references.',
      });
    }
    validateExactTrackingRefs(plan.remoteName, plan.remoteTrackingRefs, context);
  });
export type GitConnectionMutationPlanView = z.infer<typeof GitConnectionMutationPlanViewSchema>;

export const GitConnectionConfirmInputSchema = GitConnectionPlanConfirmationInputSchema;
export type GitConnectionConfirmInput = z.infer<typeof GitConnectionConfirmInputSchema>;

function isSafeNetworkRemoteUrl(value: string): boolean {
  if (
    value.trim() !== value ||
    value.includes('%') ||
    new TextEncoder().encode(value).byteLength > 2_048 ||
    !isWellFormedUnicode(value) ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 32 || code === 127;
    })
  ) {
    return false;
  }
  if (!value.includes('://')) return isSafeScpRemote(value);
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') ||
      parsed.hostname === '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      (parsed.protocol === 'https:' && parsed.username !== '') ||
      (parsed.protocol === 'ssh:' && parsed.username !== '' && parsed.username !== 'git')
    ) {
      return false;
    }
    return safeRepositoryResource(parsed.pathname.replace(/^\/+|\/+$/gu, ''));
  } catch {
    return false;
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (trailing < 0xdc00 || trailing > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isSafeScpRemote(value: string): boolean {
  const match = /^(?:(git)@)?([A-Za-z0-9.-]+):(.+)$/u.exec(value);
  if (match === null || !safeDnsHost(match[2] ?? '')) return false;
  return safeRepositoryResource(match[3] ?? '');
}

function safeDnsHost(value: string): boolean {
  return (
    value.length <= 253 &&
    value
      .toLowerCase()
      .split('.')
      .every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
      )
  );
}

function safeRepositoryResource(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 2_048 &&
    !value.startsWith(':') &&
    !/[\\%@?#]/u.test(value) &&
    value
      .replace(/\.git$/u, '')
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}
