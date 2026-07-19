import { z } from 'zod';

import {
  GitIdentityViewSchema,
  GitReviewTargetViewSchema,
  GitReviewViewSchema,
  GitTargetInputSchema,
} from './contracts.js';
import { GitDeliveryReadinessViewSchema } from './readiness/index.js';

const OidSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const MAX_DISCLOSED_PATH_CHARACTERS = 64 * 1_024;
const GitPathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes('\0'), 'Git paths cannot contain NUL bytes.');

export const GitShippingStrategySchema = z.enum([
  'fast-forward-only',
  'merge-commit',
  'squash',
  'rebase',
  'cherry-pick',
]);
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
    readinessApprovalId: z.string().uuid(),
    readiness: GitDeliveryReadinessViewSchema,
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
    const exactHumanApproval = plan.readiness.approvals.find(
      (approval) =>
        approval.approvalId === plan.readinessApprovalId &&
        approval.authority === 'human' &&
        approval.evidenceFingerprint === plan.readiness.evidenceFingerprint &&
        approval.sourceFingerprint.digest === plan.readiness.sourceFingerprint.digest,
    );
    if (
      !plan.readiness.evaluation.ready ||
      exactHumanApproval === undefined ||
      plan.readiness.target.projectId !== plan.projectId ||
      plan.readiness.target.runId !== plan.runId ||
      plan.readiness.sourceFingerprint.worktreeId !== plan.worktreeId ||
      plan.readiness.sourceFingerprint.sourceHead !== plan.sourceHead
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readiness'],
        message:
          'Git delivery plans require exact passing checks and current human approval for their source.',
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
    conflictTarget: GitTargetInputSchema.nullable(),
    review: GitReviewViewSchema,
  })
  .strict();
export type GitShippingResultView = z.infer<typeof GitShippingResultViewSchema>;

export const GitConflictRecoveryActionSchema = z.enum(['continue', 'abort']);
export type GitConflictRecoveryAction = z.infer<typeof GitConflictRecoveryActionSchema>;

export const GitConflictRecoveryPrepareInputSchema = z
  .object({
    target: GitTargetInputSchema,
    action: GitConflictRecoveryActionSchema,
  })
  .strict();
export type GitConflictRecoveryPrepareInput = z.infer<typeof GitConflictRecoveryPrepareInputSchema>;

export const GitConflictRecoveryStateViewSchema = z
  .object({
    target: GitTargetInputSchema,
    operation: z.enum(['merge', 'rebase', 'cherry-pick', 'squash']),
    conflictedPaths: z.array(GitPathSchema).max(256),
    stagedPaths: z.array(GitPathSchema).max(256),
    canContinue: z.boolean(),
    canAbort: z.boolean(),
  })
  .strict();
export type GitConflictRecoveryStateView = z.infer<typeof GitConflictRecoveryStateViewSchema>;

export const GitConflictRecoveryPlanViewSchema = z
  .object({
    planId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    target: GitReviewTargetViewSchema,
    action: GitConflictRecoveryActionSchema,
    operation: z.enum(['merge', 'rebase', 'cherry-pick', 'squash']),
    expectedHead: z.union([OidSchema, z.literal('UNBORN')]),
    conflictedPaths: z.array(GitPathSchema).max(256),
    stagedPaths: z.array(GitPathSchema).max(256),
    stagedPatchSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    unstagedPatchSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    canContinue: z.boolean(),
  })
  .strict();
export type GitConflictRecoveryPlanView = z.infer<typeof GitConflictRecoveryPlanViewSchema>;

export const GitConflictRecoveryResultViewSchema = z
  .object({
    state: z.enum(['completed', 'conflicted']),
    conflictedPaths: z.array(GitPathSchema).max(256),
    review: GitReviewViewSchema,
  })
  .strict();
export type GitConflictRecoveryResultView = z.infer<typeof GitConflictRecoveryResultViewSchema>;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
