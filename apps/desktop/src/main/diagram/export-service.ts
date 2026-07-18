import { createHash } from 'node:crypto';
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
type DiagramExportAudit = (
  action: 'diagram-svg',
  outcome: 'allowed' | 'denied' | 'failed',
  metadata: Record<string, unknown>,
) => void;

export class DiagramExportService {
  public constructor(
    private readonly dialog: Pick<Dialog, 'showSaveDialog'>,
    private readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = ipcMain,
    private readonly writer: DiagramWriter = writeFile,
    private readonly audit: DiagramExportAudit = () => undefined,
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
          if (selection.canceled || !selection.filePath) {
            this.audit('diagram-svg', 'denied', { reason: 'native-save-cancelled' });
            return { ok: true, value: null };
          }
          const result = DiagramSvgExportResultSchema.parse({
            fileName: basename(selection.filePath),
          });
          this.audit('diagram-svg', 'allowed', exportEvidence(input.svg));
          await this.writer(selection.filePath, `${input.svg}\n`, {
            mode: 0o600,
          });
          assertCurrent(event, parent);
          return {
            ok: true,
            value: result,
          };
        } catch (error) {
          try {
            this.audit('diagram-svg', 'failed', {
              reason: 'validation-confirmation-audit-or-write-failed',
            });
          } catch {
            // The required allowed audit already failed closed before any file write.
          }
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

function exportEvidence(svg: string): Record<string, unknown> {
  return {
    format: 'svg',
    byteLength: Buffer.byteLength(svg, 'utf8'),
    contentSha256: createHash('sha256').update(svg).digest('hex'),
  };
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
