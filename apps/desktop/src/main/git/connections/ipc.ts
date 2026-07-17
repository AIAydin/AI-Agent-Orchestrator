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
  GIT_CONNECTIONS_IPC_CHANNELS,
  GitConnectionConfirmInputSchema,
  GitConnectionMutationPlanViewSchema,
  GitConnectionPlanCancelResultSchema,
  GitConnectionPlanConfirmationInputSchema,
  GitConnectionPrepareLocalInputSchema,
  GitConnectionPrepareNetworkInputSchema,
  GitConnectionPrepareRemoveInputSchema,
  GitConnectionProjectInputSchema,
  GitConnectionsViewSchema,
  GitHubCliSelectionPlanViewSchema,
  GitHubCliStatusViewSchema,
} from '../../../shared/git/connections/index.js';
import { assertLiveMainFrame } from '../../security/ipc-authority.js';
import type {
  GitHubCliRuntimeService,
  GitHubCliSelectionMutationAdmission,
} from '../github-cli/runtime.js';
import { confirmGitConnectionMutation, confirmGitHubCliSelection } from './native-confirmation.js';
import type { GitConnectionsService } from './service.js';

export type GitConnectionsOperations = Pick<
  GitConnectionsService,
  | 'list'
  | 'prepareNetwork'
  | 'prepareLocal'
  | 'prepareRemove'
  | 'confirm'
  | 'tryCancelPlan'
  | 'discardOwner'
  | 'pauseForDataMutation'
  | 'resetForPrivacy'
  | 'pauseForShutdown'
  | 'resumeAfterPrivacyReset'
  | 'dispose'
>;

export type GitHubCliRuntimeOperations = Pick<
  GitHubCliRuntimeService,
  | 'getPublicStatus'
  | 'prepareCustomSelection'
  | 'prepareAutomaticSelection'
  | 'confirmSelection'
  | 'cancelSelection'
  | 'discardOwner'
  | 'clearPendingSelections'
  | 'resetForPrivacy'
>;

export interface GitConnectionsIpcAuditSink {
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): unknown;
}

export type GitConnectionsDataOperationRunner = <Output>(
  operation: () => Output | Promise<Output>,
) => Promise<Output>;

type WindowResolver = (event: IpcMainInvokeEvent) => BrowserWindow | null;

/** Strict main-frame, owner-bound IPC boundary for local project Git connections. */
export class GitConnectionsIpcService {
  readonly #registeredChannels: string[] = [];
  readonly #operations = new Set<Promise<unknown>>();
  readonly #owners = new WeakMap<WebContents, string>();
  readonly #trackedOwners = new Set<WebContents>();
  readonly #destroyedListeners = new Map<WebContents, () => void>();
  #paused = false;
  #disposed = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>,
    private readonly connections: GitConnectionsOperations,
    private readonly githubCli: GitHubCliRuntimeOperations,
    private readonly audit: GitConnectionsIpcAuditSink,
    private readonly runDataOperation: GitConnectionsDataOperationRunner = async (operation) =>
      await operation(),
    private readonly onGitHubCliChanged: () => void | Promise<void> = () => undefined,
    private readonly resolveWindow: WindowResolver = (event) =>
      BrowserWindow.fromWebContents(event.sender),
    private readonly withGitHubCliMutationAdmission: GitHubCliSelectionMutationAdmission = async (
      operation,
    ) => await operation(),
  ) {}

  public registerIpcHandlers(): void {
    this.#assertNotDisposed();
    if (this.#registeredChannels.length > 0) {
      throw new Error('Git connections IPC handlers are already registered.');
    }
    this.#handle(
      GIT_CONNECTIONS_IPC_CHANNELS.list,
      z.tuple([GitConnectionProjectInputSchema]),
      GitConnectionsViewSchema,
      async (_event, input) => await this.connections.list(input),
    );
    this.#handle(
      GIT_CONNECTIONS_IPC_CHANNELS.prepareNetwork,
      z.tuple([GitConnectionPrepareNetworkInputSchema]),
      GitConnectionMutationPlanViewSchema,
      async (event, input) => await this.connections.prepareNetwork(this.#owner(event), input),
    );
    this.#handle(
      GIT_CONNECTIONS_IPC_CHANNELS.prepareLocal,
      z.tuple([GitConnectionPrepareLocalInputSchema]),
      GitConnectionMutationPlanViewSchema.nullable(),
      async (event, input) => {
        const selectedPath = await this.#chooseLocalRepository(event);
        if (selectedPath === null) return null;
        return await this.connections.prepareLocal(this.#owner(event), input, selectedPath);
      },
    );
    this.#handle(
      GIT_CONNECTIONS_IPC_CHANNELS.prepareRemove,
      z.tuple([GitConnectionPrepareRemoveInputSchema]),
      GitConnectionMutationPlanViewSchema,
      async (event, input) => await this.connections.prepareRemove(this.#owner(event), input),
    );
    this.#handle(
      GIT_CONNECTIONS_IPC_CHANNELS.confirm,
      z.tuple([GitConnectionConfirmInputSchema]),
      GitConnectionsViewSchema.nullable(),
      async (event, input) => {
        const authority = this.#authority(event);
        return await this.connections.confirm(
          this.#owner(event),
          input.planId,
          async (review) =>
            await confirmGitConnectionMutation(
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
      GIT_CONNECTIONS_IPC_CHANNELS.cancelPlan,
      z.tuple([GitConnectionPlanConfirmationInputSchema]),
      GitConnectionPlanCancelResultSchema,
      (event, input) => {
        const ownerId = this.#owner(event);
        const remoteCancelled = this.connections.tryCancelPlan(ownerId, input.planId);
        const cliCancelled = this.githubCli.cancelSelection(ownerId, input.planId);
        if (!remoteCancelled && !cliCancelled) {
          throw new Error('The Git connection review is missing, expired, or already closed.');
        }
        return { acknowledged: true } as const;
      },
    );
    this.#handle(
      GIT_CONNECTIONS_IPC_CHANNELS.githubCliStatus,
      z.tuple([]),
      GitHubCliStatusViewSchema,
      async () => await this.githubCli.getPublicStatus(),
    );
    this.#handle(
      GIT_CONNECTIONS_IPC_CHANNELS.githubCliRefresh,
      z.tuple([]),
      GitHubCliStatusViewSchema,
      async () => await this.githubCli.getPublicStatus(),
    );
    this.#handle(
      GIT_CONNECTIONS_IPC_CHANNELS.githubCliChoose,
      z.tuple([]),
      GitHubCliSelectionPlanViewSchema.nullable(),
      async (event) => {
        const selectedPath = await this.#chooseGitHubCli(event);
        if (selectedPath === null) return null;
        return await this.githubCli.prepareCustomSelection(this.#owner(event), selectedPath);
      },
    );
    this.#handle(
      GIT_CONNECTIONS_IPC_CHANNELS.githubCliUseAutomatic,
      z.tuple([]),
      GitHubCliSelectionPlanViewSchema,
      async (event) => await this.githubCli.prepareAutomaticSelection(this.#owner(event)),
    );
    this.#handle(
      GIT_CONNECTIONS_IPC_CHANNELS.githubCliConfirm,
      z.tuple([GitConnectionPlanConfirmationInputSchema]),
      GitHubCliStatusViewSchema.nullable(),
      async (event, input) => {
        const authority = this.#authority(event);
        const status = await this.#withSenderAbort(
          event,
          async (signal) =>
            await this.githubCli.confirmSelection(
              this.#owner(event),
              input.planId,
              async (review) =>
                await confirmGitHubCliSelection(
                  this.dialog,
                  authority.parent,
                  review,
                  authority.assertCurrent,
                ),
              signal,
              authority.assertCurrent,
              async (operation) =>
                await this.withGitHubCliMutationAdmission(async () => {
                  const result = await operation();
                  await this.onGitHubCliChanged();
                  authority.assertCurrent();
                  return result;
                }),
            ),
        );
        return status;
      },
    );
  }

  public async resetForPrivacy(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    await this.#drain();
    this.connections.resetForPrivacy();
    this.githubCli.resetForPrivacy();
    this.#clearOwners();
  }

  public async pauseForDataMutation(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    try {
      await this.#drain();
      this.connections.pauseForDataMutation();
      this.githubCli.clearPendingSelections();
      this.#clearOwners();
    } catch (error) {
      this.#paused = false;
      throw error;
    }
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    await this.#drain();
    this.connections.pauseForShutdown();
    this.githubCli.clearPendingSelections();
    this.#clearOwners();
  }

  public resumeAfterPrivacyReset(): void {
    if (this.#disposed) return;
    this.connections.resumeAfterPrivacyReset();
    this.#paused = false;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    await this.#drain();
    this.connections.dispose();
    this.githubCli.clearPendingSelections();
    this.#clearOwners();
  }

  async #chooseLocalRepository(event: IpcMainInvokeEvent): Promise<string | null> {
    const authority = this.#authority(event);
    const selection = await this.dialog.showOpenDialog(authority.parent, {
      title: 'Choose local Git repository',
      buttonLabel: 'Choose repository',
      properties: ['openDirectory'],
    });
    authority.assertCurrent();
    if (selection.canceled) return null;
    const selectedPath = selection.filePaths[0];
    if (selectedPath === undefined) return null;
    return selectedPath;
  }

  async #chooseGitHubCli(event: IpcMainInvokeEvent): Promise<string | null> {
    const authority = this.#authority(event);
    const selection = await this.dialog.showOpenDialog(authority.parent, {
      title: 'Choose GitHub CLI executable',
      buttonLabel: 'Choose GitHub CLI',
      properties: ['openFile'],
    });
    authority.assertCurrent();
    if (selection.canceled) return null;
    return selection.filePaths[0] ?? null;
  }

  async #withSenderAbort<Output>(
    event: IpcMainInvokeEvent,
    operation: (signal: AbortSignal) => Promise<Output>,
  ): Promise<Output> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    event.sender.once('destroyed', abort);
    try {
      return await operation(controller.signal);
    } finally {
      event.sender.removeListener('destroyed', abort);
    }
  }

  #authority(event: IpcMainInvokeEvent): {
    readonly parent: BrowserWindow;
    readonly assertCurrent: () => void;
  } {
    this.#assertAvailable();
    assertLiveMainFrame(event, 'Git connection request');
    const ownerId = this.#owner(event);
    const parent = this.resolveWindow(event);
    if (parent === null || parent.isDestroyed()) {
      throw new Error('A live Forgeboard window is required for Git connection changes.');
    }
    const assertCurrent = (): void => {
      this.#assertAvailable();
      assertLiveMainFrame(event, 'Git connection request');
      if (
        this.#owners.get(event.sender) !== ownerId ||
        parent.isDestroyed() ||
        this.resolveWindow(event) !== parent
      ) {
        throw new Error('The originating Forgeboard window changed during Git connection review.');
      }
    };
    return { parent, assertCurrent };
  }

  #owner(event: IpcMainInvokeEvent): string {
    this.#assertAvailable();
    assertLiveMainFrame(event, 'Git connection request');
    const existing = this.#owners.get(event.sender);
    if (existing !== undefined) return existing;
    const owner = event.sender;
    const ownerId = `git-connections-window:${String(owner.id)}:${randomUUID()}`;
    this.#owners.set(owner, ownerId);
    this.#trackedOwners.add(owner);
    const destroyed = () => {
      this.#owners.delete(owner);
      this.#trackedOwners.delete(owner);
      this.#destroyedListeners.delete(owner);
      if (!this.#disposed) {
        this.connections.discardOwner(ownerId);
        this.githubCli.discardOwner(ownerId);
      }
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
      assertLiveMainFrame(event, 'Git connection request');
      const args = inputSchema.parse(rawArgs);
      const value = outputSchema.parse(
        await this.runDataOperation(async () => await operation(event, ...args)),
      );
      this.#assertAvailable();
      assertLiveMainFrame(event, 'Git connection request');
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
            ? 'Forgeboard rejected an invalid Git connection request.'
            : rendererSafeErrorMessage(error),
        },
      };
      ipcResultSchema(outputSchema).parse(result);
      return result;
    }
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
      this.audit.appendAudit('git-connections', action, outcome, metadata);
    } catch {
      // Requests remain fail-closed if optional audit recording is unavailable.
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed)
      throw new Error('Git connections are unavailable because the service closed.');
  }

  #assertAvailable(): void {
    this.#assertNotDisposed();
    if (this.#paused) throw new Error('Git connections are paused for a local-data operation.');
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
    return 'Git connections could not verify the exact current repository state. Refresh and try again.';
  }
  return message;
}
