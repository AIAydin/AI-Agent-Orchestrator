import { z } from 'zod';

import {
  GitDeliveryReadinessViewSchema,
  GitRemoteBranchSchema,
  GitRemoteDeliveryTargetInputSchema,
  GitRemoteDescriptorViewSchema,
  GitRemoteExactChangesFields,
  GitRemoteNameSchema,
  GitRemoteOidSchema,
  GitRemoteRefSchema,
  GitRemoteTimestampSchema,
  GitRemoteUuidSchema,
  validateExactChangesView,
  validateReadyDeliveryEvidence,
} from './common.js';

export const GitRemotePushPrepareInputSchema = z
  .object({
    target: GitRemoteDeliveryTargetInputSchema,
    remote: GitRemoteNameSchema,
    destinationBranch: GitRemoteBranchSchema,
  })
  .strict();
export type GitRemotePushPrepareInput = z.infer<typeof GitRemotePushPrepareInputSchema>;

export const GitRemotePushPlanViewSchema = z
  .object({
    kind: z.literal('git-push'),
    planId: GitRemoteUuidSchema,
    expiresAt: GitRemoteTimestampSchema,
    target: GitRemoteDeliveryTargetInputSchema,
    projectName: z.string().trim().min(1).max(512),
    remote: GitRemoteDescriptorViewSchema,
    sourceBranch: GitRemoteRefSchema,
    destinationBranch: GitRemoteBranchSchema,
    baseCommit: GitRemoteOidSchema,
    sourceHead: GitRemoteOidSchema,
    ...GitRemoteExactChangesFields,
    force: z.literal(false),
    readiness: GitDeliveryReadinessViewSchema,
    readinessApprovalId: GitRemoteUuidSchema,
  })
  .strict()
  .superRefine((plan, context) => {
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
export type GitRemotePushPlanView = z.infer<typeof GitRemotePushPlanViewSchema>;

export const GitRemotePushResultViewSchema = z
  .object({
    remote: GitRemoteNameSchema,
    destinationBranch: GitRemoteBranchSchema,
    sourceOid: GitRemoteOidSchema,
  })
  .strict();
export type GitRemotePushResultView = z.infer<typeof GitRemotePushResultViewSchema>;
