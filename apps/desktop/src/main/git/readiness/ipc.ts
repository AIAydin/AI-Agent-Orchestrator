import { randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  ipcMain,
  type Dialog,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { z } from 'zod';

import { ipcResultSchema, type IpcResult } from '../../../shared/application/contracts.js';
import {
  GIT_DELIVERY_READINESS_IPC_CHANNELS,
  GitDeliveryReadinessApproveInputSchema,
  GitDeliveryReadinessApproveViewSchema,
  GitDeliveryReadinessGetInputSchema,
  GitDeliveryReadinessGetViewSchema,
  GitDeliveryReadinessPrepareInputSchema,
  GitDeliveryReadinessPrepareViewSchema,
  GitDeliveryReadinessRunInputSchema,
  GitDeliveryReadinessRunViewSchema,
} from '../../../shared/git/readiness/index.js';
import {
  DeliveryReadinessAuthorizationCancelledError,
  type DeliveryReadinessService,
} from './service.js';
import {
  deliveryCheckConfirmation,
  deliveryHumanApprovalConfirmation,
} from './native-confirmation.js';

export type GitDeliveryReadinessOperations = Pick<
  DeliveryReadinessService,
  | 'get'
  | 'prepare'
  | 'run'
  | 'reviewApproval'
  | 'approve'
  | 'stopOwner'
  | 'resetForPrivacy'
  | 'dispose'
>;

interface ReadinessAuditSink {
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

type WindowResolver = (event: IpcMainInvokeEvent) => BrowserWindow | null;

/** Main-frame and native-dialog boundary for delivery checks and durable human approval. */
export class GitDeliveryReadinessIpcService {
  readonly #registeredChannels: string[] = [];
  readonly #operations = new Set<Promise<unknown>>();
  readonly #ownerTokens = new WeakMap<WebContents, string>();
  readonly #trackedOwners = new Set<WebContents>();
  readonly #ownerDestroyedListeners = new Map<WebContents, () => void>();
  #paused = false;
  #disposed = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly readiness: GitDeliveryReadinessOperations,
    private readonly audit: ReadinessAuditSink,
    private readonly resolveWindow: WindowResolver = (event) =>
      BrowserWindow.fromWebContents(event.sender),
  ) {}

  public registerIpcHandlers(): void {
    if (this.#registeredChannels.length > 0) {
      throw new Error('Delivery readiness IPC handlers are already registered.');
    }
    this.#handle(
      GIT_DELIVERY_READINESS_IPC_CHANNELS.get,
      z.tuple([GitDeliveryReadinessGetInputSchema]),
      GitDeliveryReadinessGetViewSchema,
      async (_event, input) => await this.readiness.get(input),
    );
    this.#handle(
      GIT_DELIVERY_READINESS_IPC_CHANNELS.prepare,
      z.tuple([GitDeliveryReadinessPrepareInputSchema]),
      GitDeliveryReadinessPrepareViewSchema,
      async (_event, input) => await this.readiness.prepare(input),
    );
    this.#handle(
      GIT_DELIVERY_READINESS_IPC_CHANNELS.run,
      z.tuple([GitDeliveryReadinessRunInputSchema]),
      GitDeliveryReadinessRunViewSchema.nullable(),
      async (event, input) => await this.#run(event, input),
    );
    this.#handle(
      GIT_DELIVERY_READINESS_IPC_CHANNELS.approve,
      z.tuple([GitDeliveryReadinessApproveInputSchema]),
      GitDeliveryReadinessApproveViewSchema.nullable(),
      async (event, input) => await this.#approve(event, input),
    );
  }

  public pauseForDataMutation(): void {
    this.#assertNotDisposed();
    this.#paused = true;
    if (this.#operations.size > 0) {
      this.#paused = false;
      throw new Error('Wait for every delivery-readiness operation before changing worktrees.');
    }
  }

  public async resetForPrivacy(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    await this.readiness.resetForPrivacy();
    await this.#drain();
    this.#clearOwners();
  }

  public async pauseForShutdown(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    await this.readiness.resetForPrivacy();
    await this.#drain();
    this.#clearOwners();
  }

  public resumeAfterPrivacyReset(): void {
    if (!this.#disposed) this.#paused = false;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    await this.readiness.dispose();
    await this.#drain();
    this.#clearOwners();
  }

  async #run(event: IpcMainInvokeEvent, input: z.infer<typeof GitDeliveryReadinessRunInputSchema>) {
    const ownerId = this.#owner(event);
    try {
      return await this.readiness.run(input, {
        ownerId,
        authorize: async (disclosure) => {
          const parent = this.#requireLiveWindow(event);
          const decision = await this.dialog.showMessageBox(
            parent,
            deliveryCheckConfirmation(disclosure),
          );
          this.#assertCurrentWindow(event, parent);
          if (decision.response !== 1) {
            throw new DeliveryReadinessAuthorizationCancelledError();
          }
        },
      });
    } catch (error) {
      if (error instanceof DeliveryReadinessAuthorizationCancelledError) return null;
      throw error;
    }
  }

  async #approve(
    event: IpcMainInvokeEvent,
    input: z.infer<typeof GitDeliveryReadinessApproveInputSchema>,
  ) {
    const review = await this.readiness.reviewApproval(input);
    const parent = this.#requireLiveWindow(event);
    const decision = await this.dialog.showMessageBox(
      parent,
      deliveryHumanApprovalConfirmation(review),
    );
    this.#assertCurrentWindow(event, parent);
    if (decision.response !== 1) {
      this.#safeAudit('approve-human', 'denied', {
        readinessId: review.readinessId,
        projectId: review.target.projectId,
        runId: review.target.runId,
        sourceFingerprint: review.sourceFingerprint.digest,
        evidenceFingerprint: review.evidenceFingerprint,
        reason: 'native-confirmation-cancelled',
      });
      return null;
    }
    return await this.readiness.approve(input, review.evidenceFingerprint);
  }

  #owner(event: IpcMainInvokeEvent): string {
    this.#assertLiveMainFrame(event);
    const existing = this.#ownerTokens.get(event.sender);
    if (existing !== undefined) return existing;
    const ownerId = `delivery-window:${randomUUID()}`;
    const owner = event.sender;
    this.#ownerTokens.set(owner, ownerId);
    this.#trackedOwners.add(owner);
    const destroyedListener = () => {
      this.#ownerTokens.delete(owner);
      this.#trackedOwners.delete(owner);
      this.#ownerDestroyedListeners.delete(owner);
      if (this.#disposed) return;
      void this.#trackOperation(
        this.readiness.stopOwner(ownerId).catch(() => {
          this.#safeAudit('owner-close', 'failed', { ownerId });
        }),
      );
    };
    this.#ownerDestroyedListeners.set(owner, destroyedListener);
    owner.once('destroyed', destroyedListener);
    return ownerId;
  }

  #clearOwners(): void {
    for (const owner of this.#trackedOwners) {
      this.#ownerTokens.delete(owner);
      const destroyedListener = this.#ownerDestroyedListeners.get(owner);
      if (destroyedListener !== undefined) owner.removeListener('destroyed', destroyedListener);
      this.#ownerDestroyedListeners.delete(owner);
    }
    this.#trackedOwners.clear();
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(
      channel,
      (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> =>
        this.#trackOperation(this.#invoke(event, rawArgs, inputSchema, outputSchema, operation)),
    );
  }

  async #invoke<Args extends unknown[], Output>(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): Promise<IpcResult<Output>> {
    try {
      this.#assertAvailable();
      this.#assertLiveMainFrame(event);
      const args = inputSchema.parse(rawArgs);
      const value = outputSchema.parse(await operation(event, ...args));
      this.#assertAvailable();
      this.#assertLiveMainFrame(event);
      const result: IpcResult<Output> = { ok: true, value };
      ipcResultSchema(outputSchema).parse(result);
      return result;
    } catch (error) {
      const validation = error instanceof z.ZodError;
      this.#safeAudit('ipc-request', 'failed', {
        reason: localErrorMessage(error),
        validation,
      });
      const result = {
        ok: false as const,
        error: {
          code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message: validation
            ? 'Artemis rejected an invalid delivery-readiness request.'
            : rendererSafeErrorMessage(error),
        },
      };
      ipcResultSchema(outputSchema).parse(result);
      return result;
    }
  }

  #requireLiveWindow(event: IpcMainInvokeEvent): BrowserWindow {
    this.#assertAvailable();
    this.#assertLiveMainFrame(event);
    const parent = this.resolveWindow(event);
    if (parent === null || parent.isDestroyed()) {
      throw new Error('A live Artemis window is required for delivery readiness.');
    }
    return parent;
  }

  #assertCurrentWindow(event: IpcMainInvokeEvent, expected: BrowserWindow): void {
    this.#assertAvailable();
    this.#assertLiveMainFrame(event);
    if (expected.isDestroyed() || this.resolveWindow(event) !== expected) {
      throw new Error('The originating Artemis window changed during readiness approval.');
    }
  }

  #assertLiveMainFrame(event: IpcMainInvokeEvent): void {
    if (event.sender.isDestroyed()) throw new Error('The originating Artemis window is closed.');
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Delivery readiness is allowed only from the main Artemis frame.');
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error('The delivery readiness IPC service has been disposed.');
  }

  #assertAvailable(): void {
    this.#assertNotDisposed();
    if (this.#paused) throw new Error('Delivery readiness is paused for a local-data operation.');
  }

  #trackOperation<Output>(operation: Promise<Output>): Promise<Output> {
    this.#operations.add(operation);
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation),
    );
    return operation;
  }

  async #drain(): Promise<void> {
    while (this.#operations.size > 0) await Promise.allSettled([...this.#operations]);
  }

  #safeAudit(
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void {
    try {
      this.audit.appendAudit('git-delivery-readiness', action, outcome, metadata);
    } catch {
      // Cancellation and cleanup remain fail-closed if optional audit recording is unavailable.
    }
  }
}

function localErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() === '' ? 'Unknown delivery-readiness failure.' : message).slice(0, 4_096);
}

function rendererSafeErrorMessage(error: unknown): string {
  const message = localErrorMessage(error);
  const pathBearing =
    /(?:^|[\s"'(=])(?:\/[A-Za-z0-9._~!$&+,;=:@%/-]+|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/u.test(message);
  if (pathBearing || message.length > 512 || containsControlCharacter(message)) {
    return 'Delivery readiness could not verify the current source or command. Refresh and try again.';
  }
  return message;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? -1;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
