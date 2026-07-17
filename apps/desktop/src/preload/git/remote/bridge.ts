import type { z } from 'zod';

import { ipcResultSchema, type IpcResult } from '../../../shared/application/contracts.js';
import {
  GIT_REMOTE_IPC_CHANNELS,
  GitRemotePlanCancelInputSchema,
  GitRemotePlanCancelResultSchema,
  GitHubCiPlanViewSchema,
  GitHubCiPrepareInputSchema,
  GitHubCiResultViewSchema,
  GitHubPullRequestPlanViewSchema,
  GitHubPullRequestPrepareInputSchema,
  GitHubPullRequestResultViewSchema,
  GitHubStatusPlanViewSchema,
  GitHubStatusPrepareInputSchema,
  GitHubStatusResultViewSchema,
  GitRemoteInspectInputSchema,
  GitRemoteInspectViewSchema,
  GitRemotePlanConfirmationInputSchema,
  GitRemotePushPlanViewSchema,
  GitRemotePushPrepareInputSchema,
  GitRemotePushResultViewSchema,
  type GitHubCiPlanView,
  type GitHubCiPrepareInput,
  type GitHubCiResultView,
  type GitHubPullRequestPlanView,
  type GitHubPullRequestPrepareInput,
  type GitHubPullRequestResultView,
  type GitHubStatusPlanView,
  type GitHubStatusPrepareInput,
  type GitHubStatusResultView,
  type GitRemoteInspectInput,
  type GitRemoteInspectView,
  type GitRemotePlanCancelInput,
  type GitRemotePlanCancelResult,
  type GitRemotePlanConfirmationInput,
  type GitRemotePushPlanView,
  type GitRemotePushPrepareInput,
  type GitRemotePushResultView,
} from '../../../shared/git/remote/index.js';

export type GitRemoteIpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export interface GitRemoteDeliveryApi {
  inspect(input: GitRemoteInspectInput): Promise<IpcResult<GitRemoteInspectView>>;
  cancelPlan(input: GitRemotePlanCancelInput): Promise<IpcResult<GitRemotePlanCancelResult>>;
  preparePush(input: GitRemotePushPrepareInput): Promise<IpcResult<GitRemotePushPlanView>>;
  confirmPush(
    input: GitRemotePlanConfirmationInput,
  ): Promise<IpcResult<GitRemotePushResultView | null>>;
  prepareGitHubStatus(input: GitHubStatusPrepareInput): Promise<IpcResult<GitHubStatusPlanView>>;
  confirmGitHubStatus(
    input: GitRemotePlanConfirmationInput,
  ): Promise<IpcResult<GitHubStatusResultView | null>>;
  preparePullRequest(
    input: GitHubPullRequestPrepareInput,
  ): Promise<IpcResult<GitHubPullRequestPlanView>>;
  confirmPullRequest(
    input: GitRemotePlanConfirmationInput,
  ): Promise<IpcResult<GitHubPullRequestResultView | null>>;
  prepareCi(input: GitHubCiPrepareInput): Promise<IpcResult<GitHubCiPlanView>>;
  confirmCi(input: GitRemotePlanConfirmationInput): Promise<IpcResult<GitHubCiResultView | null>>;
}

/** Creates the path-free bridge and validates both renderer requests and main-process results. */
export function createGitRemoteDeliveryApi(invoke: GitRemoteIpcInvoker): GitRemoteDeliveryApi {
  return {
    inspect: async (input) =>
      await invokeRemote(
        invoke,
        GIT_REMOTE_IPC_CHANNELS.inspect,
        GitRemoteInspectInputSchema,
        GitRemoteInspectViewSchema,
        input,
      ),
    cancelPlan: async (input) =>
      await invokeRemote(
        invoke,
        GIT_REMOTE_IPC_CHANNELS.cancelPlan,
        GitRemotePlanCancelInputSchema,
        GitRemotePlanCancelResultSchema,
        input,
      ),
    preparePush: async (input) =>
      await invokeRemote(
        invoke,
        GIT_REMOTE_IPC_CHANNELS.preparePush,
        GitRemotePushPrepareInputSchema,
        GitRemotePushPlanViewSchema,
        input,
      ),
    confirmPush: async (input) =>
      await invokeRemote(
        invoke,
        GIT_REMOTE_IPC_CHANNELS.confirmPush,
        GitRemotePlanConfirmationInputSchema,
        GitRemotePushResultViewSchema.nullable(),
        input,
      ),
    prepareGitHubStatus: async (input) =>
      await invokeRemote(
        invoke,
        GIT_REMOTE_IPC_CHANNELS.prepareGitHubStatus,
        GitHubStatusPrepareInputSchema,
        GitHubStatusPlanViewSchema,
        input,
      ),
    confirmGitHubStatus: async (input) =>
      await invokeRemote(
        invoke,
        GIT_REMOTE_IPC_CHANNELS.confirmGitHubStatus,
        GitRemotePlanConfirmationInputSchema,
        GitHubStatusResultViewSchema.nullable(),
        input,
      ),
    preparePullRequest: async (input) =>
      await invokeRemote(
        invoke,
        GIT_REMOTE_IPC_CHANNELS.preparePullRequest,
        GitHubPullRequestPrepareInputSchema,
        GitHubPullRequestPlanViewSchema,
        input,
      ),
    confirmPullRequest: async (input) =>
      await invokeRemote(
        invoke,
        GIT_REMOTE_IPC_CHANNELS.confirmPullRequest,
        GitRemotePlanConfirmationInputSchema,
        GitHubPullRequestResultViewSchema.nullable(),
        input,
      ),
    prepareCi: async (input) =>
      await invokeRemote(
        invoke,
        GIT_REMOTE_IPC_CHANNELS.prepareCi,
        GitHubCiPrepareInputSchema,
        GitHubCiPlanViewSchema,
        input,
      ),
    confirmCi: async (input) =>
      await invokeRemote(
        invoke,
        GIT_REMOTE_IPC_CHANNELS.confirmCi,
        GitRemotePlanConfirmationInputSchema,
        GitHubCiResultViewSchema.nullable(),
        input,
      ),
  };
}

async function invokeRemote<Input, Output>(
  invoke: GitRemoteIpcInvoker,
  channel: string,
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>,
  outputSchema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  input: Input,
): Promise<IpcResult<Output>> {
  const parsedInput = inputSchema.parse(input);
  const rawResult: unknown = await invoke(channel, parsedInput);
  return ipcResultSchema(outputSchema).parse(rawResult);
}
