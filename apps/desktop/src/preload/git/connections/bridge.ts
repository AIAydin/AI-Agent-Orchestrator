import type { z } from 'zod';

import { ipcResultSchema, type IpcResult } from '../../../shared/application/contracts.js';
import {
  GIT_CONNECTIONS_IPC_CHANNELS,
  GitConnectionConfirmInputSchema,
  GitConnectionMutationPlanViewSchema,
  GitConnectionPlanCancelResultSchema,
  GitConnectionPlanConfirmationInputSchema,
  GitConnectionPrepareLocalInputSchema,
  GitConnectionPrepareNetworkInputSchema,
  GitConnectionPrepareRemoveInputSchema,
  GitConnectionProjectInputSchema,
  GitConnectionsViewSchema,
  GitHubCliSelectionPlanViewSchema,
  GitHubCliStatusViewSchema,
  type GitConnectionConfirmInput,
  type GitConnectionMutationPlanView,
  type GitConnectionPlanCancelResult,
  type GitConnectionPlanConfirmationInput,
  type GitConnectionPrepareLocalInput,
  type GitConnectionPrepareNetworkInput,
  type GitConnectionPrepareRemoveInput,
  type GitConnectionProjectInput,
  type GitConnectionsView,
  type GitHubCliSelectionPlanView,
  type GitHubCliStatusView,
} from '../../../shared/git/connections/index.js';

export type GitConnectionsIpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export interface GitConnectionsApi {
  list(input: GitConnectionProjectInput): Promise<IpcResult<GitConnectionsView>>;
  prepareNetwork(
    input: GitConnectionPrepareNetworkInput,
  ): Promise<IpcResult<GitConnectionMutationPlanView>>;
  prepareLocal(
    input: GitConnectionPrepareLocalInput,
  ): Promise<IpcResult<GitConnectionMutationPlanView | null>>;
  prepareRemove(
    input: GitConnectionPrepareRemoveInput,
  ): Promise<IpcResult<GitConnectionMutationPlanView>>;
  confirm(input: GitConnectionConfirmInput): Promise<IpcResult<GitConnectionsView | null>>;
  cancelPlan(
    input: GitConnectionPlanConfirmationInput,
  ): Promise<IpcResult<GitConnectionPlanCancelResult>>;
  status(): Promise<IpcResult<GitHubCliStatusView>>;
  refresh(): Promise<IpcResult<GitHubCliStatusView>>;
  chooseGitHubCli(): Promise<IpcResult<GitHubCliSelectionPlanView | null>>;
  /** Prepares automatic PATH selection. `confirmGitHubCli` is still required to apply it. */
  useAutomaticGitHubCli(): Promise<IpcResult<GitHubCliSelectionPlanView>>;
  confirmGitHubCli(
    input: GitConnectionPlanConfirmationInput,
  ): Promise<IpcResult<GitHubCliStatusView | null>>;
}

/** Creates the path-free bridge and validates both renderer requests and main-process results. */
export function createGitConnectionsApi(invoke: GitConnectionsIpcInvoker): GitConnectionsApi {
  return {
    list: async (input) =>
      await invokeConnections(
        invoke,
        GIT_CONNECTIONS_IPC_CHANNELS.list,
        GitConnectionProjectInputSchema,
        GitConnectionsViewSchema,
        input,
      ),
    prepareNetwork: async (input) =>
      await invokeConnections(
        invoke,
        GIT_CONNECTIONS_IPC_CHANNELS.prepareNetwork,
        GitConnectionPrepareNetworkInputSchema,
        GitConnectionMutationPlanViewSchema,
        input,
      ),
    prepareLocal: async (input) =>
      await invokeConnections(
        invoke,
        GIT_CONNECTIONS_IPC_CHANNELS.prepareLocal,
        GitConnectionPrepareLocalInputSchema,
        GitConnectionMutationPlanViewSchema.nullable(),
        input,
      ),
    prepareRemove: async (input) =>
      await invokeConnections(
        invoke,
        GIT_CONNECTIONS_IPC_CHANNELS.prepareRemove,
        GitConnectionPrepareRemoveInputSchema,
        GitConnectionMutationPlanViewSchema,
        input,
      ),
    confirm: async (input) =>
      await invokeConnections(
        invoke,
        GIT_CONNECTIONS_IPC_CHANNELS.confirm,
        GitConnectionConfirmInputSchema,
        GitConnectionsViewSchema.nullable(),
        input,
      ),
    cancelPlan: async (input) =>
      await invokeConnections(
        invoke,
        GIT_CONNECTIONS_IPC_CHANNELS.cancelPlan,
        GitConnectionPlanConfirmationInputSchema,
        GitConnectionPlanCancelResultSchema,
        input,
      ),
    status: async () =>
      await invokeWithoutInput(
        invoke,
        GIT_CONNECTIONS_IPC_CHANNELS.githubCliStatus,
        GitHubCliStatusViewSchema,
      ),
    refresh: async () =>
      await invokeWithoutInput(
        invoke,
        GIT_CONNECTIONS_IPC_CHANNELS.githubCliRefresh,
        GitHubCliStatusViewSchema,
      ),
    chooseGitHubCli: async () =>
      await invokeWithoutInput(
        invoke,
        GIT_CONNECTIONS_IPC_CHANNELS.githubCliChoose,
        GitHubCliSelectionPlanViewSchema.nullable(),
      ),
    useAutomaticGitHubCli: async () =>
      await invokeWithoutInput(
        invoke,
        GIT_CONNECTIONS_IPC_CHANNELS.githubCliUseAutomatic,
        GitHubCliSelectionPlanViewSchema,
      ),
    confirmGitHubCli: async (input) =>
      await invokeConnections(
        invoke,
        GIT_CONNECTIONS_IPC_CHANNELS.githubCliConfirm,
        GitConnectionPlanConfirmationInputSchema,
        GitHubCliStatusViewSchema.nullable(),
        input,
      ),
  };
}

async function invokeConnections<Input, Output>(
  invoke: GitConnectionsIpcInvoker,
  channel: string,
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>,
  outputSchema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  input: Input,
): Promise<IpcResult<Output>> {
  const parsedInput = inputSchema.parse(input);
  const rawResult: unknown = await invoke(channel, parsedInput);
  return ipcResultSchema(outputSchema).parse(rawResult);
}

async function invokeWithoutInput<Output>(
  invoke: GitConnectionsIpcInvoker,
  channel: string,
  outputSchema: z.ZodType<Output, z.ZodTypeDef, unknown>,
): Promise<IpcResult<Output>> {
  const rawResult: unknown = await invoke(channel);
  return ipcResultSchema(outputSchema).parse(rawResult);
}
