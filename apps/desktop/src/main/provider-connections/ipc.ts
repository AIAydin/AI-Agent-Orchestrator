import { randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  ipcMain,
  type Dialog,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { z } from 'zod';

import { ipcResultSchema, type IpcResult } from '../../shared/application/contracts.js';
import {
  PROVIDER_CONNECTION_IPC_CHANNELS,
  ProviderConnectionCancelResultSchema,
  ProviderConnectionGetInputSchema,
  ProviderConnectionPlanInputSchema,
  ProviderConnectionPlanSchema,
  ProviderConnectionPrepareInputSchema,
  ProviderConnectionStatusSchema,
} from '../../shared/provider-connections/index.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';
import { confirmProviderConnection } from './native-confirmation.js';
import type { ProviderConnectionService } from './service.js';

type ProviderConnectionOperations = Pick<
  ProviderConnectionService,
  | 'get'
  | 'prepare'
  | 'confirm'
  | 'cancel'
  | 'discardOwner'
  | 'pauseForShutdown'
  | 'resumeAfterPause'
  | 'resetForPrivacy'
  | 'dispose'
>;

type WindowResolver = (event: IpcMainInvokeEvent) => BrowserWindow | null;

/** Strict main-frame and owner-bound IPC for provider-owned OAuth CLI flows. */
export class ProviderConnectionIpcService {
  readonly #registered: string[] = [];
  readonly #operations = new Set<Promise<unknown>>();
  readonly #owners = new WeakMap<WebContents, string>();
  readonly #trackedOwners = new Set<WebContents>();
  readonly #destroyedListeners = new Map<WebContents, () => void>();
  #paused = false;
  #disposed = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly connections: ProviderConnectionOperations,
    private readonly resolveWindow: WindowResolver = (event) =>
      BrowserWindow.fromWebContents(event.sender),
  ) {}

  public registerIpcHandlers(): void {
    this.#assertNotDisposed();
    if (this.#registered.length > 0)
      throw new Error('Provider connection IPC is already registered.');
    this.#handle(
      PROVIDER_CONNECTION_IPC_CHANNELS.get,
      z.tuple([ProviderConnectionGetInputSchema]),
      ProviderConnectionStatusSchema,
      async (_event, input) =>
        await this.connections.get(input.providerId, input.executableOverride),
    );
    this.#handle(
      PROVIDER_CONNECTION_IPC_CHANNELS.prepare,
      z.tuple([ProviderConnectionPrepareInputSchema]),
      ProviderConnectionPlanSchema,
      async (event, input) => await this.connections.prepare(this.#owner(event), input),
    );
    this.#handle(
      PROVIDER_CONNECTION_IPC_CHANNELS.confirm,
      z.tuple([ProviderConnectionPlanInputSchema]),
      ProviderConnectionStatusSchema.nullable(),
      async (event, input) => {
        const authority = this.#authority(event);
        return await this.connections.confirm(
          this.#owner(event),
          input.planId,
          async (review) =>
            await confirmProviderConnection(
              this.dialog,
              authority.parent,
              review,
              authority.assertCurrent,
            ),
          authority.assertCurrent,
        );
      },
    );
    this.#handle(
      PROVIDER_CONNECTION_IPC_CHANNELS.cancel,
      z.tuple([ProviderConnectionPlanInputSchema]),
      ProviderConnectionCancelResultSchema,
      (event, input) => {
        if (!this.connections.cancel(this.#owner(event), input.planId)) {
          throw new Error(
            'The provider connection review is missing, closed, or belongs to another window.',
          );
        }
        return { acknowledged: true } as const;
      },
    );
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    await this.connections.pauseForShutdown();
    await this.#drain();
  }

  public resumeAfterPause(): void {
    if (this.#disposed) return;
    this.connections.resumeAfterPause();
    this.#paused = false;
  }

  public async resetForPrivacy(): Promise<void> {
    this.#paused = true;
    await this.connections.resetForPrivacy();
    await this.#drain();
    this.#clearOwners();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    for (const channel of this.#registered) ipcMain.removeHandler(channel);
    this.#registered.length = 0;
    await this.connections.dispose();
    await this.#drain();
    this.#clearOwners();
    this.#disposed = true;
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    input: z.ZodType<Args>,
    output: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    ipcMain.handle(channel, async (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
      let task: Promise<IpcResult<Output>>;
      try {
        this.#assertAvailable();
        assertLiveMainFrame(event, 'Provider connection request');
        const args = input.parse(rawArgs);
        task = this.#invoke(event, args, output, operation);
      } catch (error) {
        return failure(error);
      }
      this.#operations.add(task);
      void task.finally(() => this.#operations.delete(task)).catch(() => undefined);
      return await task;
    });
    this.#registered.push(channel);
  }

  async #invoke<Args extends unknown[], Output>(
    event: IpcMainInvokeEvent,
    args: Args,
    output: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): Promise<IpcResult<Output>> {
    try {
      const value = await operation(event, ...args);
      this.#assertAvailable();
      assertLiveMainFrame(event, 'Provider connection request');
      return ipcResultSchema(output).parse({ ok: true, value });
    } catch (error) {
      return failure(error);
    }
  }

  #owner(event: IpcMainInvokeEvent): string {
    assertLiveMainFrame(event, 'Provider connection request');
    const existing = this.#owners.get(event.sender);
    if (existing !== undefined) return existing;
    const owner = randomUUID();
    this.#owners.set(event.sender, owner);
    this.#trackedOwners.add(event.sender);
    const destroyed = (): void => {
      this.connections.discardOwner(owner);
      this.#owners.delete(event.sender);
      this.#trackedOwners.delete(event.sender);
      this.#destroyedListeners.delete(event.sender);
    };
    this.#destroyedListeners.set(event.sender, destroyed);
    event.sender.once('destroyed', destroyed);
    return owner;
  }

  #authority(event: IpcMainInvokeEvent): {
    readonly parent: BrowserWindow;
    readonly assertCurrent: () => void;
  } {
    assertLiveMainFrame(event, 'Provider connection request');
    const parent = this.resolveWindow(event);
    if (parent === null || parent.isDestroyed()) {
      throw new Error('A live Artemis window is required for provider connections.');
    }
    const assertCurrent = (): void => {
      this.#assertAvailable();
      assertLiveMainFrame(event, 'Provider connection request');
      if (parent.isDestroyed() || this.resolveWindow(event) !== parent) {
        throw new Error('The originating Artemis window changed or closed.');
      }
    };
    return { parent, assertCurrent };
  }

  #clearOwners(): void {
    for (const sender of this.#trackedOwners) {
      const listener = this.#destroyedListeners.get(sender);
      if (listener !== undefined && !sender.isDestroyed())
        sender.removeListener('destroyed', listener);
      const owner = this.#owners.get(sender);
      if (owner !== undefined) this.connections.discardOwner(owner);
    }
    this.#trackedOwners.clear();
    this.#destroyedListeners.clear();
  }

  async #drain(): Promise<void> {
    while (this.#operations.size > 0) await Promise.allSettled([...this.#operations]);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error('Provider connection IPC has been disposed.');
  }

  #assertAvailable(): void {
    this.#assertNotDisposed();
    if (this.#paused) throw new Error('Provider connections are paused.');
  }
}

function failure<Output>(error: unknown): IpcResult<Output> {
  const validation = error instanceof z.ZodError;
  return {
    ok: false,
    error: {
      code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
      message: validation
        ? 'Artemis rejected an invalid provider connection request.'
        : error instanceof Error
          ? error.message.slice(0, 4_096)
          : 'The provider connection operation failed.',
    },
  };
}
