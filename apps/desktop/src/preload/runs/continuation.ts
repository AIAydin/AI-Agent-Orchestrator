import type { ForgeboardApi } from '../../shared/api.js';
import {
  IPC_CHANNELS,
  PrepareRunContinuationInputSchema,
  PrepareRunInputSchema,
  RunApprovalViewSchema,
  ipcResultSchema,
} from '../../shared/application/contracts.js';

export type RunContinuationIpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** Strict renderer bridge for fresh launch, resume, and retry disclosures. */
export function createRunContinuationApi(
  invoke: RunContinuationIpcInvoker,
): Pick<ForgeboardApi['runs'], 'prepare' | 'resume' | 'retry'> {
  const response = ipcResultSchema(RunApprovalViewSchema.nullable());
  return {
    prepare: async (input) =>
      response.parse(await invoke(IPC_CHANNELS.runsPrepare, PrepareRunInputSchema.parse(input))),
    resume: async (input) =>
      response.parse(
        await invoke(IPC_CHANNELS.runsResume, PrepareRunContinuationInputSchema.parse(input)),
      ),
    retry: async (input) =>
      response.parse(
        await invoke(IPC_CHANNELS.runsRetry, PrepareRunContinuationInputSchema.parse(input)),
      ),
  };
}
