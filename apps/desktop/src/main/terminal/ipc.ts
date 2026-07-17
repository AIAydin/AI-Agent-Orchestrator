import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';

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
  TERMINAL_IPC_CHANNELS,
  TerminalChooseExecutableInputSchema,
  TerminalEventSchema,
  TerminalExecutableSelectionViewSchema,
  TerminalInputSchema,
  TerminalLaunchPlanCancelResultSchema,
  TerminalLaunchPlanConfirmationInputSchema,
  TerminalLaunchPlanViewSchema,
  TerminalPrepareLaunchInputSchema,
  TerminalReplayInputSchema,
  TerminalReplayViewSchema,
  TerminalResizeInputSchema,
  TerminalSessionListInputSchema,
  TerminalSessionListViewSchema,
  TerminalSessionTargetInputSchema,
  TerminalSessionViewSchema,
  type TerminalEvent,
} from '../../shared/terminal/index.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';
import { confirmTerminalLaunch } from './native-confirmation.js';
import type { TerminalService } from './service.js';

type WindowResolver = (event: IpcMainInvokeEvent) => BrowserWindow | null;
type TerminalMutationAuthorizer = (event: IpcMainInvokeEvent) => void;

/** Narrow IPC owner boundary for terminal picker, approval, control, replay, and events. */
export class TerminalIpcService {
  readonly #channels: string[] = [];
  readonly #operations = new Set<Promise<unknown>>();
  readonly #ownerIds = new WeakMap<WebContents, string>();
  readonly #owners = new Map<string, WebContents>();
  readonly #unsubscribe: () => void;
  #paused = false;
  #disposed = false;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>,
    private readonly service: TerminalService,
    private readonly resolveWindow: WindowResolver = (event) =>
      BrowserWindow.fromWebContents(event.sender),
    private readonly assertMutationAuthorized: TerminalMutationAuthorizer = () => undefined,
  ) {
    this.#unsubscribe = service.subscribe((ownerId, event) => this.#send(ownerId, event));
  }

  public registerIpcHandlers(): void {
    this.#handle(
      TERMINAL_IPC_CHANNELS.chooseExecutable,
      z.tuple([TerminalChooseExecutableInputSchema]),
      TerminalExecutableSelectionViewSchema.nullable(),
      async (event, input) => {
        this.assertMutationAuthorized(event);
        await this.service.assertProjectAvailable(input.projectId);
        const parent = this.#requireWindow(event);
        const selection = await this.dialog.showOpenDialog(parent, {
          title: 'Choose terminal executable',
          buttonLabel: 'Choose executable',
          properties: ['openFile'],
        });
        this.#assertCurrent(event, parent);
        const selected = selection.filePaths[0];
        if (selection.canceled || selected === undefined) return null;
        const canonical = await realpath(selected);
        const details = await stat(canonical);
        if (!details.isFile()) throw new Error('The selected terminal executable is not a file.');
        await access(canonical, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        this.#assertCurrent(event, parent);
        this.assertMutationAuthorized(event);
        return TerminalExecutableSelectionViewSchema.parse({
          executable: canonical,
          filename: basename(canonical),
        });
      },
    );
    this.#handle(
      TERMINAL_IPC_CHANNELS.prepareLaunch,
      z.tuple([TerminalPrepareLaunchInputSchema]),
      TerminalLaunchPlanViewSchema,
      async (event, input) => {
        this.assertMutationAuthorized(event);
        const ownerId = this.#ownerId(event.sender);
        const plan = await this.service.prepareLaunch(ownerId, input);
        try {
          this.assertMutationAuthorized(event);
          return plan;
        } catch (error) {
          await this.service.cancelLaunch(ownerId, plan.planId).catch(() => undefined);
          throw error;
        }
      },
    );
    this.#handle(
      TERMINAL_IPC_CHANNELS.cancelLaunch,
      z.tuple([TerminalLaunchPlanConfirmationInputSchema]),
      TerminalLaunchPlanCancelResultSchema,
      async (event, input) =>
        await this.service.cancelLaunch(this.#ownerId(event.sender), input.planId),
    );
    this.#handle(
      TERMINAL_IPC_CHANNELS.confirmLaunch,
      z.tuple([TerminalLaunchPlanConfirmationInputSchema]),
      TerminalSessionViewSchema.nullable(),
      async (event, input) => {
        this.assertMutationAuthorized(event);
        const ownerId = this.#ownerId(event.sender);
        const parent = this.#requireWindow(event);
        const assertCurrent = (): void => {
          this.#assertCurrent(event, parent, ownerId);
          this.assertMutationAuthorized(event);
        };
        return await this.service.confirmLaunch(
          ownerId,
          input.planId,
          async (review) => await confirmTerminalLaunch(this.dialog, parent, review, assertCurrent),
          assertCurrent,
        );
      },
    );
    this.#handle(
      TERMINAL_IPC_CHANNELS.getSession,
      z.tuple([TerminalSessionTargetInputSchema]),
      TerminalSessionViewSchema.nullable(),
      async (event, input) => await this.service.getSession(this.#ownerId(event.sender), input),
    );
    this.#handle(
      TERMINAL_IPC_CHANNELS.listSessions,
      z.tuple([TerminalSessionListInputSchema]),
      TerminalSessionListViewSchema,
      async (event, input) => await this.service.listSessions(this.#ownerId(event.sender), input),
    );
    this.#handle(
      TERMINAL_IPC_CHANNELS.replay,
      z.tuple([TerminalReplayInputSchema]),
      TerminalReplayViewSchema.nullable(),
      async (event, input) => await this.service.replay(this.#ownerId(event.sender), input),
    );
    this.#handle(
      TERMINAL_IPC_CHANNELS.sendInput,
      z.tuple([TerminalInputSchema]),
      TerminalSessionViewSchema,
      async (event, input) => {
        this.assertMutationAuthorized(event);
        return await this.service.sendInput(this.#ownerId(event.sender), input);
      },
    );
    this.#handle(
      TERMINAL_IPC_CHANNELS.resize,
      z.tuple([TerminalResizeInputSchema]),
      TerminalSessionViewSchema,
      async (event, input) => {
        this.assertMutationAuthorized(event);
        return await this.service.resize(this.#ownerId(event.sender), input);
      },
    );
    this.#handle(
      TERMINAL_IPC_CHANNELS.interrupt,
      z.tuple([TerminalSessionTargetInputSchema]),
      TerminalSessionViewSchema,
      async (event, input) => await this.service.interrupt(this.#ownerId(event.sender), input),
    );
    this.#handle(
      TERMINAL_IPC_CHANNELS.terminate,
      z.tuple([TerminalSessionTargetInputSchema]),
      TerminalSessionViewSchema,
      async (event, input) => await this.service.terminate(this.#ownerId(event.sender), input),
    );
  }

  public async pauseForDataMutation(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    try {
      await this.#drain();
      await this.service.pauseForDataMutation();
    } catch (error) {
      this.#paused = false;
      throw error;
    }
  }

  public async resetForPrivacy(): Promise<void> {
    this.#assertNotDisposed();
    this.#paused = true;
    await this.#drain();
    await this.service.resetForPrivacy();
  }

  public async pauseForShutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    await this.#drain();
    await this.service.pauseForShutdown();
  }

  public resumeAfterPrivacyReset(): void {
    if (this.#disposed) return;
    this.service.resumeAfterPrivacyReset();
    this.#paused = false;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = true;
    for (const channel of this.#channels) ipcMain.removeHandler(channel);
    this.#channels.length = 0;
    this.#unsubscribe();
    await this.#drain();
    await this.service.dispose();
    this.#owners.clear();
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    inputSchema: z.ZodType<Args>,
    outputSchema: z.ZodType<Output>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#channels.push(channel);
    ipcMain.handle(channel, (event, ...rawArgs: unknown[]) =>
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
      this.#assertNotDisposed();
      if (this.#paused)
        throw new Error('Terminal operations are paused for a local data operation.');
      assertLiveMainFrame(event, 'Terminal operation');
      this.#ownerId(event.sender);
      const args = inputSchema.parse(rawArgs);
      const value = outputSchema.parse(await operation(event, ...args));
      assertLiveMainFrame(event, 'Terminal operation');
      return ipcResultSchema(outputSchema).parse({ ok: true, value });
    } catch (error) {
      return ipcResultSchema(outputSchema).parse({
        ok: false,
        error: {
          code: error instanceof z.ZodError ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message:
            error instanceof z.ZodError
              ? 'Forgeboard rejected an invalid terminal request.'
              : error instanceof Error
                ? error.message
                : 'The terminal operation failed.',
        },
      });
    }
  }

  #ownerId(owner: WebContents): string {
    const existing = this.#ownerIds.get(owner);
    if (existing !== undefined) return existing;
    const ownerId = `terminal:web-contents:${String(owner.id)}:${randomUUID()}`;
    this.#ownerIds.set(owner, ownerId);
    this.#owners.set(ownerId, owner);
    owner.once('destroyed', () => {
      this.#ownerIds.delete(owner);
      if (this.#owners.get(ownerId) === owner) this.#owners.delete(ownerId);
      if (this.#disposed) return;
      void this.#track(this.service.discardOwner(ownerId));
    });
    return ownerId;
  }

  #send(ownerId: string, untrusted: TerminalEvent): void {
    const owner = this.#owners.get(ownerId);
    if (owner === undefined || owner.isDestroyed()) return;
    owner.send(TERMINAL_IPC_CHANNELS.event, TerminalEventSchema.parse(untrusted));
  }

  #requireWindow(event: IpcMainInvokeEvent): BrowserWindow {
    assertLiveMainFrame(event, 'Terminal operation');
    const parent = this.resolveWindow(event);
    if (parent === null || parent.isDestroyed()) {
      throw new Error('A live Forgeboard window is required for this terminal operation.');
    }
    return parent;
  }

  #assertCurrent(event: IpcMainInvokeEvent, expected: BrowserWindow, ownerId?: string): void {
    assertLiveMainFrame(event, 'Terminal operation');
    if (
      expected.isDestroyed() ||
      this.resolveWindow(event) !== expected ||
      (ownerId !== undefined && this.#owners.get(ownerId) !== event.sender)
    ) {
      throw new Error('The originating Forgeboard terminal window changed or closed.');
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
    const results = await Promise.allSettled([...this.#operations]);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed !== undefined) throw failed.reason;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error('The terminal IPC service has been disposed.');
  }
}
