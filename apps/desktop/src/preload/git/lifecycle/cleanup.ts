import type { z } from 'zod';

import type { ForgeboardApi } from '../../../shared/api.js';
import { ipcResultSchema, type IpcResult } from '../../../shared/application/contracts.js';
import { GitTargetInputSchema } from '../../../shared/git/contracts.js';
import {
  GIT_LIFECYCLE_IPC_CHANNELS,
  GitWorktreeArchivePlanViewSchema,
  GitWorktreeMetadataConfirmationInputSchema,
  GitWorktreeMetadataResultViewSchema,
  GitWorktreeRenamePlanViewSchema,
  GitWorktreeRenamePrepareInputSchema,
  GitWorktreeRestorePlanViewSchema,
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
    prepareRename: async (input) =>
      await invokeLifecycle(
        invoke,
        GIT_LIFECYCLE_IPC_CHANNELS.prepareRename,
        GitWorktreeRenamePrepareInputSchema,
        GitWorktreeRenamePlanViewSchema,
        input,
      ),
    confirmRename: async (input) =>
      await invokeLifecycle(
        invoke,
        GIT_LIFECYCLE_IPC_CHANNELS.confirmRename,
        GitWorktreeMetadataConfirmationInputSchema,
        GitWorktreeMetadataResultViewSchema.nullable(),
        input,
      ),
    prepareArchive: async (input) =>
      await invokeLifecycle(
        invoke,
        GIT_LIFECYCLE_IPC_CHANNELS.prepareArchive,
        GitWorktreeCleanupTargetInputSchema,
        GitWorktreeArchivePlanViewSchema,
        input,
      ),
    confirmArchive: async (input) =>
      await invokeLifecycle(
        invoke,
        GIT_LIFECYCLE_IPC_CHANNELS.confirmArchive,
        GitWorktreeMetadataConfirmationInputSchema,
        GitWorktreeMetadataResultViewSchema.nullable(),
        input,
      ),
    prepareRestore: async (input) =>
      await invokeLifecycle(
        invoke,
        GIT_LIFECYCLE_IPC_CHANNELS.prepareRestore,
        GitWorktreeCleanupTargetInputSchema,
        GitWorktreeRestorePlanViewSchema,
        input,
      ),
    confirmRestore: async (input) =>
      await invokeLifecycle(
        invoke,
        GIT_LIFECYCLE_IPC_CHANNELS.confirmRestore,
        GitWorktreeMetadataConfirmationInputSchema,
        GitWorktreeMetadataResultViewSchema.nullable(),
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
