import { z } from 'zod';

import {
  GitDeliveryReadinessViewSchema,
  GitHubOwnerRepositorySchema,
  GitRemoteBranchSchema,
  GitRemoteDeliveryTargetInputSchema,
  GitRemoteDescriptorViewSchema,
  GitRemoteExactChangesFields,
  GitRemoteNameSchema,
  GitRemoteOidSchema,
  GitRemoteSha256Schema,
  GitRemoteTimestampSchema,
  GitRemoteUuidSchema,
  GitRemoteWebUrlSchema,
  validateExactChangesView,
  validateReadyDeliveryEvidence,
} from './common.js';

export const GITHUB_PULL_REQUEST_BODY_MAX_CHARACTERS = 32_768;

const PullRequestTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'), 'Pull request titles cannot contain NUL bytes.')
  .refine(isWellFormedUnicode, 'Pull request titles must contain valid Unicode text.');

const PullRequestBodySchema = z
  .string()
  .max(GITHUB_PULL_REQUEST_BODY_MAX_CHARACTERS)
  .refine((value) => !value.includes('\0'), 'Pull request bodies cannot contain NUL bytes.')
  .refine(isWellFormedUnicode, 'Pull request bodies must contain valid Unicode text.');

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export const GitHubPullRequestPrepareInputSchema = z
  .object({
    target: GitRemoteDeliveryTargetInputSchema,
    remote: GitRemoteNameSchema,
    destinationBranch: GitRemoteBranchSchema,
    baseBranch: GitRemoteBranchSchema,
    title: PullRequestTitleSchema,
    body: PullRequestBodySchema,
    draft: z.boolean(),
  })
  .strict();
export type GitHubPullRequestPrepareInput = z.infer<typeof GitHubPullRequestPrepareInputSchema>;

export const GitHubPullRequestPlanViewSchema = z
  .object({
    kind: z.literal('github-pull-request'),
    planId: GitRemoteUuidSchema,
    expiresAt: GitRemoteTimestampSchema,
    target: GitRemoteDeliveryTargetInputSchema,
    projectName: z.string().trim().min(1).max(512),
    remote: GitRemoteDescriptorViewSchema,
    ownerRepository: GitHubOwnerRepositorySchema,
    baseBranch: GitRemoteBranchSchema,
    headBranch: GitRemoteBranchSchema,
    baseOid: GitRemoteOidSchema,
    headOid: GitRemoteOidSchema,
    sourceHead: GitRemoteOidSchema,
    ...GitRemoteExactChangesFields,
    title: PullRequestTitleSchema,
    bodySha256: GitRemoteSha256Schema,
    bodyCharacterCount: z.number().int().nonnegative().max(GITHUB_PULL_REQUEST_BODY_MAX_CHARACTERS),
    draft: z.boolean(),
    readiness: GitDeliveryReadinessViewSchema,
    readinessApprovalId: GitRemoteUuidSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (!plan.remote.githubCompatible) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remote', 'githubCompatible'],
        message: 'Pull request creation requires a GitHub-compatible remote.',
      });
    }
    if (plan.headOid !== plan.sourceHead) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headOid'],
        message: 'Pull request head must match the exact selected delivery source.',
      });
    }
    validateExactChangesView(
      {
        commitCount: plan.commitCount,
        commits: plan.commits,
        fileCount: plan.fileCount,
        files: plan.files,
        additions: plan.additions,
        deletions: plan.deletions,
      },
      context,
    );
    validateReadyDeliveryEvidence(
      plan.target,
      plan.sourceHead,
      plan.readiness,
      plan.readinessApprovalId,
      context,
    );
  });
export type GitHubPullRequestPlanView = z.infer<typeof GitHubPullRequestPlanViewSchema>;

export const GitHubPullRequestResultViewSchema = z
  .object({
    url: GitRemoteWebUrlSchema,
    ownerRepository: GitHubOwnerRepositorySchema,
    baseBranch: GitRemoteBranchSchema,
    headBranch: GitRemoteBranchSchema,
    sourceOid: GitRemoteOidSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const url = new URL(result.url);
    const expectedPath = `/${result.ownerRepository}/pull/`;
    const pullNumber = url.pathname.slice(expectedPath.length).replace(/\/$/u, '');
    if (!url.pathname.startsWith(expectedPath) || !/^[1-9]\d*$/u.test(pullNumber)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Pull request URL must identify the disclosed repository and pull request.',
      });
    }
  });
export type GitHubPullRequestResultView = z.infer<typeof GitHubPullRequestResultViewSchema>;
