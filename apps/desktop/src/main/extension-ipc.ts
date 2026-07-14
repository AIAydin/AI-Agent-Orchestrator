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
} from '../shared/contracts.js';
import { ExtensionManager } from './extension-manager.js';
import type { LocalStore } from './storage.js';

export class ExtensionIpcService {
  readonly #manager: ExtensionManager;
  readonly #registeredChannels: string[] = [];
  readonly #trackedOwners = new Set<number>();
  #disposed = false;
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
        const plan = await this.#manager.plan(selectedPath, ownerId);
        if (event.sender.isDestroyed()) {
          this.#manager.discardOwner(ownerId);
          throw new ExtensionRuntimeError(
            'INVALID_SELECTION',
            'The extension window closed before planning completed.',
          );
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
        return this.#withTrustLock(() => this.#manager.approve(input.planId, ownerId));
      },
    );
    this.#handle(
      IPC_CHANNELS.extensionsRemove,
      z.tuple([ExtensionRemoveInputSchema]),
      ExtensionDiscoveryViewSchema,
      (_event, input) =>
        this.#withTrustLock(() => this.#manager.remove(input.extensionId, input.confirmation)),
    );
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    this.#trackedOwners.clear();
    this.#manager.dispose();
  }

  public listActiveAgentAdapters() {
    return this.#manager.listActiveAgentAdapters();
  }

  public purgeAll(): Promise<void> {
    return this.#withTrustLock(() => this.#manager.purgeAll());
  }

  public resetForPrivacy(): Promise<void> {
    if (this.#disposed) throw new Error('The extension service has been disposed.');
    if (this.#privacyResetting) throw new Error('Extension data deletion is already in progress.');
    this.#privacyResetting = true;
    return this.#withTrustLock(() => this.#manager.purgeAll());
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
    const selection =
      parentWindow === null || parentWindow.isDestroyed()
        ? await this.dialog.showOpenDialog(options)
        : await this.dialog.showOpenDialog(parentWindow, options);
    if (selection.canceled) return null;
    return selection.filePaths[0] ?? null;
  }

  #liveParentWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
    if (event.sender.isDestroyed()) return null;
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    return parentWindow === null || parentWindow.isDestroyed() ? null : parentWindow;
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
    ipcMain.handle(
      channel,
      async (event, ...rawArgs: unknown[]): Promise<IpcResult<z.output<OutputSchema>>> => {
        try {
          if (this.#disposed) throw new Error('The extension service has been disposed.');
          if (this.#privacyResetting) {
            throw new Error('Extensions are paused while Forgeboard deletes local data.');
          }
          const args = inputSchema.parse(rawArgs);
          const value = await operation(event, ...args);
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
      },
    );
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
