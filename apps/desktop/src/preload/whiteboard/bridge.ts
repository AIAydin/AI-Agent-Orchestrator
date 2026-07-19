import { z } from 'zod';

import type { ForgeboardApi } from '../../shared/api.js';
import type { IpcResult } from '../../shared/application/contracts.js';
import {
  WHITEBOARD_IPC_CHANNELS,
  WhiteboardSvgExportInputSchema,
  WhiteboardSvgExportResultSchema,
} from '../../shared/whiteboard/contracts.js';

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createWhiteboardApi(invoke: Invoke): ForgeboardApi['whiteboard'] {
  return {
    exportSvg: async (input) => {
      const result = await invoke(
        WHITEBOARD_IPC_CHANNELS.exportSvg,
        WhiteboardSvgExportInputSchema.parse(input),
      );
      return ipcResultSchema(WhiteboardSvgExportResultSchema).parse(result);
    },
  };
}

function ipcResultSchema<Schema extends z.ZodTypeAny>(
  schema: Schema,
): z.ZodType<IpcResult<z.output<Schema>>> {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: schema }).strict(),
    z
      .object({
        ok: z.literal(false),
        error: z.object({ code: z.string(), message: z.string() }).strict(),
      })
      .strict(),
  ]) as z.ZodType<IpcResult<z.output<Schema>>>;
}
