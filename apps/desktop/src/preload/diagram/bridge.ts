import { z } from 'zod';

import type { ForgeboardApi } from '../../shared/api.js';
import type { IpcResult } from '../../shared/application/contracts.js';
import {
  DIAGRAM_IPC_CHANNELS,
  DiagramSvgExportInputSchema,
  DiagramSvgExportResultSchema,
} from '../../shared/diagram/contracts.js';

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createDiagramApi(invoke: Invoke): ForgeboardApi['diagram'] {
  return {
    exportSvg: async (input) => {
      const result = await invoke(
        DIAGRAM_IPC_CHANNELS.exportSvg,
        DiagramSvgExportInputSchema.parse(input),
      );
      return ipcResultSchema(DiagramSvgExportResultSchema).parse(result);
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
