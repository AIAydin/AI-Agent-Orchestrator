import { randomUUID } from 'node:crypto';

import type {
  BrowserWindow,
  Dialog,
  IpcMain,
  IpcMainEvent,
  MessageBoxOptions,
  WebContents,
} from 'electron';

import {
  AppCloseRequestSchema,
  AppCloseResponseSchema,
  IPC_CHANNELS,
} from '../../shared/application/contracts.js';

const DEFAULT_RESPONSE_TIMEOUT_MS = 8_000;

type CloseResponseOutcome = 'saved' | 'failed' | 'timed-out' | 'disposed';

interface PendingResponse {
  readonly owner: WebContents;
  readonly resolve: (outcome: CloseResponseOutcome) => void;
  readonly timer: NodeJS.Timeout;
}

export interface CloseCoordinatorOptions {
  readonly responseTimeoutMs?: number;
}

export class CloseCoordinator {
  readonly #pendingByRequest = new Map<string, PendingResponse>();
  readonly #requestsByOwner = new Map<WebContents, Promise<boolean>>();
  readonly #responseTimeoutMs: number;
  readonly #responseListener: (event: IpcMainEvent, payload: unknown) => void;
  #disposed = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly ipc: Pick<IpcMain, 'on' | 'removeListener'>,
    options: CloseCoordinatorOptions = {},
  ) {
    this.#responseTimeoutMs = boundedTimeout(
      options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
    );
    this.#responseListener = (event, payload) => this.#receiveResponse(event, payload);
    this.ipc.on(IPC_CHANNELS.appCloseResponse, this.#responseListener);
  }

  public requestSave(window: BrowserWindow): Promise<boolean> {
    if (this.#disposed || window.isDestroyed() || window.webContents.isDestroyed()) {
      return Promise.resolve(false);
    }
    const owner = window.webContents;
    const existing = this.#requestsByOwner.get(owner);
    if (existing !== undefined) return existing;

    const request = this.#requestSave(window, owner);
    this.#requestsByOwner.set(owner, request);
    void request.finally(() => {
      if (this.#requestsByOwner.get(owner) === request) this.#requestsByOwner.delete(owner);
    });
    return request;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.ipc.removeListener(IPC_CHANNELS.appCloseResponse, this.#responseListener);
    for (const [requestId, pending] of this.#pendingByRequest) {
      this.#settle(requestId, pending, 'disposed');
    }
    this.#requestsByOwner.clear();
  }

  async #requestSave(window: BrowserWindow, owner: WebContents): Promise<boolean> {
    const request = AppCloseRequestSchema.parse({ requestId: randomUUID() });
    const response = new Promise<CloseResponseOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.#pendingByRequest.get(request.requestId);
        if (pending !== undefined) this.#settle(request.requestId, pending, 'timed-out');
      }, this.#responseTimeoutMs);
      timer.unref();
      this.#pendingByRequest.set(request.requestId, { owner, resolve, timer });
    });

    try {
      window.webContents.send(IPC_CHANNELS.appCloseRequested, request);
    } catch {
      const pending = this.#pendingByRequest.get(request.requestId);
      if (pending !== undefined) this.#settle(request.requestId, pending, 'failed');
    }

    const outcome = await response;
    if (outcome === 'saved') return true;
    if (outcome === 'disposed' || window.isDestroyed()) return false;
    return await this.#confirmCloseWithoutSaving(window, outcome);
  }

  #receiveResponse(event: IpcMainEvent, payload: unknown): void {
    const parsed = AppCloseResponseSchema.safeParse(payload);
    if (!parsed.success) return;
    const pending = this.#pendingByRequest.get(parsed.data.requestId);
    if (pending === undefined || event.sender !== pending.owner) return;
    if (event.senderFrame !== event.sender.mainFrame) return;
    this.#settle(parsed.data.requestId, pending, parsed.data.saved ? 'saved' : 'failed');
  }

  #settle(requestId: string, pending: PendingResponse, outcome: CloseResponseOutcome): void {
    if (this.#pendingByRequest.get(requestId) !== pending) return;
    this.#pendingByRequest.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
  }

  async #confirmCloseWithoutSaving(
    window: BrowserWindow,
    outcome: Extract<CloseResponseOutcome, 'failed' | 'timed-out'>,
  ): Promise<boolean> {
    const options = fallbackConfirmation(outcome);
    try {
      const decision = await this.dialog.showMessageBox(window, options);
      return decision.response === 1;
    } catch {
      return false;
    }
  }
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new Error('Close response timeout must be an integer from 1 through 60000 milliseconds.');
  }
  return value;
}

function fallbackConfirmation(
  outcome: Extract<CloseResponseOutcome, 'failed' | 'timed-out'>,
): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Unsaved work in Forgeboard',
    message: 'Forgeboard could not confirm that your latest work was saved.',
    detail:
      outcome === 'timed-out'
        ? 'Saving did not finish in time. Keep Forgeboard open and try again, or close without saving your latest changes.'
        : 'Saving your latest changes failed. Keep Forgeboard open and try again, or close without saving them.',
    buttons: ['Keep Forgeboard open', 'Close without saving'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
