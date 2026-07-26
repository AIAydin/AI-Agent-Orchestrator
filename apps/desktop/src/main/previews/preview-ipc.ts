import { randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type MessageBoxReturnValue,
  type MessageBoxOptions,
  type WebContents,
} from 'electron';
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
  type PreviewNavigateInput,
  type PreviewNodeKey,
  type PreviewSessionSnapshot,
  type PreviewStartInput,
} from '../../shared/application/contracts.js';
import {
  PreviewRuntime,
  type PreviewLaunchAuthorization,
  type PreviewLaunchPlan,
} from './preview-runtime.js';
import type { LocalStore } from '../storage.js';
import {
  PREVIEW_TARGET_IPC_CHANNELS,
  PreviewTargetListInputSchema,
  type PreviewTargetView,
} from '../../shared/preview/targets.js';

const PREVIEW_APPROVAL_TTL_MS = 5 * 60_000;

export interface PreviewOperations {
  listTargets(projectId: string): Promise<PreviewTargetView[]>;
  prepare(input: PreviewStartInput): Promise<PreviewLaunchPlan>;
  startPrepared(
    ownerId: string,
    plan: PreviewLaunchPlan,
    authorization: PreviewLaunchAuthorization,
  ): Promise<PreviewSessionSnapshot>;
  restartPrepared(
    ownerId: string,
    plan: PreviewLaunchPlan,
    authorization: PreviewLaunchAuthorization,
  ): Promise<PreviewSessionSnapshot>;
  stop(ownerId: string, input: PreviewNodeKey): Promise<PreviewSessionSnapshot | null>;
  get(ownerId: string, input: PreviewNodeKey): PreviewSessionSnapshot | null;
  validateNavigation(ownerId: string, input: PreviewNavigateInput): string;
  isAllowedFrameNavigation(candidate: string): boolean;
  resetForPrivacy(): Promise<void>;
  pauseForDataMutation(): void;
  resumeAfterPrivacyReset(): void;
  stopOwner(ownerId: string): Promise<void>;
  dispose(): Promise<void>;
}

export type PreviewRuntimeFactory = (
  emit: (ownerId: string, event: PreviewEventEnvelope) => void,
) => PreviewOperations;

export interface PreviewDialog {
  showMessageBox(parent: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
}

export class PreviewIpcService {
  readonly #operations = new Set<Promise<unknown>>();
  readonly #runtime: PreviewOperations;
  readonly #registeredChannels: string[] = [];
  readonly #ownerIds = new WeakMap<WebContents, string>();
  readonly #owners = new Map<string, WebContents>();
  #disposed = false;
  #paused = false;

  constructor(
    private readonly dialog: PreviewDialog,
    private readonly store: LocalStore,
    getSettings: () => AppSettings,
    runtimeFactory?: PreviewRuntimeFactory,
    private readonly now: () => Date = () => new Date(),
  ) {
    const emit = (ownerId: string, event: PreviewEventEnvelope): void => this.#send(ownerId, event);
    this.#runtime = runtimeFactory?.(emit) ?? new PreviewRuntime(store, getSettings, emit);
  }

  registerIpcHandlers(): void {
    if (this.#registeredChannels.length > 0) {
      throw new Error('The preview IPC handlers are already registered.');
    }
    this.#handle(
      IPC_CHANNELS.previewsStart,
      z.tuple([PreviewStartInputSchema]),
      async (event, input) =>
        await this.#confirmAndLaunch(event, PreviewStartInputSchema.parse(input), false),
    );
    this.#handle(
      IPC_CHANNELS.previewsRestart,
      z.tuple([PreviewStartInputSchema]),
      async (event, input) =>
        await this.#confirmAndLaunch(event, PreviewStartInputSchema.parse(input), true),
    );
    this.#handle(
      PREVIEW_TARGET_IPC_CHANNELS.list,
      z.tuple([PreviewTargetListInputSchema]),
      async (_event, input) => await this.#runtime.listTargets(input.projectId),
    );
    this.#handle(
      IPC_CHANNELS.previewsStop,
      z.tuple([PreviewNodeKeySchema]),
      async (event, input) => await this.#runtime.stop(this.#ownerId(event.sender), input),
    );
    this.#handle(IPC_CHANNELS.previewsGet, z.tuple([PreviewNodeKeySchema]), (event, input) =>
      this.#runtime.get(this.#ownerId(event.sender), input),
    );
    this.#handle(
      IPC_CHANNELS.previewsNavigate,
      z.tuple([PreviewNavigateInputSchema]),
      (event, input) => this.#runtime.validateNavigation(this.#ownerId(event.sender), input),
    );
  }

  isAllowedFrameNavigation(candidate: string): boolean {
    return this.#runtime.isAllowedFrameNavigation(candidate);
  }

  async resetForPrivacy(): Promise<void> {
    this.#paused = true;
    await this.#drainOperations();
    await this.#runtime.resetForPrivacy();
  }

  pauseForDataMutation(): void {
    this.#paused = true;
    try {
      this.#runtime.pauseForDataMutation();
    } catch (error) {
      this.#paused = false;
      throw error;
    }
  }

  async pauseForShutdown(): Promise<void> {
    if (this.#disposed) throw new Error('The preview runtime has been disposed.');
    this.#paused = true;
    await this.#drainOperations();
  }

  resumeAfterPrivacyReset(): void {
    this.#paused = false;
    this.#runtime.resumeAfterPrivacyReset();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#paused = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    await this.#drainOperations();
    await this.#runtime.dispose();
    this.#owners.clear();
  }

  async #confirmAndLaunch(
    event: IpcMainInvokeEvent,
    input: PreviewStartInput,
    restart: boolean,
  ): Promise<PreviewSessionSnapshot | null> {
    const ownerId = this.#ownerId(event.sender);
    const plan = await this.#runtime.prepare(input);
    const parent = this.#requireLiveParent(event);
    const expiresAtMs = this.now().getTime() + PREVIEW_APPROVAL_TTL_MS;
    const decision = await this.dialog.showMessageBox(parent, previewConfirmation(plan, restart));
    this.#assertCurrent(event, parent);
    if (decision.response !== 1) {
      this.store.appendAudit('preview', restart ? 'restart' : 'start', 'denied', {
        projectId: input.projectId,
        nodeId: input.nodeId,
        commandFingerprint: plan.fingerprint,
        reason: 'native-confirmation-cancelled',
      });
      return null;
    }
    if (expiresAtMs <= this.now().getTime()) {
      this.store.appendAudit('preview', restart ? 'restart' : 'start', 'denied', {
        projectId: input.projectId,
        nodeId: input.nodeId,
        commandFingerprint: plan.fingerprint,
        reason: 'native-confirmation-expired',
      });
      return null;
    }
    let expiryAudited = false;
    const assertApproved = (): void => {
      if (expiresAtMs <= this.now().getTime()) {
        if (!expiryAudited) {
          expiryAudited = true;
          this.store.appendAudit('preview', restart ? 'restart' : 'start', 'denied', {
            projectId: input.projectId,
            nodeId: input.nodeId,
            commandFingerprint: plan.fingerprint,
            reason: 'native-confirmation-expired-before-launch',
          });
        }
        throw new Error('The preview approval expired. Review the launch again.');
      }
      this.#assertCurrent(event, parent);
    };
    const authorization: PreviewLaunchAuthorization = {
      authorizeReplacement: assertApproved,
      authorizeSpawn: assertApproved,
    };
    return restart
      ? await this.#runtime.restartPrepared(ownerId, plan, authorization)
      : await this.#runtime.startPrepared(ownerId, plan, authorization);
  }

  #send(ownerId: string, event: PreviewEventEnvelope): void {
    const owner = this.#owners.get(ownerId);
    if (!owner || owner.isDestroyed() || this.#ownerIds.get(owner) !== ownerId) return;
    owner.send(IPC_CHANNELS.previewsEvent, PreviewEventEnvelopeSchema.parse(event));
  }

  #ownerId(owner: WebContents): string {
    const existing = this.#ownerIds.get(owner);
    if (existing !== undefined && this.#owners.get(existing) === owner) return existing;
    if (owner.isDestroyed()) throw new Error('The originating Artemis window is closed.');
    const ownerId = randomUUID();
    this.#ownerIds.set(owner, ownerId);
    this.#owners.set(ownerId, owner);
    owner.once('destroyed', () => {
      if (this.#ownerIds.get(owner) !== ownerId) return;
      this.#ownerIds.delete(owner);
      this.#owners.delete(ownerId);
      if (!this.#disposed) void this.#trackOperation(this.#runtime.stopOwner(ownerId));
    });
    return ownerId;
  }

  #assertLiveMainFrame(event: IpcMainInvokeEvent): void {
    if (
      this.#disposed ||
      this.#paused ||
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error('Preview requests require the active Artemis main frame.');
    }
  }

  #requireLiveParent(event: IpcMainInvokeEvent): BrowserWindow {
    this.#assertLiveMainFrame(event);
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || parent.isDestroyed()) {
      throw new Error('A live Artemis window is required to confirm a preview launch.');
    }
    return parent;
  }

  #assertCurrent(event: IpcMainInvokeEvent, parent: BrowserWindow): void {
    this.#assertLiveMainFrame(event);
    if (parent.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== parent) {
      throw new Error('The originating Artemis window changed before the preview launch.');
    }
    const ownerId = this.#ownerIds.get(event.sender);
    if (ownerId === undefined || this.#owners.get(ownerId) !== event.sender) {
      throw new Error('The preview launch authority no longer belongs to this renderer.');
    }
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    schema: z.ZodType<Args>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(channel, (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
      return this.#trackOperation(this.#invoke(event, rawArgs, schema, operation));
    });
  }

  async #invoke<Args extends unknown[], Output>(
    event: IpcMainInvokeEvent,
    rawArgs: unknown[],
    schema: z.ZodType<Args>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): Promise<IpcResult<Output>> {
    try {
      this.#assertLiveMainFrame(event);
      const args = schema.parse(rawArgs);
      return { ok: true, value: await operation(event, ...args) };
    } catch (error) {
      const validation = error instanceof z.ZodError;
      return {
        ok: false,
        error: {
          code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message: validation
            ? 'Artemis rejected an invalid preview request.'
            : error instanceof Error
              ? error.message
              : 'The preview operation failed.',
        },
      };
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
}

function previewConfirmation(plan: PreviewLaunchPlan, restart: boolean): MessageBoxOptions {
  const source =
    plan.source === 'package-script'
      ? `package.json script "${plan.packageScript?.name ?? 'unknown'}"`
      : plan.source === 'node-command'
        ? 'Literal preview command configured on this canvas node in the UI'
        : 'Default development command configured in Settings';
  const details = [
    `Project: ${plan.projectRoot}`,
    `Working directory: ${plan.cwd}`,
    `Source: ${source}`,
    `Executable: ${plan.executable}`,
    `Executable SHA-256: ${plan.executableIdentity.digest}`,
    `Arguments: ${JSON.stringify(plan.arguments)}`,
    `Loopback port range: ${String(plan.portRange.start)}-${String(plan.portRange.end)}`,
    `Trusted loopback hosts: ${plan.trustedHosts.join(', ')}`,
  ];
  if (plan.packageScript !== null) {
    details.push(
      `Package manifest: ${plan.packageScript.packageJsonIdentity.path}`,
      `Package manifest SHA-256: ${plan.packageScript.packageJsonIdentity.digest}`,
      `Script declaration: ${plan.packageScript.declaration}`,
    );
  }
  if (plan.indirectExecutableIdentity !== null) {
    details.push(
      `Indirect package-manager shim: ${plan.indirectExecutableIdentity.path}`,
      `Indirect shim SHA-256: ${plan.indirectExecutableIdentity.digest}`,
    );
  }
  details.push(
    '',
    'Artemis will start this local process without a shell. The process itself can still access resources allowed by your operating system.',
  );
  return {
    type: 'warning',
    title: restart ? 'Restart development preview?' : 'Start development preview?',
    message: restart
      ? 'Stop the current preview and start this reviewed replacement?'
      : 'Start this reviewed development preview?',
    detail: details.join('\n'),
    buttons: ['Cancel', restart ? 'Restart preview' : 'Start preview'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
