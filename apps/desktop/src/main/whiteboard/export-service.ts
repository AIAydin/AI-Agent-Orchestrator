import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  BrowserWindow,
  ipcMain,
  type Dialog,
  type IpcMain,
  type IpcMainInvokeEvent,
} from 'electron';

import type { IpcResult } from '../../shared/application/contracts.js';
import {
  WHITEBOARD_IPC_CHANNELS,
  WhiteboardSvgExportInputSchema,
  WhiteboardSvgExportResultSchema,
  type WhiteboardSvgExportResult,
} from '../../shared/whiteboard/contracts.js';
import { assertSafeDiagramSvg } from '../diagram/svg-policy.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';

type WhiteboardWriter = (path: string, data: string, options: { mode: number }) => Promise<void>;

export class WhiteboardExportService {
  public constructor(
    private readonly dialog: Pick<Dialog, 'showSaveDialog'>,
    private readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = ipcMain,
    private readonly writer: WhiteboardWriter = writeFile,
  ) {}

  public registerIpcHandler(): void {
    this.ipc.handle(
      WHITEBOARD_IPC_CHANNELS.exportSvg,
      async (event, rawInput: unknown): Promise<IpcResult<WhiteboardSvgExportResult>> => {
        try {
          const input = WhiteboardSvgExportInputSchema.parse(rawInput);
          const parent = requireParent(event);
          assertSafeDiagramSvg(input.svg);
          const selection = await this.dialog.showSaveDialog(parent, {
            title: 'Export whiteboard image',
            defaultPath: input.fileName,
            filters: [{ name: 'SVG image', extensions: ['svg'] }],
          });
          assertCurrent(event, parent);
          if (selection.canceled || !selection.filePath) return { ok: true, value: null };
          const result = WhiteboardSvgExportResultSchema.parse({
            fileName: basename(selection.filePath),
          });
          await this.writer(selection.filePath, `${input.svg}\n`, { mode: 0o600 });
          assertCurrent(event, parent);
          return { ok: true, value: result };
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'OPERATION_FAILED',
              message:
                error instanceof Error ? error.message : 'The whiteboard could not be exported.',
            },
          };
        }
      },
    );
  }

  public dispose(): void {
    this.ipc.removeHandler(WHITEBOARD_IPC_CHANNELS.exportSvg);
  }
}

function requireParent(event: IpcMainInvokeEvent): BrowserWindow {
  assertLiveMainFrame(event, 'Whiteboard export');
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (parent === null || parent.isDestroyed())
    throw new Error('Whiteboard export requires a live window.');
  return parent;
}

function assertCurrent(event: IpcMainInvokeEvent, parent: BrowserWindow): void {
  assertLiveMainFrame(event, 'Whiteboard export');
  if (parent.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== parent) {
    throw new Error('The whiteboard window changed or closed.');
  }
}
