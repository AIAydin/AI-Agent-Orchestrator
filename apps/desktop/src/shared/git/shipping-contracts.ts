import { z } from 'zod';

import { GitIdentityViewSchema, GitReviewViewSchema, GitTargetInputSchema } from './contracts.js';

const OidSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const MAX_DISCLOSED_PATH_CHARACTERS = 64 * 1_024;
const GitPathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes('\0'), 'Git paths cannot contain NUL bytes.');

export const GitShippingStrategySchema = z.enum(['fast-forward-only', 'cherry-pick']);
export type GitShippingStrategy = z.infer<typeof GitShippingStrategySchema>;

export const GitShippingPlanInputSchema = z
  .object({
    target: GitTargetInputSchema,
    strategy: GitShippingStrategySchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.target.kind !== 'agent-worktree') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target', 'kind'],
        message: 'Only a managed agent worktree can be delivered to the primary checkout.',
      });
    }
  });
export type GitShippingPlanInput = z.infer<typeof GitShippingPlanInputSchema>;

export const GitShippingPlanViewSchema = z
  .object({
    kind: z.literal('ship-agent-commits'),
    planId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    strategy: GitShippingStrategySchema,
    projectId: z.string().uuid(),
    runId: z.string().uuid(),
    worktreeId: z.string().uuid(),
    projectName: z.string().min(1).max(512),
    sourceBranch: z.string().min(1).max(4_096),
    targetBranch: z.string().min(1).max(4_096),
    baseRef: z.string().min(1).max(4_096),
    baseCommit: OidSchema,
    sourceHead: OidSchema,
    targetHead: OidSchema,
    commits: z.array(OidSchema).min(1).max(256),
    affectedPaths: z.array(GitPathSchema).min(1).max(256),
    identity: GitIdentityViewSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    const invalidIdentity =
      !plan.identity.ready ||
      plan.identity.name.trim() === '' ||
      plan.identity.email.trim() === '' ||
      plan.identity.nameSource === 'missing' ||
      plan.identity.emailSource === 'missing' ||
      containsControlCharacter(plan.identity.name) ||
      containsControlCharacter(plan.identity.email);
    if (invalidIdentity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identity'],
        message: 'Git delivery plans require an exact, ready, control-free Git identity.',
      });
    }
    const pathCharacters = plan.affectedPaths.reduce((total, path) => total + path.length, 0);
    if (pathCharacters > MAX_DISCLOSED_PATH_CHARACTERS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['affectedPaths'],
        message: `Git delivery disclosure exceeds ${String(MAX_DISCLOSED_PATH_CHARACTERS)} path characters.`,
      });
    }
  });
export type GitShippingPlanView = z.infer<typeof GitShippingPlanViewSchema>;

export const GitShippingResultViewSchema = z
  .object({
    state: z.enum(['completed', 'conflicted']),
    strategy: GitShippingStrategySchema,
    headBefore: OidSchema,
    headAfter: OidSchema,
    conflictedPaths: z.array(GitPathSchema).max(256),
    review: GitReviewViewSchema,
  })
  .strict();
export type GitShippingResultView = z.infer<typeof GitShippingResultViewSchema>;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
