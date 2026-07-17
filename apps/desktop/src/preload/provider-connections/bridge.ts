import type { IpcResult } from '../../shared/application/contracts.js';
import type { z } from 'zod';
import {
  PROVIDER_CONNECTION_IPC_CHANNELS,
  ProviderConnectionCancelResultSchema,
  ProviderConnectionGetInputSchema,
  ProviderConnectionPlanInputSchema,
  ProviderConnectionPlanSchema,
  ProviderConnectionPrepareInputSchema,
  ProviderConnectionStatusSchema,
  type ProviderConnectionCancelResult,
  type ProviderConnectionGetInput,
  type ProviderConnectionPlan,
  type ProviderConnectionPlanInput,
  type ProviderConnectionPrepareInput,
  type ProviderConnectionStatus,
} from '../../shared/provider-connections/index.js';
import { ipcResultSchema } from '../../shared/application/contracts.js';

export type ProviderConnectionIpcInvoker = (
  channel: string,
  ...args: unknown[]
) => Promise<unknown>;

export interface ProviderConnectionsApi {
  get(input: ProviderConnectionGetInput): Promise<IpcResult<ProviderConnectionStatus>>;
  prepare(input: ProviderConnectionPrepareInput): Promise<IpcResult<ProviderConnectionPlan>>;
  confirm(input: ProviderConnectionPlanInput): Promise<IpcResult<ProviderConnectionStatus | null>>;
  cancel(input: ProviderConnectionPlanInput): Promise<IpcResult<ProviderConnectionCancelResult>>;
}

export function createProviderConnectionsApi(
  invoke: ProviderConnectionIpcInvoker,
): ProviderConnectionsApi {
  return {
    get: async (input) =>
      await invokeProviderConnection(
        invoke,
        PROVIDER_CONNECTION_IPC_CHANNELS.get,
        ProviderConnectionGetInputSchema.parse(input),
        ProviderConnectionStatusSchema,
      ),
    prepare: async (input) =>
      await invokeProviderConnection(
        invoke,
        PROVIDER_CONNECTION_IPC_CHANNELS.prepare,
        ProviderConnectionPrepareInputSchema.parse(input),
        ProviderConnectionPlanSchema,
      ),
    confirm: async (input) =>
      await invokeProviderConnection(
        invoke,
        PROVIDER_CONNECTION_IPC_CHANNELS.confirm,
        ProviderConnectionPlanInputSchema.parse(input),
        ProviderConnectionStatusSchema.nullable(),
      ),
    cancel: async (input) =>
      await invokeProviderConnection(
        invoke,
        PROVIDER_CONNECTION_IPC_CHANNELS.cancel,
        ProviderConnectionPlanInputSchema.parse(input),
        ProviderConnectionCancelResultSchema,
      ),
  };
}

async function invokeProviderConnection<Input, Output>(
  invoke: ProviderConnectionIpcInvoker,
  channel: string,
  input: Input,
  output: z.ZodType<Output>,
): Promise<IpcResult<Output>> {
  return ipcResultSchema(output).parse(await invoke(channel, input));
}
