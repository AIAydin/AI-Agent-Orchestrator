import { z } from 'zod';

import {
  GitRemoteBranchSchema,
  GitRemoteDeliveryTargetInputSchema,
  GitRemoteDescriptorViewSchema,
  GitRemoteEndpointSchema,
  GitRemoteNameSchema,
  GitRemoteOidSchema,
  GitRemoteTimestampSchema,
  GitRemoteUuidSchema,
  GitRemoteWebUrlSchema,
  GitHubOwnerRepositorySchema,
} from './common.js';

export const GitHubStatusPrepareInputSchema = z
  .object({
    target: GitRemoteDeliveryTargetInputSchema,
    remote: GitRemoteNameSchema,
    destinationBranch: GitRemoteBranchSchema,
    baseBranch: GitRemoteBranchSchema,
  })
  .strict();
export type GitHubStatusPrepareInput = z.infer<typeof GitHubStatusPrepareInputSchema>;

export const GitHubStatusPlanViewSchema = z
  .object({
    kind: z.literal('github-status'),
    planId: GitRemoteUuidSchema,
    expiresAt: GitRemoteTimestampSchema,
    target: GitRemoteDeliveryTargetInputSchema,
    remote: GitRemoteDescriptorViewSchema,
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
        message: 'GitHub status requires a GitHub-compatible remote.',
      });
    }
  });
export type GitHubStatusPlanView = z.infer<typeof GitHubStatusPlanViewSchema>;

export const GitHubStatusResultViewSchema = z
  .object({
    installed: z.boolean(),
    version: z.string().trim().min(1).max(128).nullable(),
    hostname: GitRemoteEndpointSchema,
    authenticated: z.boolean(),
    ownerRepository: GitHubOwnerRepositorySchema.nullable(),
    repositoryUrl: GitRemoteWebUrlSchema.nullable(),
    defaultBranch: GitRemoteBranchSchema.nullable(),
    baseBranch: GitRemoteBranchSchema,
    headBranch: GitRemoteBranchSchema,
    sourceHead: GitRemoteOidSchema,
    baseOid: GitRemoteOidSchema.nullable(),
    headOid: GitRemoteOidSchema.nullable(),
    headMatchesSource: z.boolean(),
    checkedAt: GitRemoteTimestampSchema,
  })
  .strict()
  .superRefine((status, context) => {
    if (status.installed !== (status.version !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['version'],
        message: 'GitHub CLI availability requires one validated version.',
      });
    }
    if (!status.installed && status.authenticated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authenticated'],
        message: 'An unavailable GitHub CLI cannot be authenticated.',
      });
    }
    const repositoryFields = [
      status.ownerRepository,
      status.repositoryUrl,
      status.defaultBranch,
      status.baseOid,
    ];
    const hasRepository = repositoryFields.every((value) => value !== null);
    if (repositoryFields.some((value) => value !== null) !== hasRepository) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerRepository'],
        message: 'GitHub repository status must be complete or unavailable.',
      });
    }
    if (hasRepository !== status.authenticated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authenticated'],
        message: 'Only authenticated GitHub status can expose repository metadata.',
      });
    }
    if (status.headMatchesSource !== (status.headOid === status.sourceHead)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headMatchesSource'],
        message: 'Remote-head match state must equal the exact disclosed source commit.',
      });
    }
    if (status.repositoryUrl !== null) {
      const repositoryHost = new URL(status.repositoryUrl).hostname.toLowerCase();
      const expectedHost = status.hostname.replace(/:\d+$/u, '').toLowerCase();
      if (repositoryHost !== expectedHost) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repositoryUrl'],
          message: 'Repository URL must belong to the disclosed GitHub hostname.',
        });
      }
    }
  });
export type GitHubStatusResultView = z.infer<typeof GitHubStatusResultViewSchema>;
