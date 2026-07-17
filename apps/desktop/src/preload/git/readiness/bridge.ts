import type { z } from 'zod';

import type { ForgeboardApi } from '../../../shared/api.js';
import { ipcResultSchema, type IpcResult } from '../../../shared/application/contracts.js';
import {
  GIT_DELIVERY_READINESS_IPC_CHANNELS,
  GitDeliveryReadinessApproveInputSchema,
  GitDeliveryReadinessApproveViewSchema,
  GitDeliveryReadinessGetInputSchema,
  GitDeliveryReadinessGetViewSchema,
  GitDeliveryReadinessPrepareInputSchema,
  GitDeliveryReadinessPrepareViewSchema,
  GitDeliveryReadinessRunInputSchema,
  GitDeliveryReadinessRunViewSchema,
} from '../../../shared/git/readiness/index.js';

export type GitDeliveryReadinessIpcInvoker = (
  channel: string,
  ...args: unknown[]
) => Promise<unknown>;

/** Narrow, schema-validating bridge for content-bound delivery evidence. */
export function createGitDeliveryReadinessApi(
  invoke: GitDeliveryReadinessIpcInvoker,
): ForgeboardApi['git']['readiness'] {
  return {
    get: async (input) =>
      await invokeReadiness(
        invoke,
        GIT_DELIVERY_READINESS_IPC_CHANNELS.get,
        GitDeliveryReadinessGetInputSchema,
        GitDeliveryReadinessGetViewSchema,
        input,
      ),
    prepare: async (input) =>
      await invokeReadiness(
        invoke,
        GIT_DELIVERY_READINESS_IPC_CHANNELS.prepare,
        GitDeliveryReadinessPrepareInputSchema,
        GitDeliveryReadinessPrepareViewSchema,
        input,
      ),
    run: async (input) =>
      await invokeReadiness(
        invoke,
        GIT_DELIVERY_READINESS_IPC_CHANNELS.run,
        GitDeliveryReadinessRunInputSchema,
        GitDeliveryReadinessRunViewSchema.nullable(),
        input,
      ),
    approve: async (input) =>
      await invokeReadiness(
        invoke,
        GIT_DELIVERY_READINESS_IPC_CHANNELS.approve,
        GitDeliveryReadinessApproveInputSchema,
        GitDeliveryReadinessApproveViewSchema.nullable(),
        input,
      ),
  };
}

async function invokeReadiness<Input, Output>(
  invoke: GitDeliveryReadinessIpcInvoker,
  channel: string,
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>,
  outputSchema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  input: Input,
): Promise<IpcResult<Output>> {
  const parsedInput = inputSchema.parse(input);
  const rawResult = await invoke(channel, parsedInput);
  return ipcResultSchema(outputSchema).parse(rawResult);
}
