import type { z } from 'zod';

import type { ForgeboardApi } from '../../../shared/api.js';
import { ipcResultSchema, type IpcResult } from '../../../shared/application/contracts.js';
import { GitTargetInputSchema } from '../../../shared/git/contracts.js';
import {
  GIT_LIFECYCLE_IPC_CHANNELS,
  GitWorkspaceExternalOpenResultSchema,
  GitWorktreeCleanupConfirmationInputSchema,
  GitWorktreeCleanupPrepareOutcomeSchema,
  GitWorktreeCleanupResultViewSchema,
  GitWorktreeCleanupTargetInputSchema,
} from '../../../shared/git/lifecycle/contracts.js';

export type GitLifecycleIpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** Creates the schema-validating, path-free bridge for managed-worktree lifecycle actions. */
export function createGitLifecycleApi(
  invoke: GitLifecycleIpcInvoker,
): ForgeboardApi['git']['lifecycle'] {
  return {
    openExternal: async (input) =>
      await invokeLifecycle(
        invoke,
        GIT_LIFECYCLE_IPC_CHANNELS.openExternal,
        GitTargetInputSchema,
        GitWorkspaceExternalOpenResultSchema,
        input,
      ),
    prepareCleanup: async (input) =>
      await invokeLifecycle(
        invoke,
        GIT_LIFECYCLE_IPC_CHANNELS.prepareCleanup,
        GitWorktreeCleanupTargetInputSchema,
        GitWorktreeCleanupPrepareOutcomeSchema,
        input,
      ),
    confirmCleanup: async (input) =>
      await invokeLifecycle(
        invoke,
        GIT_LIFECYCLE_IPC_CHANNELS.confirmCleanup,
        GitWorktreeCleanupConfirmationInputSchema,
        GitWorktreeCleanupResultViewSchema.nullable(),
        input,
      ),
  };
}

async function invokeLifecycle<Input, Output>(
  invoke: GitLifecycleIpcInvoker,
  channel: string,
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>,
  outputSchema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  input: Input,
): Promise<IpcResult<Output>> {
  const parsedInput = inputSchema.parse(input);
  const rawResult: unknown = await invoke(channel, parsedInput);
  return ipcResultSchema(outputSchema).parse(rawResult);
}
