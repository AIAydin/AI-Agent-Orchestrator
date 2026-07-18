import { z } from 'zod';

import { GitIdentityViewSchema } from '../contracts.js';

export const GIT_IDENTITY_IPC_CHANNEL = 'git:identity:check';

const GitIdentityValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !containsControlCharacter(value), {
    message: 'Git identity values cannot contain control characters.',
  });

export const GitIdentityCheckInputSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('settings'),
      name: GitIdentityValueSchema,
      email: GitIdentityValueSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal('git-config'),
      projectId: z.string().uuid(),
    })
    .strict(),
]);
export type GitIdentityCheckInput = z.infer<typeof GitIdentityCheckInputSchema>;

export const GitIdentityCheckResultSchema = z
  .object({
    request: GitIdentityCheckInputSchema,
    identity: GitIdentityViewSchema,
    checkedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.request.source === 'settings') {
      if (
        !result.identity.ready ||
        result.identity.name !== result.request.name ||
        result.identity.email !== result.request.email ||
        result.identity.nameSource !== 'settings' ||
        result.identity.emailSource !== 'settings'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['identity'],
          message: 'Checked Settings identity must match the exact request.',
        });
      }
      return;
    }
    if (
      result.identity.nameSource === 'settings' ||
      result.identity.emailSource === 'settings' ||
      result.identity.ready !==
        (result.identity.nameSource === 'git-config' &&
          result.identity.emailSource === 'git-config')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identity'],
        message: 'Repository Git identity evidence has inconsistent sources.',
      });
    }
  });
export type GitIdentityCheckResult = z.infer<typeof GitIdentityCheckResultSchema>;

export function sameGitIdentityCheckInput(
  left: GitIdentityCheckInput | null,
  right: GitIdentityCheckInput | null,
): boolean {
  if (left === null || right === null || left.source !== right.source) return left === right;
  return left.source === 'settings' && right.source === 'settings'
    ? left.name === right.name && left.email === right.email
    : left.source === 'git-config' &&
        right.source === 'git-config' &&
        left.projectId === right.projectId;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
