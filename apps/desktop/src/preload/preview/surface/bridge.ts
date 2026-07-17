import type { IpcRenderer } from 'electron';
import { z } from 'zod';

import { ipcResultSchema, type IpcResult } from '../../../shared/application/contracts.js';
import {
  PREVIEW_SURFACE_IPC_CHANNELS,
  PreviewConsoleViewSchema,
  PreviewScreenshotResultSchema,
  PreviewSurfaceBoundsInputSchema,
  PreviewSurfaceCreateInputSchema,
  PreviewSurfaceEventSchema,
  PreviewSurfaceHistoryInputSchema,
  PreviewSurfaceNavigateInputSchema,
  PreviewSurfaceTargetSchema,
  PreviewSurfaceViewSchema,
  type PreviewSurfaceApi,
} from '../../../shared/preview/surface/index.js';

export function createPreviewSurfaceApi(ipcRenderer: IpcRenderer): PreviewSurfaceApi {
  const invoke = async <Schema extends z.ZodTypeAny>(
    channel: string,
    schema: Schema,
    input: unknown,
  ): Promise<IpcResult<z.output<Schema>>> => {
    const result: unknown = await ipcRenderer.invoke(channel, input);
    return ipcResultSchema(schema).parse(result);
  };
  return {
    create: async (input) =>
      await invoke(
        PREVIEW_SURFACE_IPC_CHANNELS.create,
        PreviewSurfaceViewSchema,
        PreviewSurfaceCreateInputSchema.parse(input),
      ),
    setBounds: async (input) =>
      await invoke(
        PREVIEW_SURFACE_IPC_CHANNELS.bounds,
        PreviewSurfaceViewSchema,
        PreviewSurfaceBoundsInputSchema.parse(input),
      ),
    navigate: async (input) =>
      await invoke(
        PREVIEW_SURFACE_IPC_CHANNELS.navigate,
        PreviewSurfaceViewSchema,
        PreviewSurfaceNavigateInputSchema.parse(input),
      ),
    reload: async (input) =>
      await invoke(
        PREVIEW_SURFACE_IPC_CHANNELS.reload,
        PreviewSurfaceViewSchema,
        PreviewSurfaceTargetSchema.parse(input),
      ),
    history: async (input) =>
      await invoke(
        PREVIEW_SURFACE_IPC_CHANNELS.history,
        PreviewSurfaceViewSchema,
        PreviewSurfaceHistoryInputSchema.parse(input),
      ),
    getConsole: async (input) =>
      await invoke(
        PREVIEW_SURFACE_IPC_CHANNELS.console,
        PreviewConsoleViewSchema,
        PreviewSurfaceTargetSchema.parse(input),
      ),
    screenshot: async (input) =>
      await invoke(
        PREVIEW_SURFACE_IPC_CHANNELS.screenshot,
        PreviewScreenshotResultSchema,
        PreviewSurfaceTargetSchema.parse(input),
      ),
    openExternal: async (input) =>
      await invoke(
        PREVIEW_SURFACE_IPC_CHANNELS.openExternal,
        z.boolean(),
        PreviewSurfaceTargetSchema.parse(input),
      ),
    close: async (input) =>
      await invoke(
        PREVIEW_SURFACE_IPC_CHANNELS.close,
        z.boolean(),
        PreviewSurfaceTargetSchema.parse(input),
      ),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        const parsed = PreviewSurfaceEventSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(PREVIEW_SURFACE_IPC_CHANNELS.event, handler);
      return () => ipcRenderer.removeListener(PREVIEW_SURFACE_IPC_CHANNELS.event, handler);
    },
  };
}
