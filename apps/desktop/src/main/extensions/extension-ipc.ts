import { join } from 'node:path';

import type { AgentAdapterManifest } from '@forgeboard/agent-adapters';
import { ExtensionRuntimeError, LocalExtensionService } from '@forgeboard/extension-runtime';
import {
  BrowserWindow,
  ipcMain,
  type App,
  type Dialog,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from 'electron';
import { z } from 'zod';

import {
  ExtensionApproveInputSchema,
  ExtensionDiscoveryViewSchema,
  ExtensionInstallPlanViewSchema,
  ExtensionRemoveInputSchema,
  ExtensionSelectionKindSchema,
  IPC_CHANNELS,
  ipcResultSchema,
  type IpcResult,
} from '../../shared/application/contracts.js';
import { ExtensionManager } from './extension-manager.js';
import type { LocalStore } from '../storage.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';

export class ExtensionIpcService {
  readonly #manager: ExtensionManager;
  readonly #operations = new Set<Promise<unknown>>();
  readonly #registeredChannels: string[] = [];
  readonly #trackedOwners = new Set<number>();
  #disposed = false;
  #disposePromise: Promise<void> | null = null;
  #privacyResetting = false;
  #trustTail: Promise<void> = Promise.resolve();

  public constructor(
    app: Pick<App, 'getPath'>,
    private readonly dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>,
    store: LocalStore,
  ) {
    const registryRoot = join(app.getPath('userData'), 'extensions');
    this.#manager = new ExtensionManager(new LocalExtensionService(registryRoot), store);
  }

  public registerIpcHandlers(): void {
    this.#handle(IPC_CHANNELS.extensionsList, z.tuple([]), ExtensionDiscoveryViewSchema, () =>
      this.#manager.list(),
    );
    this.#handle(
      IPC_CHANNELS.extensionsChoose,
      z.tuple([ExtensionSelectionKindSchema]),
      ExtensionInstallPlanViewSchema.nullable(),
      async (event, kind) => {
        if (event.sender.isDestroyed()) {
          throw new ExtensionRuntimeError('INVALID_SELECTION', 'The extension window is closed.');
        }
        this.#trackOwner(event);
        const selectedPath = await this.#choosePath(event, kind);
        if (event.sender.isDestroyed()) {
          throw new ExtensionRuntimeError(
            'INVALID_SELECTION',
            'The extension window closed before the native chooser completed.',
          );
        }
        if (selectedPath === null) return null;
        const ownerId = event.sender.id;
        const parentWindow = this.#requireCurrentParent(event);
        const plan = await this.#manager.plan(selectedPath, ownerId);
        try {
          this.#assertCurrentParent(event, parentWindow);
        } catch (error) {
          this.#manager.discardOwner(ownerId);
          throw error;
        }
        return plan;
      },
    );
    this.#handle(
      IPC_CHANNELS.extensionsApprove,
      z.tuple([ExtensionApproveInputSchema]),
      ExtensionDiscoveryViewSchema,
      async (event, input) => {
        this.#trackOwner(event);
        const ownerId = event.sender.id;
        const plan = this.#manager.inspectPendingPlan(input.planId, ownerId);
        const parentWindow = this.#liveParentWindow(event);
        if (parentWindow === null) {
          this.#manager.denyApproval(
            input.planId,
            ownerId,
            'No live originating window was available for trusted confirmation.',
          );
          throw new ExtensionRuntimeError(
            'APPROVAL_MISMATCH',
            'A live Forgeboard window is required to approve an extension.',
          );
        }
        const options: MessageBoxOptions = {
          type: 'warning',
          title: plan.operation === 'install' ? 'Install extension' : 'Update extension',
          message: `${plan.operation === 'install' ? 'Install' : 'Update'} ${plan.manifest.id} ${plan.manifest.version}?`,
          detail: extensionApprovalDetail(plan),
          buttons: ['Cancel', plan.operation === 'install' ? 'Install' : 'Update'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        };
        const decision = await this.dialog.showMessageBox(parentWindow, options);
        this.#assertCurrentParent(event, parentWindow);
        if (event.sender.isDestroyed() || decision.response !== 1) {
          if (!event.sender.isDestroyed()) {
            this.#manager.denyApproval(
              input.planId,
              ownerId,
              'The main-process extension confirmation was cancelled.',
            );
          }
          throw new ExtensionRuntimeError(
            'APPROVAL_MISMATCH',
            'Extension installation was cancelled before trusted activation.',
          );
        }
        if (this.#privacyResetting) {
          throw new Error('Extensions are paused while Forgeboard deletes local data.');
        }
        return this.#withTrustLock(async () => {
          this.#assertCurrentParent(event, parentWindow);
          const discovery = await this.#manager.approve(input.planId, ownerId);
          this.#assertCurrentParent(event, parentWindow);
          return discovery;
        });
      },
    );
    this.#handle(
      IPC_CHANNELS.extensionsRemove,
      z.tuple([ExtensionRemoveInputSchema]),
      ExtensionDiscoveryViewSchema,
      (event, input) =>
        this.#withTrustLock(async () => {
          assertLiveMainFrame(event, 'Extension request');
          const discovery = await this.#manager.remove(input.extensionId, input.confirmation);
          assertLiveMainFrame(event, 'Extension request');
          return discovery;
        }),
    );
  }

  public dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#privacyResetting = true;
      for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
      this.#registeredChannels.length = 0;
      this.#trackedOwners.clear();
    }
    this.#disposePromise ??= this.#finishDisposal();
    return this.#disposePromise;
  }

  public listActiveAgentAdapters() {
    return this.#manager.listActiveAgentAdapters();
  }

  public purgeAll(): Promise<void> {
    return this.#withTrustLock(() => this.#manager.purgeAll());
  }

  public async resetForPrivacy(): Promise<void> {
    if (this.#disposed) throw new Error('The extension service has been disposed.');
    if (this.#privacyResetting) throw new Error('Extension data deletion is already in progress.');
    this.#privacyResetting = true;
    await this.#drainOperations();
    await this.#withTrustLock(async () => await this.#manager.purgeAll());
  }

  public async pauseForDataMutation(): Promise<void> {
    if (this.#disposed) throw new Error('The extension service has been disposed.');
    if (this.#privacyResetting) throw new Error('Extension data is already paused.');
    this.#privacyResetting = true;
    try {
      await this.#drainOperations();
      await this.#withTrustLock(async () => await this.#manager.quiesce());
    } catch (error) {
      this.#privacyResetting = false;
      throw error;
    }
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) throw new Error('The extension service has been disposed.');
    if (this.#privacyResetting) throw new Error('Extension data is already paused.');
    this.#privacyResetting = true;
    try {
      await this.#drainOperations();
      await this.#withTrustLock(async () => await this.#manager.waitForMutations());
    } catch (error) {
      this.#privacyResetting = false;
      throw error;
    }
  }

  public resumeAfterPrivacyReset(): void {
    if (!this.#disposed) this.#privacyResetting = false;
  }

  public launchTrustedAdapter<T>(
    adapterId: string,
    expectedManifest: AgentAdapterManifest,
    launch: () => Promise<T>,
  ): Promise<T> {
    return this.#withTrustLock(async () => {
      if (this.#privacyResetting) {
        throw new Error('Extensions are paused while Forgeboard deletes local data.');
      }
      const current = (await this.#manager.listActiveAgentAdapters()).find(
        (adapter) => adapter.id === adapterId,
      );
      if (current === undefined || JSON.stringify(current) !== JSON.stringify(expectedManifest)) {
        throw new Error(
          `Extension adapter ${adapterId} is no longer active with the reviewed manifest.`,
        );
      }
      return launch();
    });
  }

  async #choosePath(
    event: IpcMainInvokeEvent,
    kind: 'folder' | 'manifest',
  ): Promise<string | null> {
    const options: OpenDialogOptions =
      kind === 'folder'
        ? {
            title: 'Choose a Forgeboard extension folder',
            buttonLabel: 'Review extension',
            properties: ['openDirectory'],
          }
        : {
            title: 'Choose forgeboard-extension.json',
            buttonLabel: 'Review extension',
            properties: ['openFile'],
            filters: [{ name: 'Forgeboard extension manifest', extensions: ['json'] }],
          };
    const parentWindow = this.#liveParentWindow(event);
    if (parentWindow === null) {
      throw new ExtensionRuntimeError(
        'INVALID_SELECTION',
        'A live Forgeboard window is required to choose an extension.',
      );
    }
    const selection = await this.dialog.showOpenDialog(parentWindow, options);
    if (event.sender.isDestroyed()) {
      throw new ExtensionRuntimeError(
        'INVALID_SELECTION',
        'The extension window closed before the native chooser completed.',
      );
    }
    this.#assertCurrentParent(event, parentWindow);
    if (selection.canceled) return null;
    return selection.filePaths[0] ?? null;
  }

  #liveParentWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
    try {
      assertLiveMainFrame(event, 'Extension request');
    } catch {
      return null;
    }
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    return parentWindow === null || parentWindow.isDestroyed() ? null : parentWindow;
  }

  #requireCurrentParent(event: IpcMainInvokeEvent): BrowserWindow {
    const parent = this.#liveParentWindow(event);
    if (parent === null) {
      throw new ExtensionRuntimeError(
        'INVALID_SELECTION',
        'The extension window closed before planning completed.',
      );
    }
    return parent;
  }

  #assertCurrentParent(event: IpcMainInvokeEvent, parent: BrowserWindow): void {
    assertLiveMainFrame(event, 'Extension request');
    if (parent.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== parent) {
      throw new ExtensionRuntimeError(
        'APPROVAL_MISMATCH',
        'The originating Forgeboard window changed before extension authorization completed.',
      );
    }
  }

  #trackOwner(event: IpcMainInvokeEvent): void {
    const ownerId = event.sender.id;
    if (this.#trackedOwners.has(ownerId)) return;
    this.#trackedOwners.add(ownerId);
    event.sender.once('destroyed', () => {
      this.#trackedOwners.delete(ownerId);
      this.#manager.discardOwner(ownerId);
    });
  }

  async #withTrustLock<T>(operation: () => Promise<T>): Promise<T> {
    let release: () => void = () => undefined;
    const previous = this.#trustTail;
    this.#trustTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #handle<Args extends unknown[], OutputSchema extends z.ZodTypeAny>(
    channel: string,
    inputSchema: z.ZodType<Args>,
    outputSchema: OutputSchema,
    operation: (
      event: IpcMainInvokeEvent,
      ...args: Args
    ) => z.output<OutputSchema> | Promise<z.output<OutputSchema>>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(channel, (event, ...rawArgs: unknown[]) => {
      return this.#trackOperation(
        this.#invoke(event, rawArgs, inputSchema, outputSchema, operation),
      );
    });
  }

  async #invoke<Args extends unknown[], OutputSchema extends z.ZodTypeAny>(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
    inputSchema: z.ZodType<Args>,
    outputSchema: OutputSchema,
    operation: (
      event: IpcMainInvokeEvent,
      ...args: Args
    ) => z.output<OutputSchema> | Promise<z.output<OutputSchema>>,
  ): Promise<IpcResult<z.output<OutputSchema>>> {
    try {
      if (this.#disposed) throw new Error('The extension service has been disposed.');
      assertLiveMainFrame(event, 'Extension request');
      if (this.#privacyResetting) {
        throw new Error('Extensions are paused while Forgeboard deletes local data.');
      }
      const args = inputSchema.parse(rawArgs);
      const value = await operation(event, ...args);
      assertLiveMainFrame(event, 'Extension request');
      outputSchema.parse(value);
      const result: IpcResult<z.output<OutputSchema>> = { ok: true, value };
      ipcResultSchema(outputSchema).parse(result);
      return result;
    } catch (error) {
      const validation = error instanceof z.ZodError;
      const result = {
        ok: false as const,
        error: {
          code: validation
            ? 'INVALID_REQUEST'
            : error instanceof ExtensionRuntimeError
              ? error.code
              : 'OPERATION_FAILED',
          message: validation
            ? 'Forgeboard rejected an invalid extension request.'
            : error instanceof Error
              ? error.message
              : 'The extension operation failed.',
        },
      };
      ipcResultSchema(outputSchema).parse(result);
      return result;
    }
  }

  #trackOperation<Output>(operation: Promise<Output>): Promise<Output> {
    this.#operations.add(operation);
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation),
    );
    return operation;
  }

  async #drainOperations(): Promise<void> {
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
  }

  async #finishDisposal(): Promise<void> {
    await this.#drainOperations();
    await this.#trustTail;
    await this.#manager.quiesce();
    this.#manager.dispose();
  }
}

function extensionApprovalDetail(plan: z.output<typeof ExtensionInstallPlanViewSchema>): string {
  return [
    `Extension: ${plan.manifest.id}`,
    `Version: ${plan.manifest.version}`,
    `Manifest SHA-256: ${plan.manifestDigest}`,
    `Snapshot SHA-256: ${plan.snapshotDigest}`,
    'Permissions:',
    ...plan.requestedPermissions.map((permission) => `  • ${permission}`),
    '',
    'The renderer requested review, but only this main-process confirmation grants trust.',
  ].join('\n');
}
