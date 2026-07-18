import type { ForgeboardApi } from '../../shared/api.js';
import { z } from 'zod';
import {
  UPDATE_IPC_CHANNELS,
  UpdateCancelResultSchema,
  UpdateCheckInputSchema,
  UpdateCheckResultSchema,
  UpdateOpenReleaseInputSchema,
} from '../../shared/updates/contracts.js';
import { ipcResultSchema } from '../../shared/application/contracts.js';

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createUpdatesApi(invoke: Invoke): ForgeboardApi['updates'] {
  return {
    check: async (input) =>
      ipcResultSchema(UpdateCheckResultSchema.nullable()).parse(
        await invoke(UPDATE_IPC_CHANNELS.check, UpdateCheckInputSchema.parse(input)),
      ),
    cancel: async () =>
      ipcResultSchema(UpdateCancelResultSchema).parse(await invoke(UPDATE_IPC_CHANNELS.cancel)),
    openRelease: async (input) =>
      ipcResultSchema(z.boolean()).parse(
        await invoke(UPDATE_IPC_CHANNELS.openRelease, UpdateOpenReleaseInputSchema.parse(input)),
      ),
  };
}
