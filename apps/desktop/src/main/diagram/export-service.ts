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
  DIAGRAM_IPC_CHANNELS,
  DiagramSvgExportInputSchema,
  DiagramSvgExportResultSchema,
  type DiagramSvgExportResult,
} from '../../shared/diagram/contracts.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';
import { assertSafeDiagramSvg } from './svg-policy.js';

type DiagramWriter = (path: string, data: string, options: { mode: number }) => Promise<void>;

export class DiagramExportService {
  public constructor(
    private readonly dialog: Pick<Dialog, 'showSaveDialog'>,
    private readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = ipcMain,
    private readonly writer: DiagramWriter = writeFile,
  ) {}

  public registerIpcHandler(): void {
    this.ipc.handle(
      DIAGRAM_IPC_CHANNELS.exportSvg,
      async (event, rawInput: unknown): Promise<IpcResult<DiagramSvgExportResult>> => {
        try {
          const input = DiagramSvgExportInputSchema.parse(rawInput);
          const parent = requireParent(event);
          assertSafeDiagramSvg(input.svg);
          const selection = await this.dialog.showSaveDialog(parent, {
            title: 'Export Mermaid diagram',
            defaultPath: input.fileName,
            filters: [{ name: 'SVG image', extensions: ['svg'] }],
          });
          assertCurrent(event, parent);
          if (selection.canceled || !selection.filePath) return { ok: true, value: null };
          const result = DiagramSvgExportResultSchema.parse({
            fileName: basename(selection.filePath),
          });
          await this.writer(selection.filePath, `${input.svg}\n`, {
            mode: 0o600,
          });
          assertCurrent(event, parent);
          return {
            ok: true,
            value: result,
          };
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'OPERATION_FAILED',
              message:
                error instanceof Error ? error.message : 'The diagram could not be exported.',
            },
          };
        }
      },
    );
  }

  public dispose(): void {
    this.ipc.removeHandler(DIAGRAM_IPC_CHANNELS.exportSvg);
  }
}

function requireParent(event: IpcMainInvokeEvent): BrowserWindow {
  assertLiveMainFrame(event, 'Diagram export');
  const parent = BrowserWindow.fromWebContents(event.sender);
  if (parent === null || parent.isDestroyed())
    throw new Error('Diagram export requires a live window.');
  return parent;
}

function assertCurrent(event: IpcMainInvokeEvent, parent: BrowserWindow): void {
  assertLiveMainFrame(event, 'Diagram export');
  if (parent.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== parent) {
    throw new Error('The diagram window changed or closed.');
  }
}
