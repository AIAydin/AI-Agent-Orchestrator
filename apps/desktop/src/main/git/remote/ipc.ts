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
  GIT_REMOTE_IPC_CHANNELS,
  GitHubCiPlanViewSchema,
  GitHubCiPrepareInputSchema,
  GitHubCiResultViewSchema,
  GitHubPullRequestPlanViewSchema,
  GitHubPullRequestPrepareInputSchema,
  GitHubPullRequestResultViewSchema,
  GitHubStatusPlanViewSchema,
  GitHubStatusPrepareInputSchema,
  GitHubStatusResultViewSchema,
  GitRemoteInspectInputSchema,
  GitRemoteInspectViewSchema,
  GitRemotePlanCancelInputSchema,
  GitRemotePlanCancelResultSchema,
  GitRemotePlanConfirmationInputSchema,
  GitRemotePushPlanViewSchema,
  GitRemotePushPrepareInputSchema,
  GitRemotePushResultViewSchema,
} from '../../../shared/git/remote/index.js';
import { createNativeOutboundConfirmation } from '../../outbound/native-confirmation.js';
import type { GitRemoteDeliveryService } from './service.js';

export type GitRemoteDeliveryOperations = Pick<
  GitRemoteDeliveryService,
  | 'inspect'
  | 'cancelPlan'
  | 'preparePush'
  | 'confirmPush'
  | 'prepareGitHubStatus'
  | 'confirmGitHubStatus'
  | 'preparePullRequest'
  | 'confirmPullRequest'
  | 'prepareCi'
  | 'confirmCi'
  | 'discardOwner'
  | 'resetForPrivacy'
  | 'pauseForShutdown'
  | 'resumeAfterPrivacyReset'
  | 'dispose'
>;

export interface GitRemoteIpcAuditSink {
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

type WindowResolver = (event: IpcMainInvokeEvent) => BrowserWindow | null;

/** Strict main-frame, owner-bound IPC and native-confirmation boundary for remote delivery. */
export class GitRemoteDeliveryIpcService {
  readonly #registeredChannels: string[] = [];
  readonly #operations = new Set<Promise<unknown>>();
  readonly #owners = new WeakMap<WebContents, string>();
  readonly #trackedOwners = new Set<WebContents>();
  readonly #destroyedListeners = new Map<WebContents, () => void>();
  #paused = false;
  #disposed = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly delivery: GitRemoteDeliveryOperations,
    private readonly audit: GitRemoteIpcAuditSink,
    private readonly resolveWindow: WindowResolver = (event) =>
      BrowserWindow.fromWebContents(event.sender),
  ) {}

  public registerIpcHandlers(): void {
    this.#assertNotDisposed();
    if (this.#registeredChannels.length > 0) {
      throw new Error('Git remote-delivery IPC handlers are already registered.');
    }
    this.#handle(
      GIT_REMOTE_IPC_CHANNELS.inspect,
      z.tuple([GitRemoteInspectInputSchema]),
      GitRemoteInspectViewSchema,
      async (_event, input) => await this.delivery.inspect(input),
    );
    this.#handle(
      GIT_REMOTE_IPC_CHANNELS.cancelPlan,
      z.tuple([GitRemotePlanCancelInputSchema]),
      GitRemotePlanCancelResultSchema,
      async (event, input) => await this.delivery.cancelPlan(this.#owner(event), input.planId),
    );
    this.#handle(
      GIT_REMOTE_IPC_CHANNELS.preparePush,
      z.tuple([GitRemotePushPrepareInputSchema]),
      GitRemotePushPlanViewSchema,
      async (event, input) => await this.delivery.preparePush(this.#owner(event), input),
    );
    this.#handle(
      GIT_REMOTE_IPC_CHANNELS.confirmPush,
      z.tuple([GitRemotePlanConfirmationInputSchema]),
      GitRemotePushResultViewSchema.nullable(),
      async (event, input) =>
        await this.delivery.confirmPush(
          this.#owner(event),
          input.planId,
          this.#confirmation(event),
        ),
    );
    this.#handle(
      GIT_REMOTE_IPC_CHANNELS.prepareGitHubStatus,
      z.tuple([GitHubStatusPrepareInputSchema]),
      GitHubStatusPlanViewSchema,
      async (event, input) => await this.delivery.prepareGitHubStatus(this.#owner(event), input),
    );
    this.#handle(
      GIT_REMOTE_IPC_CHANNELS.confirmGitHubStatus,
      z.tuple([GitRemotePlanConfirmationInputSchema]),
      GitHubStatusResultViewSchema.nullable(),
      async (event, input) =>
        await this.delivery.confirmGitHubStatus(
          this.#owner(event),
          input.planId,
          this.#confirmation(event),
        ),
    );
    this.#handle(
      GIT_REMOTE_IPC_CHANNELS.preparePullRequest,
      z.tuple([GitHubPullRequestPrepareInputSchema]),
      GitHubPullRequestPlanViewSchema,
      async (event, input) => await this.delivery.preparePullRequest(this.#owner(event), input),
    );
    this.#handle(
      GIT_REMOTE_IPC_CHANNELS.confirmPullRequest,
      z.tuple([GitRemotePlanConfirmationInputSchema]),
      GitHubPullRequestResultViewSchema.nullable(),
      async (event, input) =>
        await this.delivery.confirmPullRequest(
          this.#owner(event),
          input.planId,
          this.#confirmation(event),
        ),
    );
    this.#handle(
      GIT_REMOTE_IPC_CHANNELS.prepareCi,
      z.tuple([GitHubCiPrepareInputSchema]),
      GitHubCiPlanViewSchema,
      async (event, input) => await this.delivery.prepareCi(this.#owner(event), input),
    );
    this.#handle(
      GIT_REMOTE_IPC_CHANNELS.confirmCi,
      z.tuple([GitRemotePlanConfirmationInputSchema]),
      GitHubCiResultViewSchema.nullable(),
      async (event, input) =>
        await this.delivery.confirmCi(this.#owner(event), input.planId, this.#confirmation(event)),
    );
  }

  public async resetForPrivacy(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    await this.delivery.resetForPrivacy();
    await this.#drain();
    this.#clearOwners();
  }

  public async pauseForDataMutation(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    if (this.#operations.size > 0) {
      this.#paused = false;
      throw new Error('Wait for every Git remote-delivery operation before changing worktrees.');
    }
    try {
      await this.delivery.resetForPrivacy();
      this.#clearOwners();
    } catch (error) {
      this.#paused = false;
      throw error;
    }
  }

  public async pauseForShutdown(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    await this.delivery.pauseForShutdown();
    await this.#drain();
    this.#clearOwners();
  }

  public resumeAfterPrivacyReset(): void {
    if (this.#disposed) return;
    this.delivery.resumeAfterPrivacyReset();
    this.#paused = false;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    await this.delivery.dispose();
    await this.#drain();
    this.#clearOwners();
  }

  #confirmation(event: IpcMainInvokeEvent) {
    const ownerId = this.#owner(event);
    const parent = this.#requireLiveWindow(event);
    const assertCurrent = (): void => {
      this.#assertLiveMainFrame(event);
      if (
        this.#owners.get(event.sender) !== ownerId ||
        parent.isDestroyed() ||
        this.resolveWindow(event) !== parent
      ) {
        throw new Error('The originating Forgeboard window changed during remote approval.');
      }
    };
    return createNativeOutboundConfirmation({
      assertCurrent,
      show: async (options) => (await this.dialog.showMessageBox(parent, options)).response,
    });
  }

  #owner(event: IpcMainInvokeEvent): string {
    this.#assertLiveMainFrame(event);
    const existing = this.#owners.get(event.sender);
    if (existing !== undefined) return existing;
    const owner = event.sender;
    const ownerId = `git-remote-window:${String(owner.id)}:${randomUUID()}`;
    this.#owners.set(owner, ownerId);
    this.#trackedOwners.add(owner);
    const destroyed = () => {
      this.#owners.delete(owner);
      this.#trackedOwners.delete(owner);
      this.#destroyedListeners.delete(owner);
      if (!this.#disposed) this.delivery.discardOwner(ownerId);
    };
    this.#destroyedListeners.set(owner, destroyed);
    owner.once('destroyed', destroyed);
    return ownerId;
  }

  #clearOwners(): void {
    for (const owner of this.#trackedOwners) {
      this.#owners.delete(owner);
      const listener = this.#destroyedListeners.get(owner);
      if (listener !== undefined) owner.removeListener('destroyed', listener);
      this.#destroyedListeners.delete(owner);
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
        this.#track(this.#invoke(event, rawArgs, inputSchema, outputSchema, operation)),
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
        validation,
        errorKind: error instanceof Error ? error.name.slice(0, 128) : 'unknown-error',
      });
      const result = {
        ok: false as const,
        error: {
          code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message: validation
            ? 'Forgeboard rejected an invalid remote-delivery request.'
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
      throw new Error('A live Forgeboard window is required for remote delivery.');
    }
    return parent;
  }

  #assertLiveMainFrame(event: IpcMainInvokeEvent): void {
    if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Remote delivery is allowed only from a live main Forgeboard frame.');
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error('The Git remote-delivery IPC service is disposed.');
  }

  #assertAvailable(): void {
    this.#assertNotDisposed();
    if (this.#paused) throw new Error('Git remote delivery is paused for a local-data operation.');
  }

  #track<Output>(operation: Promise<Output>): Promise<Output> {
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
      this.audit.appendAudit('git-remote-delivery', action, outcome, metadata);
    } catch {
      // Remote delivery remains fail-closed if optional audit recording is unavailable.
    }
  }
}

function rendererSafeErrorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  const pathBearing =
    /(?:^|[\s"'(=])(?:file:\/\/|~[\\/]|\/[A-Za-z0-9._~!$&+,;=:@%/-]+|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/iu.test(
      message,
    );
  const secretBearing =
    /(?:\b(?:authorization|proxy-authorization)\s*[:=]|\b(?:api[-_ ]?key|client[-_ ]?secret|password|passwd|secret|token)\s*[:=]\s*\S|\bbearer\s+\S|\bgh[pousr]_[A-Za-z0-9_]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu.test(
      message,
    );
  if (
    message === '' ||
    message.length > 512 ||
    pathBearing ||
    secretBearing ||
    [...message].some((character) => (character.codePointAt(0) ?? 0) <= 31)
  ) {
    return 'Remote delivery could not verify the exact current source or destination. Refresh and try again.';
  }
  return message;
}
