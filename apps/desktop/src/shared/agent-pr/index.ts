import { z } from 'zod';

/** One-shot "PR" action on an agent node: commit if needed → push → `gh pr create --fill`. */
export const AGENT_PR_IPC_CHANNEL = 'agent-session:create-pr';

export const AgentSessionPrInputSchema = z
  .object({
    projectId: z.string().uuid(),
    nodeId: z.string().min(1).max(256),
    /** Managed-worktree session run; absent for sessions that write in the project directory. */
    runId: z.string().uuid().optional(),
  })
  .strict();
export type AgentSessionPrInput = z.infer<typeof AgentSessionPrInputSchema>;

export const AgentSessionPrViewSchema = z
  .object({
    /** The created pull request's web URL, when `gh` reported one. */
    url: z.string().url().nullable(),
    branch: z.string().min(1).max(4_096),
    /** Whether uncommitted session changes were committed first. */
    committed: z.boolean(),
  })
  .strict();
export type AgentSessionPrView = z.infer<typeof AgentSessionPrViewSchema>;
