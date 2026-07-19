import type { ForgeboardApi } from '../../../shared/api.js';
import { ipcResultSchema } from '../../../shared/application/contracts.js';
import {
  GIT_AGENT_COMPARISON_IPC_CHANNELS,
  GitAgentComparisonInputSchema,
  GitAgentComparisonViewSchema,
} from '../../../shared/git/comparison/contracts.js';

export type GitAgentComparisonIpcInvoker = (
  channel: string,
  ...args: unknown[]
) => Promise<unknown>;

/** Creates the strict path-free bridge for comparing two main-resolved agent worktrees. */
export function createGitAgentComparisonApi(
  invoke: GitAgentComparisonIpcInvoker,
): ForgeboardApi['git']['comparison'] {
  return {
    compareAgents: async (input) => {
      const parsedInput = GitAgentComparisonInputSchema.parse(input);
      const result: unknown = await invoke(GIT_AGENT_COMPARISON_IPC_CHANNELS.compare, parsedInput);
      return ipcResultSchema(GitAgentComparisonViewSchema).parse(result);
    },
  };
}
