import { z } from 'zod';

import { GitAgentBaseComparisonViewSchema } from '../contracts.js';

export const GIT_AGENT_COMPARISON_IPC_CHANNELS = Object.freeze({
  compare: 'git:comparison:compare-agents',
});

const ProjectIdSchema = z.string().uuid();
const RunIdSchema = z.string().uuid();
const OidSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);

export const GitAgentComparisonTargetSchema = z
  .object({
    kind: z.literal('agent-worktree'),
    projectId: ProjectIdSchema,
    runId: RunIdSchema,
  })
  .strict();
export type GitAgentComparisonTarget = z.infer<typeof GitAgentComparisonTargetSchema>;

export const GitAgentComparisonInputSchema = z
  .object({
    left: GitAgentComparisonTargetSchema,
    right: GitAgentComparisonTargetSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.left.projectId !== input.right.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['right', 'projectId'],
        message: 'Agent comparisons require two runs from the same project.',
      });
    }
    if (input.left.runId === input.right.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['right', 'runId'],
        message: 'Agent comparisons require two different runs.',
      });
    }
  });
export type GitAgentComparisonInput = z.infer<typeof GitAgentComparisonInputSchema>;

const GitAgentComparisonSideViewSchema = z
  .object({
    projectId: ProjectIdSchema,
    runId: RunIdSchema,
    nodeId: z.string().min(1).max(512),
    agentId: z.string().min(1).max(512),
    headCommit: OidSchema,
  })
  .strict();

/** Bounded, path-authority-free comparison between two main-resolved owned worktrees. */
export const GitAgentComparisonViewSchema = z
  .object({
    left: GitAgentComparisonSideViewSchema,
    right: GitAgentComparisonSideViewSchema,
    comparison: GitAgentBaseComparisonViewSchema,
  })
  .strict()
  .superRefine((view, context) => {
    if (view.left.projectId !== view.right.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['right', 'projectId'],
        message: 'Compared agents must belong to the same project.',
      });
    }
    if (view.left.runId === view.right.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['right', 'runId'],
        message: 'Compared agents must be different runs.',
      });
    }
    if (
      view.comparison.baseCommit !== view.left.headCommit ||
      view.comparison.headCommit !== view.right.headCommit
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['comparison'],
        message: 'Comparison commits must match the exact resolved agent heads.',
      });
    }
  });
export type GitAgentComparisonView = z.infer<typeof GitAgentComparisonViewSchema>;
