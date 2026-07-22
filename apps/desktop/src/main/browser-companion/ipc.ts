import { BrowserWindow, ipcMain, type Dialog, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';

import {
  BROWSER_COMPANION_IPC_CHANNELS,
  BrowserCompanionFrameRequestSchema,
  BrowserCompanionInputSchema,
  BrowserCompanionNavigationInputSchema,
  BrowserCompanionNodeKeySchema,
  BrowserCompanionOpenInputSchema,
  BrowserCompanionViewportInputSchema,
  type BrowserCompanionNodeKey,
  type BrowserCompanionFrame,
  type BrowserCompanionSnapshot,
  type BrowserCompanionStatus,
} from '../../shared/browser-companion/contracts.js';
import type { IpcResult } from '../../shared/application/contracts.js';
import type { BrowserCompanionService } from './service.js';

export class BrowserCompanionIpcService {
  readonly #channels: string[] = [];

  constructor(
    private readonly service: BrowserCompanionService,
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
  ) {}

  registerIpcHandlers(): void {
    this.#handle(
      BROWSER_COMPANION_IPC_CHANNELS.open,
      BrowserCompanionOpenInputSchema,
      async (input, event) => {
        const status = await this.service.open(input);
        const parent = BrowserWindow.fromWebContents(event.sender);
        if (status.state === 'connected' && parent !== null && !parent.isDestroyed()) {
          parent.show();
          parent.focus();
        }
        return status;
      },
    );
    this.#handle(
      BROWSER_COMPANION_IPC_CHANNELS.status,
      BrowserCompanionNodeKeySchema,
      async (input) => await this.service.status(input),
    );
    this.#handle(
      BROWSER_COMPANION_IPC_CHANNELS.focus,
      BrowserCompanionNodeKeySchema,
      async (input) => await this.service.focus(input),
    );
    this.#handle(
      BROWSER_COMPANION_IPC_CHANNELS.close,
      BrowserCompanionNodeKeySchema,
      async (input) => await this.service.close(input),
    );
    ipcMain.handle(
      BROWSER_COMPANION_IPC_CHANNELS.clear,
      async (event: IpcMainInvokeEvent, rawInput): Promise<IpcResult<BrowserCompanionStatus>> => {
        try {
          requireMainFrame(event);
          const input = BrowserCompanionNodeKeySchema.parse(rawInput);
          const parent = BrowserWindow.fromWebContents(event.sender);
          if (parent === null || parent.isDestroyed()) throw new Error('Forgeboard window closed.');
          const decision = await this.dialog.showMessageBox(parent, {
            type: 'warning',
            title: 'Clear saved Chrome sign-in data?',
            message: 'This will close the connected Chrome window and erase its dedicated profile.',
            detail:
              'Saved cookies, website storage, and sign-ins for this preview cannot be recovered.',
            buttons: ['Cancel', 'Clear browser data'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (decision.response !== 1) return { ok: true, value: await this.service.status(input) };
          requireMainFrame(event);
          return { ok: true, value: await this.service.clear(input) };
        } catch (error) {
          return {
            ok: false,
            error: {
              code: error instanceof z.ZodError ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
              message: error instanceof Error ? error.message : 'Could not clear Chrome data.',
            },
          };
        }
      },
    );
    this.#channels.push(BROWSER_COMPANION_IPC_CHANNELS.clear);
    this.#handle<BrowserCompanionNodeKey, BrowserCompanionSnapshot | null>(
      BROWSER_COMPANION_IPC_CHANNELS.snapshot,
      BrowserCompanionNodeKeySchema,
      async (input) => await this.service.snapshot(input),
    );
    this.#handle<z.infer<typeof BrowserCompanionFrameRequestSchema>, BrowserCompanionFrame | null>(
      BROWSER_COMPANION_IPC_CHANNELS.frame,
      BrowserCompanionFrameRequestSchema,
      (input) => this.service.frame(input),
    );
    this.#handle(
      BROWSER_COMPANION_IPC_CHANNELS.viewport,
      BrowserCompanionViewportInputSchema,
      async (input) => {
        await this.service.setViewport(input);
        return null;
      },
    );
    this.#handle(
      BROWSER_COMPANION_IPC_CHANNELS.input,
      BrowserCompanionInputSchema,
      async (input) => {
        await this.service.dispatchInput(input);
        return null;
      },
    );
    this.#handle(
      BROWSER_COMPANION_IPC_CHANNELS.navigate,
      BrowserCompanionNavigationInputSchema,
      async (input) => {
        await this.service.navigate(input);
        return null;
      },
    );
  }

  async resetForPrivacy(): Promise<void> {
    await this.service.resetForPrivacy();
  }

  async pause(): Promise<void> {
    await this.service.pause();
  }

  async dispose(): Promise<void> {
    for (const channel of this.#channels) ipcMain.removeHandler(channel);
    this.#channels.length = 0;
    await this.service.dispose();
  }

  #handle<Input, Output = BrowserCompanionStatus>(
    channel: string,
    schema: z.ZodType<Input>,
    operation: (input: Input, event: IpcMainInvokeEvent) => Output | Promise<Output>,
  ): void {
    ipcMain.handle(
      channel,
      async (event: IpcMainInvokeEvent, rawInput): Promise<IpcResult<Output>> => {
        try {
          requireMainFrame(event);
          const input = schema.parse(rawInput);
          return { ok: true, value: await operation(input, event) };
        } catch (error) {
          return {
            ok: false,
            error: {
              code: error instanceof z.ZodError ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
              message:
                error instanceof Error ? error.message : 'Chrome companion operation failed.',
            },
          };
        }
      },
    );
    this.#channels.push(channel);
  }
}

function requireMainFrame(event: IpcMainInvokeEvent): void {
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Chrome companion requests require the active Forgeboard main frame.');
  }
}
