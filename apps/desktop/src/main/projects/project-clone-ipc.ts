import { randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  ipcMain,
  type Dialog,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { z } from 'zod';

import {
  CloneProjectInputSchema,
  IPC_CHANNELS,
  type IpcResult,
  type Project,
} from '../../shared/application/contracts.js';
import type { OutboundActionGate } from '../outbound/outbound-action-gate.js';
import { createNativeOutboundConfirmation } from '../outbound/native-confirmation.js';
import { createNativeGitDelegateAuthorizer } from '../git/delegates/native-confirmation.js';
import type { ProjectCloneAuthorization, ProjectService } from './project-service.js';

type ProjectCloneOperations = Pick<ProjectService, 'clone'>;
type DataOperationRunner = <Value>(operation: () => Promise<Value>) => Promise<Value>;

/** Owner-aware IPC boundary for the Artemis-owned Git clone external send. */
export class ProjectCloneIpcService {
  readonly #operations = new Set<Promise<unknown>>();
  readonly #ownerIds = new WeakMap<WebContents, string>();
  #registered = false;
  #disposed = false;
  #paused = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly projects: ProjectCloneOperations,
    private readonly outbound: OutboundActionGate,
    private readonly runDataOperation: DataOperationRunner = async (operation) => await operation(),
  ) {}

  public registerIpcHandler(): void {
    if (this.#registered) throw new Error('The project clone IPC handler is already registered.');
    this.#registered = true;
    ipcMain.handle(
      IPC_CHANNELS.projectsClone,
      async (event, ...rawArgs: unknown[]): Promise<IpcResult<Project | null>> => {
        const operation = this.#invoke(event, rawArgs);
        this.#operations.add(operation);
        void operation.then(
          () => this.#operations.delete(operation),
          () => this.#operations.delete(operation),
        );
        return await operation;
      },
    );
  }

  public async pauseForShutdown(): Promise<void> {
    this.#assertAvailable();
    this.#paused = true;
    await this.#drain();
  }

  public resume(): void {
    if (!this.#disposed) this.#paused = false;
  }

  public async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#paused = true;
      if (this.#registered) ipcMain.removeHandler(IPC_CHANNELS.projectsClone);
      this.#registered = false;
    }
    await this.#drain();
  }

  async #invoke(event: IpcMainInvokeEvent, rawArgs: unknown[]): Promise<IpcResult<Project | null>> {
    try {
      this.#assertAvailable();
      const [input] = z.tuple([CloneProjectInputSchema]).parse(rawArgs);
      const ownerId = this.#ownerId(event.sender);
      const parent = this.#requireLiveParent(event);
      const assertCurrent = (): void => {
        this.#assertLiveMainFrame(event);
        if (
          this.#ownerIds.get(event.sender) !== ownerId ||
          parent.isDestroyed() ||
          BrowserWindow.fromWebContents(event.sender) !== parent
        ) {
          throw new Error('The Artemis window changed or closed before the clone could finish.');
        }
      };
      const authorization: ProjectCloneAuthorization = {
        ownerId,
        gate: this.outbound,
        assertCurrent,
        confirmation: createNativeOutboundConfirmation({
          assertCurrent,
          show: async (options) => (await this.dialog.showMessageBox(parent, options)).response,
        }),
        authorizeGitDelegates: createNativeGitDelegateAuthorizer({
          assertCurrent,
          show: async (options) => (await this.dialog.showMessageBox(parent, options)).response,
        }),
      };
      const value = await this.runDataOperation(
        async () =>
          await this.projects.clone(input.remoteUrl, input.destinationPath, authorization),
      );
      return { ok: true, value };
    } catch (error) {
      const validation = error instanceof z.ZodError;
      return {
        ok: false,
        error: {
          code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message: validation
            ? 'Artemis could not understand this clone request.'
            : error instanceof Error
              ? error.message
              : 'The clone failed. Try again.',
        },
      };
    }
  }

  #ownerId(owner: WebContents): string {
    this.#assertLiveOwner(owner);
    const existing = this.#ownerIds.get(owner);
    if (existing !== undefined) return existing;
    const ownerId = `web-contents:${String(owner.id)}:${randomUUID()}`;
    this.#ownerIds.set(owner, ownerId);
    owner.once('destroyed', () => {
      this.#ownerIds.delete(owner);
      this.outbound.discardOwner(ownerId);
    });
    return ownerId;
  }

  #requireLiveParent(event: IpcMainInvokeEvent): BrowserWindow {
    this.#assertLiveMainFrame(event);
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (parent === null || parent.isDestroyed()) {
      throw new Error('Artemis needs an open window to confirm the clone.');
    }
    return parent;
  }

  #assertLiveMainFrame(event: IpcMainInvokeEvent): void {
    this.#assertLiveOwner(event.sender);
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Cloning is only allowed from the main Artemis window.');
    }
  }

  #assertLiveOwner(owner: WebContents): void {
    if (owner.isDestroyed()) throw new Error('The Artemis window is closed.');
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('Artemis is closing, so cloning cannot start.');
    if (this.#paused) throw new Error('Cloning is paused while Artemis is closing.');
  }

  async #drain(): Promise<void> {
    while (this.#operations.size > 0) await Promise.allSettled([...this.#operations]);
  }
}
