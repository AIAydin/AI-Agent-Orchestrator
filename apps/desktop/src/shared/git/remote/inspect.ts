import { z } from 'zod';

import { GitDeliveryReadinessGetViewSchema } from '../readiness/index.js';
import {
  GIT_REMOTE_MAX_REMOTES,
  GitRemoteBoundedChangesFields,
  GitRemoteDeliveryTargetInputSchema,
  GitRemoteDescriptorViewSchema,
  GitRemoteOidSchema,
  GitRemoteRefSchema,
  GitRemoteTimestampSchema,
  validateBoundedChangesView,
} from './common.js';

export const GitRemoteInspectInputSchema = z
  .object({ target: GitRemoteDeliveryTargetInputSchema })
  .strict();
export type GitRemoteInspectInput = z.infer<typeof GitRemoteInspectInputSchema>;

export const GitRemoteInspectViewSchema = z
  .object({
    target: GitRemoteDeliveryTargetInputSchema,
    projectName: z.string().trim().min(1).max(512),
    sourceBranch: GitRemoteRefSchema,
    baseRef: GitRemoteRefSchema,
    baseCommit: GitRemoteOidSchema,
    divergenceBaseCommit: GitRemoteOidSchema,
    sourceHead: GitRemoteOidSchema,
    ahead: z.number().int().nonnegative().max(10_000_000),
    behind: z.number().int().nonnegative().max(10_000_000),
    dirty: z.boolean(),
    ...GitRemoteBoundedChangesFields,
    remotes: z.array(GitRemoteDescriptorViewSchema).max(GIT_REMOTE_MAX_REMOTES),
    defaultRemote: z.string().min(1).max(128).nullable(),
    readiness: GitDeliveryReadinessGetViewSchema,
    refreshedAt: GitRemoteTimestampSchema,
  })
  .strict()
  .superRefine((view, context) => {
    validateBoundedChangesView(
      {
        commitCount: view.commitCount,
        commits: view.commits,
        commitsTruncated: view.commitsTruncated,
        fileCount: view.fileCount,
        files: view.files,
        filesTruncated: view.filesTruncated,
        additions: view.additions,
        deletions: view.deletions,
      },
      context,
    );
    const remoteNames = view.remotes.map((remote) => remote.name);
    if (new Set(remoteNames).size !== remoteNames.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remotes'],
        message: 'Discovered Git remotes must be unique.',
      });
    }
    if (view.defaultRemote !== null && !remoteNames.includes(view.defaultRemote)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultRemote'],
        message: 'The default remote must be one of the discovered remotes.',
      });
    }
    if (
      view.readiness.target.projectId !== view.target.projectId ||
      view.readiness.target.runId !== view.target.runId ||
      view.readiness.source.sourceHead !== view.sourceHead
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readiness'],
        message: 'Remote inspection readiness must match the exact selected source.',
      });
    }
  });
export type GitRemoteInspectView = z.infer<typeof GitRemoteInspectViewSchema>;
