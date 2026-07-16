import { z } from 'zod';

import type { ForgeboardApi } from '../../shared/api.js';
import { IPC_CHANNELS, ipcResultSchema } from '../../shared/application/contracts.js';
import {
  RUN_HISTORY_MAX_LIMIT,
  RunHistoryListInputSchema,
  RunHistorySummarySchema,
} from '../../shared/runs/contracts.js';

export type RunHistoryIpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** Creates the narrow, path-free persisted run-history bridge. */
export function createRunHistoryApi(
  invoke: RunHistoryIpcInvoker,
): Pick<ForgeboardApi['runs'], 'list'> {
  return {
    list: async (input) => {
      const parsedInput = RunHistoryListInputSchema.parse(input);
      const rawResult: unknown = await invoke(IPC_CHANNELS.runsList, parsedInput);
      return ipcResultSchema(z.array(RunHistorySummarySchema).max(RUN_HISTORY_MAX_LIMIT)).parse(
        rawResult,
      );
    },
  };
}
