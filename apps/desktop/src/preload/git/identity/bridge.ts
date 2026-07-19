import { ipcResultSchema, type IpcResult } from '../../../shared/application/contracts.js';
import {
  GIT_IDENTITY_IPC_CHANNEL,
  GitIdentityCheckInputSchema,
  GitIdentityCheckResultSchema,
  sameGitIdentityCheckInput,
  type GitIdentityCheckInput,
  type GitIdentityCheckResult,
} from '../../../shared/git/identity/contracts.js';

export type GitIdentityIpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export interface GitIdentityApi {
  check(input: GitIdentityCheckInput): Promise<IpcResult<GitIdentityCheckResult>>;
}

/** Path-free, schema-validating bridge for one transient Git identity diagnostic. */
export function createGitIdentityApi(invoke: GitIdentityIpcInvoker): GitIdentityApi {
  return {
    check: async (input) => {
      const parsedInput = GitIdentityCheckInputSchema.parse(input);
      const result = await invoke(GIT_IDENTITY_IPC_CHANNEL, parsedInput);
      const parsedResult = ipcResultSchema(GitIdentityCheckResultSchema).parse(result);
      if (parsedResult.ok && !sameGitIdentityCheckInput(parsedResult.value.request, parsedInput)) {
        throw new Error('Git identity response did not match the exact request.');
      }
      return parsedResult;
    },
  };
}
