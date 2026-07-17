import { z } from 'zod';

import {
  GitRemoteDescriptorViewSchema,
  GitRemoteDisplayNameSchema,
  GitRemoteNameSchema,
  GitRemoteRefSchema,
  GitRemoteSha256Schema,
  GitRemoteTimestampSchema,
  GitRemoteUuidSchema,
} from '../remote/index.js';

export const GIT_CONNECTION_MAX_REMOTES = 32;
export const GIT_CONNECTION_MAX_TRACKING_REFS = 256;
export const GIT_CONNECTION_MAX_TRACKING_REF_CHARACTERS = 64 * 1_024;

export {
  GitRemoteSha256Schema as GitConnectionSha256Schema,
  GitRemoteTimestampSchema as GitConnectionTimestampSchema,
  GitRemoteUuidSchema as GitConnectionUuidSchema,
};

/** Creation/mutation identity; existing unsupported names remain visible but read-only. */
export const GitConnectionRemoteNameSchema = GitRemoteNameSchema.refine(
  (value) =>
    !value.endsWith('.') && !value.toLowerCase().endsWith('.lock') && !value.includes('..'),
  'Git remote names must be portable and unambiguous.',
);

export const GitConnectionProjectInputSchema = z
  .object({ projectId: GitRemoteUuidSchema })
  .strict();
export type GitConnectionProjectInput = z.infer<typeof GitConnectionProjectInputSchema>;

export const GitConnectionRevisionSchema = GitRemoteSha256Schema;

export const GitConnectionManagementSchema = z.enum([
  'managed-simple',
  'managed-complex',
  'effective-only',
]);
export type GitConnectionManagement = z.infer<typeof GitConnectionManagementSchema>;

export const GitConnectionProjectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(withoutControlCharacters, 'Display text cannot contain control characters.');

export const GitConnectionRemoteViewSchema = z
  .object({
    name: GitRemoteDisplayNameSchema,
    fetch: GitRemoteDescriptorViewSchema.nullable(),
    push: GitRemoteDescriptorViewSchema.nullable(),
    management: GitConnectionManagementSchema,
    warning: GitConnectionProjectNameSchema.nullable(),
  })
  .strict()
  .superRefine((remote, context) => {
    for (const [field, descriptor] of [
      ['fetch', remote.fetch],
      ['push', remote.push],
    ] as const) {
      if (descriptor !== null && descriptor.name !== remote.name) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, 'name'],
          message: 'Remote descriptors must match the disclosed remote name.',
        });
      }
    }
    if (remote.fetch === null && remote.push === null && remote.management !== 'effective-only') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['management'],
        message: 'A repository-managed remote must expose a safe fetch or push descriptor.',
      });
    }
    if (remote.management === 'managed-simple' && remote.warning !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warning'],
        message: 'A simple managed remote cannot carry a complexity warning.',
      });
    }
    if (remote.management !== 'managed-simple' && remote.warning === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warning'],
        message: 'A remote that cannot be replaced must explain why.',
      });
    }
  });
export type GitConnectionRemoteView = z.infer<typeof GitConnectionRemoteViewSchema>;

export const GitConnectionsViewSchema = z
  .object({
    projectId: GitRemoteUuidSchema,
    projectName: GitConnectionProjectNameSchema,
    configurationRevision: GitConnectionRevisionSchema,
    remotes: z.array(GitConnectionRemoteViewSchema).max(GIT_CONNECTION_MAX_REMOTES),
    capturedAt: GitRemoteTimestampSchema,
  })
  .strict()
  .superRefine((view, context) => {
    if (new Set(view.remotes.map((remote) => remote.name)).size !== view.remotes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remotes'],
        message: 'Git connection names must be unique.',
      });
    }
  });
export type GitConnectionsView = z.infer<typeof GitConnectionsViewSchema>;

export const GitConnectionPlanConfirmationInputSchema = z
  .object({ planId: GitRemoteUuidSchema })
  .strict();
export type GitConnectionPlanConfirmationInput = z.infer<
  typeof GitConnectionPlanConfirmationInputSchema
>;

export const GitConnectionPlanCancelResultSchema = z
  .object({ acknowledged: z.literal(true) })
  .strict();
export type GitConnectionPlanCancelResult = z.infer<typeof GitConnectionPlanCancelResultSchema>;

export const GitConnectionRemoteTrackingRefSchema = GitRemoteRefSchema.refine(
  (value) => value.startsWith('refs/remotes/'),
  'Remote-tracking references must remain under refs/remotes/.',
);

export function validateExactTrackingRefs(
  remoteName: string,
  refs: readonly string[],
  context: z.RefinementCtx,
): void {
  if (new Set(refs).size !== refs.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['remoteTrackingRefs'],
      message: 'Remote-tracking references must be unique.',
    });
  }
  const prefix = `refs/remotes/${remoteName}/`;
  for (const [index, ref] of refs.entries()) {
    if (!ref.startsWith(prefix)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remoteTrackingRefs', index],
        message: 'Remote-tracking references must belong to the selected remote.',
      });
    }
  }
  if (
    refs.reduce((total, ref) => total + ref.length, 0) > GIT_CONNECTION_MAX_TRACKING_REF_CHARACTERS
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['remoteTrackingRefs'],
      message: 'Remote-tracking reference disclosure is too large.',
    });
  }
}

function withoutControlCharacters(value: string): boolean {
  return ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
