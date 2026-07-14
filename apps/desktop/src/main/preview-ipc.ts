import { ipcMain, webContents, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';

import {
  IPC_CHANNELS,
  PreviewEventEnvelopeSchema,
  PreviewNavigateInputSchema,
  PreviewNodeKeySchema,
  PreviewStartInputSchema,
  type AppSettings,
  type IpcResult,
  type PreviewEventEnvelope,
} from '../shared/contracts.js';
import { PreviewRuntime } from './preview-runtime.js';
import type { LocalStore } from './storage.js';

export class PreviewIpcService {
  readonly #runtime: PreviewRuntime;
  readonly #registeredChannels: string[] = [];
  readonly #trackedOwners = new Set<number>();
  #disposed = false;

  constructor(store: LocalStore, getSettings: () => AppSettings) {
    this.#runtime = new PreviewRuntime(store, getSettings, (ownerId, event) =>
      this.#send(ownerId, event),
    );
  }

  registerIpcHandlers(): void {
    this.#handle(IPC_CHANNELS.previewsStart, z.tuple([PreviewStartInputSchema]), (event, input) =>
      this.#runtime.start(event.sender.id, input),
    );
    this.#handle(IPC_CHANNELS.previewsRestart, z.tuple([PreviewStartInputSchema]), (event, input) =>
      this.#runtime.restart(event.sender.id, input),
    );
    this.#handle(IPC_CHANNELS.previewsStop, z.tuple([PreviewNodeKeySchema]), (event, input) =>
      this.#runtime.stop(event.sender.id, input),
    );
    this.#handle(IPC_CHANNELS.previewsGet, z.tuple([PreviewNodeKeySchema]), (event, input) =>
      this.#runtime.get(event.sender.id, input),
    );
    this.#handle(
      IPC_CHANNELS.previewsNavigate,
      z.tuple([PreviewNavigateInputSchema]),
      (event, input) => this.#runtime.validateNavigation(event.sender.id, input),
    );
  }

  isAllowedFrameNavigation(candidate: string): boolean {
    return this.#runtime.isAllowedFrameNavigation(candidate);
  }

  resetForPrivacy(): Promise<void> {
    return this.#runtime.resetForPrivacy();
  }

  resumeAfterPrivacyReset(): void {
    this.#runtime.resumeAfterPrivacyReset();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    this.#runtime.dispose();
  }

  #send(ownerId: number, event: PreviewEventEnvelope): void {
    const owner = webContents.fromId(ownerId);
    if (!owner || owner.isDestroyed()) return;
    owner.send(IPC_CHANNELS.previewsEvent, PreviewEventEnvelopeSchema.parse(event));
  }

  #trackOwner(event: IpcMainInvokeEvent): void {
    const ownerId = event.sender.id;
    if (this.#trackedOwners.has(ownerId)) return;
    this.#trackedOwners.add(ownerId);
    event.sender.once('destroyed', () => {
      this.#trackedOwners.delete(ownerId);
      void this.#runtime.stopOwner(ownerId);
    });
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    schema: z.ZodType<Args>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(channel, async (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
      try {
        if (this.#disposed) throw new Error('The preview runtime has been disposed.');
        this.#trackOwner(event);
        const args = schema.parse(rawArgs);
        return { ok: true, value: await operation(event, ...args) };
      } catch (error) {
        const validation = error instanceof z.ZodError;
        return {
          ok: false,
          error: {
            code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
            message: validation
              ? 'Forgeboard rejected an invalid preview request.'
              : error instanceof Error
                ? error.message
                : 'The preview operation failed.',
          },
        };
      }
    });
  }
}
