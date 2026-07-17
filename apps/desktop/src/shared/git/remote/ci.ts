import { z } from 'zod';

import {
  GitHubOwnerRepositorySchema,
  GitRemoteBranchSchema,
  GitRemoteDeliveryTargetInputSchema,
  GitRemoteDescriptorViewSchema,
  GitRemoteNameSchema,
  GitRemoteOidSchema,
  GitRemoteTimestampSchema,
  GitRemoteUuidSchema,
  GitRemoteWebUrlSchema,
} from './common.js';

export const GitHubCiPrepareInputSchema = z
  .object({
    target: GitRemoteDeliveryTargetInputSchema,
    remote: GitRemoteNameSchema,
    destinationBranch: GitRemoteBranchSchema,
    baseBranch: GitRemoteBranchSchema,
  })
  .strict();
export type GitHubCiPrepareInput = z.infer<typeof GitHubCiPrepareInputSchema>;

export const GitHubCiPlanViewSchema = z
  .object({
    kind: z.literal('github-ci'),
    planId: GitRemoteUuidSchema,
    expiresAt: GitRemoteTimestampSchema,
    target: GitRemoteDeliveryTargetInputSchema,
    remote: GitRemoteDescriptorViewSchema,
    ownerRepository: GitHubOwnerRepositorySchema,
    baseBranch: GitRemoteBranchSchema,
    headBranch: GitRemoteBranchSchema,
    sourceHead: GitRemoteOidSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (!plan.remote.githubCompatible) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remote', 'githubCompatible'],
        message: 'CI status requires a GitHub-compatible remote.',
      });
    }
  });
export type GitHubCiPlanView = z.infer<typeof GitHubCiPlanViewSchema>;

export const GitHubCiRunViewSchema = z
  .object({
    databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z.string().trim().min(1).max(512),
    workflowName: z.string().trim().min(1).max(512),
    status: z.string().trim().min(1).max(64),
    conclusion: z.string().trim().min(1).max(64).nullable(),
    url: GitRemoteWebUrlSchema,
    headBranch: GitRemoteBranchSchema,
    headSha: GitRemoteOidSchema,
  })
  .strict();
export type GitHubCiRunView = z.infer<typeof GitHubCiRunViewSchema>;

export const GitHubCiResultViewSchema = z
  .object({
    sourceHead: GitRemoteOidSchema,
    headBranch: GitRemoteBranchSchema,
    current: z.literal(true),
    runs: z.array(GitHubCiRunViewSchema).max(20),
    checkedAt: GitRemoteTimestampSchema,
  })
  .strict()
  .superRefine((result, context) => {
    for (const [index, run] of result.runs.entries()) {
      if (run.headSha !== result.sourceHead || run.headBranch !== result.headBranch) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runs', index],
          message: 'Every CI result must match the exact current delivery head and branch.',
        });
      }
      const runUrl = new URL(run.url);
      if (!runUrl.pathname.endsWith(`/actions/runs/${String(run.databaseId)}`)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runs', index, 'url'],
          message: 'CI run URLs must identify the disclosed GitHub run.',
        });
      }
    }
  });
export type GitHubCiResultView = z.infer<typeof GitHubCiResultViewSchema>;
