import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';

import type { AgentAdapterManifest } from '@forgeboard/agent-adapters';
import { RepositoryService } from '@forgeboard/git-engine';
import {
  app,
  BrowserWindow,
  ipcMain,
  type Dialog,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type WebContents,
} from 'electron';
import { z } from 'zod';

import {
  IPC_CHANNELS,
  PrepareRunInputSchema,
  RunApprovalViewSchema,
  RunEventEnvelopeSchema,
  type AppSettings,
  type IpcResult,
  type PrepareRunInput,
  type RunApprovalView,
  type RunDisclosure,
  type RunEventEnvelope,
} from '../../shared/application/contracts.js';
import {
  RunHistoryListInputSchema,
  type RunHistoryListInput,
  type RunHistorySummary,
} from '../../shared/runs/contracts.js';
import {
  type AgentExecutionEventSink,
  type AgentExecutionOperations,
  type AgentPreparationProcessAuthorization,
  type TrustedAdapterLauncher,
} from '../agent-execution/contracts.js';
import {
  assertLaunchExecutableIdentity,
  captureLaunchExecutableIdentity,
  type LaunchExecutableIdentity,
} from '../agent-execution/launch-integrity.js';
import { AgentExecutionRuntime } from '../agent-execution/runtime.js';
import { resolveDockerExecutable } from '../docker/docker-runtime.js';
import { createNativeGitDelegateAuthorizer } from '../git/delegates/native-confirmation.js';
import type { LocalStore } from '../storage.js';
import {
  PersistedAgentRunContextResolver,
  type AgentRunContextResolver,
  type PersistedAgentContextAuthority,
  type PersistedAgentContextResolution,
} from './context/persisted-agent-context.js';
import { summarizePersistedRunHistory } from './history/summaries.js';

const RunIdSchema = z.string().uuid();
const InputSchema = z
  .string()
  .max(1_000_000)
  .refine((value) => !value.includes('\0'), {
    message: 'Agent input cannot contain NUL bytes.',
  });

interface PreparedApproval {
  readonly contextAuthority: PersistedAgentContextAuthority;
  readonly disclosure: RunDisclosure;
  readonly disclosureFingerprint: string;
  readonly expiresAt: string;
  readonly input: PrepareRunInput;
  readonly owner: WebContents;
  readonly ownerId: string;
  readonly planId: string;
}

interface DockerPreparationApproval {
  readonly executable: string;
  readonly executableIdentity: LaunchExecutableIdentity;
  readonly image: string;
  readonly expiresAtMs: number;
}

export type RunServiceRuntimeFactory = (emit: AgentExecutionEventSink) => AgentExecutionOperations;
export type RunServiceExecutionEventListener = (event: RunEventEnvelope) => void;

/**
 * Electron compatibility shell for agent execution.
 *
 * Process, Git, worktree, plan, and completion lifecycle policy lives in the WebContents-free
 * AgentExecutionRuntime. This class validates IPC and maps renderer instances to opaque owner IDs.
 */
export class RunService {
  readonly #approvals = new Map<string, PreparedApproval>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #executionSubscribers = new Map<string, Set<RunServiceExecutionEventListener>>();
  readonly #ownerIds = new WeakMap<WebContents, string>();
  readonly #owners = new Map<string, WebContents>();
  readonly #registeredChannels: string[] = [];
  readonly #repositories: RepositoryService;
  readonly #runtime: AgentExecutionOperations;
  readonly #store: Pick<LocalStore, 'appendAudit' | 'listProjectRuns'>;
  readonly #contextResolver: AgentRunContextResolver;
  #disposed = false;
  #privacyResetting = false;
  #shutdownPaused = false;
  #resetOperation: Promise<void> | null = null;

  public constructor(
    store: LocalStore,
    private readonly getSettings: () => AppSettings,
    getTrustedAdapter: (adapterId: string) => Promise<AgentAdapterManifest | undefined> = () =>
      Promise.resolve(undefined),
    launchTrustedAdapter?: TrustedAdapterLauncher,
    repositories: RepositoryService = new RepositoryService(),
    runtimeFactory?: RunServiceRuntimeFactory,
    private readonly dialog?: Pick<Dialog, 'showMessageBox'>,
    private readonly now: () => Date = () => new Date(),
    contextResolver?: AgentRunContextResolver,
  ) {
    this.#store = store;
    this.#contextResolver = contextResolver ?? new PersistedAgentRunContextResolver(store);
    this.#repositories = repositories;
    const emit: AgentExecutionEventSink = (ownerId, envelope) => {
      this.#emitExecutionEvent(ownerId, envelope);
    };
    this.#runtime =
      runtimeFactory?.(emit) ??
      new AgentExecutionRuntime({
        store,
        getSettings: this.getSettings,
        emit,
        getTrustedAdapter,
        ...(launchTrustedAdapter === undefined ? {} : { launchTrustedAdapter }),
        repositories,
        resolveTestAgentCliPath: testAgentCliPath,
      });
  }

  public registerIpcHandlers(): void {
    this.#handle(IPC_CHANNELS.runsList, z.tuple([RunHistoryListInputSchema]), (event, input) =>
      this.#listPersistedRuns(event, input),
    );
    this.#handle(
      IPC_CHANNELS.runsPrepare,
      z.tuple([PrepareRunInputSchema]),
      async (event, input) => {
        this.#assertLiveMainFrame(event);
        return await this.#trackOperation(this.#prepareFromRenderer(event, input));
      },
    );
    this.#handle(IPC_CHANNELS.runsApprove, z.tuple([RunIdSchema]), async (event, runId) => {
      this.#assertLiveMainFrame(event);
      return await this.#trackOperation(this.#confirmAndApprove(event, runId));
    });
    this.#handle(
      IPC_CHANNELS.runsInput,
      z.tuple([RunIdSchema, InputSchema]),
      (event, runId, data) => {
        this.#assertLiveMainFrame(event);
        return this.sendInput(event.sender, runId, data);
      },
    );
    this.#handle(IPC_CHANNELS.runsInterrupt, z.tuple([RunIdSchema]), (event, runId) => {
      this.#assertLiveMainFrame(event);
      return this.interrupt(event.sender, runId);
    });
    this.#handle(IPC_CHANNELS.runsTerminate, z.tuple([RunIdSchema]), async (event, runId) => {
      this.#assertLiveMainFrame(event);
      return await this.#trackOperation(this.terminate(event.sender, runId));
    });
  }

  #listPersistedRuns(event: IpcMainInvokeEvent, input: RunHistoryListInput): RunHistorySummary[] {
    this.#assertAvailable();
    const parent = this.#requireLiveParent(event, 'Agent run history');
    const records = this.#store.listProjectRuns(input.projectId, input.limit);
    this.#assertCurrentWindow(event, parent);
    return summarizePersistedRunHistory(records).slice(0, input.limit);
  }

  /** Main-process composition seam for durable workflow-owned agent runs. */
  public executionOperations(): AgentExecutionOperations {
    return this.#runtime;
  }

  /** Main-process-only, exact-owner event seam used by workflow-owned agent executions. */
  public subscribeExecutionEvents(
    ownerId: string,
    listener: RunServiceExecutionEventListener,
  ): () => void {
    this.#assertAvailable();
    if (ownerId.length === 0 || ownerId.length > 512 || ownerId.includes('\0')) {
      throw new Error('Agent execution event subscriptions require a valid opaque owner ID.');
    }
    const listeners = this.#executionSubscribers.get(ownerId) ?? new Set();
    listeners.add(listener);
    this.#executionSubscribers.set(ownerId, listeners);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (listeners.size === 0 && this.#executionSubscribers.get(ownerId) === listeners) {
        this.#executionSubscribers.delete(ownerId);
      }
    };
  }

  public async prepare(
    owner: WebContents,
    input: PrepareRunInput,
    processAuthorization?: AgentPreparationProcessAuthorization,
    assertCurrent?: () => void,
  ): Promise<RunApprovalView> {
    this.#assertAvailable();
    const ownerId = this.#ownerId(owner);
    const contextResolution = await this.#contextResolver.resolve(input, this.getSettings());
    const prepared = await this.#runtime.prepare(
      ownerId,
      {
        ...input,
        context: contextResolution.context,
      },
      processAuthorization,
    );
    try {
      if (owner.isDestroyed() || this.#owners.get(ownerId) !== owner) {
        throw new Error('The originating Forgeboard window closed while preparing the agent run.');
      }
      assertCurrent?.();
      assertPreparedContextDisclosure(contextResolution, prepared.disclosure);
    } catch (error) {
      const cleanupError = await this.#runtime
        .terminate(ownerId, prepared.planId)
        .then(() => undefined)
        .catch((cause: unknown) => cause);
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [error, cleanupError],
          'Run preparation became stale and its pending plan could not be terminated.',
        );
      }
      throw error;
    }
    this.#approvals.set(prepared.runId, {
      contextAuthority: contextResolution.authority,
      disclosure: prepared.disclosure,
      disclosureFingerprint: prepared.disclosureFingerprint,
      expiresAt: prepared.expiresAt,
      input: { ...input },
      owner,
      ownerId,
      planId: prepared.planId,
    });
    return RunApprovalViewSchema.parse({
      ...prepared.disclosure,
      disclosureFingerprint: prepared.disclosureFingerprint,
      expiresAt: prepared.expiresAt,
    });
  }

  async #prepareFromRenderer(
    event: IpcMainInvokeEvent,
    input: PrepareRunInput,
  ): Promise<RunApprovalView | null> {
    const settings = this.getSettings();
    const authorization = await this.#dockerPreparationAuthorization(event, input, settings);
    if (authorization === null) return null;
    const parent = this.#requireLiveParent(event);
    const ownerId = this.#ownerId(event.sender);
    const assertCurrent = (): void => this.#assertCurrent(event, parent, ownerId);
    const authorizeGitDelegates = createNativeGitDelegateAuthorizer({
      assertCurrent,
      show: async (options) => {
        if (this.dialog === undefined) {
          throw new Error('Native Git filter confirmation is unavailable in this build.');
        }
        return (await this.dialog.showMessageBox(parent, options)).response;
      },
    });
    return await this.#repositories.git.withDelegateAuthorization(
      authorizeGitDelegates,
      async () => await this.prepare(event.sender, input, authorization, assertCurrent),
    );
  }

  async #dockerPreparationAuthorization(
    event: IpcMainInvokeEvent,
    input: PrepareRunInput,
    settings: AppSettings,
  ): Promise<AgentPreparationProcessAuthorization | undefined | null> {
    if (!requiresDockerPreparation(input, settings)) {
      return {
        authorize: () => {
          throw new Error(
            'Run preparation attempted an executable probe that was not present in the native disclosure.',
          );
        },
      };
    }
    if (!settings.dockerEnabled) {
      throw new Error('Enable and configure Docker isolation in Settings before using it.');
    }
    const executable = await resolveDockerExecutable(settings.dockerExecutable);
    const executableIdentity = await captureLaunchExecutableIdentity(executable);
    const approval: DockerPreparationApproval = {
      executable,
      executableIdentity,
      image: settings.dockerImage,
      expiresAtMs: this.now().getTime() + 5 * 60_000,
    };
    const parent = this.#requireLiveParent(event);
    if (this.dialog === undefined) {
      throw new Error('Native Docker probe confirmation is unavailable in this build.');
    }
    const decision = await this.dialog.showMessageBox(
      parent,
      dockerPreparationConfirmation(approval),
    );
    const ownerId = this.#ownerId(event.sender);
    this.#assertCurrent(event, parent, ownerId);
    if (decision.response !== 1 || approval.expiresAtMs <= this.now().getTime()) {
      this.#store.appendAudit('agent-run', 'docker-preparation-probes', 'denied', {
        adapterId: input.adapterId,
        executableSha256: approval.executableIdentity.digest,
        reason:
          decision.response === 1
            ? 'approval-expired-after-confirmation'
            : 'native-confirmation-cancelled',
      });
      return null;
    }
    const allowedCommands = new Set([
      JSON.stringify(['version', '--format', '{{.Server.Version}}']),
      JSON.stringify(['image', 'inspect', approval.image]),
    ]);
    return {
      authorize: async (currentExecutable, arguments_) => {
        this.#assertCurrent(event, parent, ownerId);
        if (
          approval.expiresAtMs <= this.now().getTime() ||
          currentExecutable !== approval.executable ||
          !allowedCommands.has(JSON.stringify(arguments_))
        ) {
          throw new Error('The approved Docker preparation probe changed or expired.');
        }
        const resolved = await resolveDockerExecutable(currentExecutable);
        if (resolved !== approval.executable) {
          throw new Error('The approved Docker executable changed. Review a fresh run.');
        }
        await assertLaunchExecutableIdentity(approval.executableIdentity);
        this.#assertCurrent(event, parent, ownerId);
      },
    };
  }

  async #confirmAndApprove(event: IpcMainInvokeEvent, runId: string): Promise<boolean> {
    this.#assertAvailable();
    const owner = event.sender;
    const ownerId = this.#ownerId(owner);
    const approval = this.#approvals.get(runId);
    if (approval === undefined) throw new Error('The prepared run no longer exists.');
    if (approval.ownerId !== ownerId || approval.owner !== owner) {
      throw new Error('The prepared run belongs to another Forgeboard window.');
    }
    const parent = this.#requireLiveParent(event);
    if (this.dialog === undefined) {
      throw new Error('Native agent launch confirmation is unavailable in this build.');
    }
    const decision = await this.dialog.showMessageBox(
      parent,
      runLaunchConfirmation(
        approval.disclosure,
        approval.disclosureFingerprint,
        approval.expiresAt,
      ),
    );
    const assertCurrent = (): void => this.#assertCurrent(event, parent, ownerId);
    assertCurrent();
    if (decision.response !== 1 || Date.parse(approval.expiresAt) <= this.now().getTime()) {
      this.#approvals.delete(runId);
      await this.#runtime.terminate(ownerId, approval.planId);
      this.#store.appendAudit('agent-run', 'renderer-launch-confirmation', 'denied', {
        runId,
        adapterId: approval.disclosure.adapterId,
        disclosureFingerprint: approval.disclosureFingerprint,
        reason:
          decision.response === 1
            ? 'approval-expired-after-confirmation'
            : 'native-confirmation-cancelled',
      });
      return false;
    }
    try {
      const currentContext = await this.#contextResolver.resolve(
        approval.input,
        this.getSettings(),
      );
      assertCurrent();
      if (currentContext.authority.fingerprint !== approval.contextAuthority.fingerprint) {
        throw new Error(
          'The Agent configuration or selected context changed after review. Review a fresh run.',
        );
      }
    } catch (error) {
      this.#approvals.delete(runId);
      const cleanupError = await this.#runtime
        .terminate(ownerId, approval.planId)
        .then(() => undefined)
        .catch((cause: unknown) => cause);
      this.#store.appendAudit('agent-run', 'renderer-launch-confirmation', 'denied', {
        runId,
        adapterId: approval.disclosure.adapterId,
        disclosureFingerprint: approval.disclosureFingerprint,
        reason: 'persisted-run-authority-changed',
      });
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [error, cleanupError],
          'The reviewed Agent context changed and its pending plan could not be terminated.',
        );
      }
      throw error;
    }
    this.#approvals.delete(runId);
    await this.#runtime.launch(
      ownerId,
      approval.planId,
      approval.disclosureFingerprint,
      assertCurrent,
    );
    return true;
  }

  public sendInput(owner: WebContents, runId: string, data: string): boolean {
    this.#assertAvailable();
    return this.#runtime.sendInput(this.#ownerId(owner), runId, data);
  }

  public interrupt(owner: WebContents, runId: string): boolean {
    this.#assertAvailable();
    return this.#runtime.interrupt(this.#ownerId(owner), runId);
  }

  public async terminate(owner: WebContents, runId: string): Promise<boolean> {
    this.#assertAvailable();
    const ownerId = this.#ownerId(owner);
    const approval = this.#approvals.get(runId);
    if (approval !== undefined && approval.ownerId !== ownerId) {
      return await this.#runtime.terminate(ownerId, approval.planId);
    }
    const terminated = await this.#runtime.terminate(ownerId, approval?.planId ?? runId);
    if (terminated) this.#approvals.delete(runId);
    return terminated;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of this.#registeredChannels) ipcMain.removeHandler(channel);
    this.#registeredChannels.length = 0;
    const resetOperation = this.#resetOperation;
    if (resetOperation !== null) await Promise.allSettled([resetOperation]);
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
    try {
      await this.#runtime.dispose();
    } finally {
      this.#approvals.clear();
      this.#executionSubscribers.clear();
      this.#owners.clear();
      this.#operations.clear();
    }
  }

  public resetForPrivacy(): Promise<void> {
    this.#assertAvailable();
    this.#privacyResetting = true;
    const resetting = this.#performPrivacyReset();
    this.#resetOperation = resetting;
    void resetting.then(
      () => {
        if (this.#resetOperation === resetting) this.#resetOperation = null;
      },
      () => {
        if (this.#resetOperation === resetting) this.#resetOperation = null;
      },
    );
    return resetting;
  }

  async #performPrivacyReset(): Promise<void> {
    try {
      while (this.#operations.size > 0) {
        await Promise.allSettled([...this.#operations]);
      }
      await this.#runtime.resetForPrivacy();
    } finally {
      this.#approvals.clear();
      this.#executionSubscribers.clear();
      this.#privacyResetting = false;
    }
  }

  public pauseForDataMutation(): void {
    this.#assertAvailable();
    this.#runtime.pauseForDataMutation();
  }

  public async pauseForShutdown(): Promise<void> {
    this.#assertAvailable();
    this.#shutdownPaused = true;
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
    await this.#runtime.pauseForShutdown();
  }

  public resumeAfterPrivacyReset(): void {
    if (!this.#disposed) {
      this.#shutdownPaused = false;
      this.#runtime.resumeAfterPrivacyReset();
    }
  }

  #ownerId(owner: WebContents): string {
    if (owner.isDestroyed()) throw new Error('The originating Forgeboard window is closed.');
    const existing = this.#ownerIds.get(owner);
    if (existing !== undefined) return existing;
    const ownerId = `web-contents:${String(owner.id)}:${randomUUID()}`;
    this.#ownerIds.set(owner, ownerId);
    this.#owners.set(ownerId, owner);
    owner.once('destroyed', () => {
      this.#ownerIds.delete(owner);
      if (this.#owners.get(ownerId) === owner) this.#owners.delete(ownerId);
      for (const [runId, approval] of this.#approvals) {
        if (approval.ownerId === ownerId) this.#approvals.delete(runId);
      }
      this.#stopDisconnectedOwner(ownerId);
    });
    return ownerId;
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The agent service is shutting down.');
    if (this.#shutdownPaused) throw new Error('Agent runs are paused while Forgeboard shuts down.');
    if (this.#privacyResetting) {
      throw new Error('Agent runs are paused while Forgeboard resets local data.');
    }
  }

  #requireLiveParent(
    event: IpcMainInvokeEvent,
    operation = 'Agent launch confirmation',
  ): BrowserWindow {
    this.#assertLiveMainFrame(event);
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (parent === null || parent.isDestroyed()) {
      throw new Error(`${operation} requires a live Forgeboard window.`);
    }
    return parent;
  }

  #assertCurrentWindow(event: IpcMainInvokeEvent, parent: BrowserWindow): void {
    this.#assertAvailable();
    this.#assertLiveMainFrame(event);
    if (parent.isDestroyed() || BrowserWindow.fromWebContents(event.sender) !== parent) {
      throw new Error('The originating Forgeboard window changed or closed.');
    }
  }

  #assertCurrent(event: IpcMainInvokeEvent, parent: BrowserWindow, ownerId: string): void {
    this.#assertCurrentWindow(event, parent);
    if (this.#owners.get(ownerId) !== event.sender) {
      throw new Error('The originating Forgeboard window changed or closed.');
    }
  }

  #assertLiveMainFrame(event: IpcMainInvokeEvent): void {
    if (event.sender.isDestroyed()) throw new Error('The originating Forgeboard window is closed.');
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Agent run controls are allowed only from the main Forgeboard frame.');
    }
  }

  #stopDisconnectedOwner(ownerId: string): void {
    if (this.#runtime.stopOwner === undefined || this.#disposed || this.#privacyResetting) {
      return;
    }
    let stopping: Promise<void>;
    try {
      stopping = this.#runtime.stopOwner(ownerId);
    } catch (error) {
      this.#auditOwnerStopFailure(ownerId, error);
      return;
    }
    const supervised = stopping.catch((error: unknown) => {
      this.#auditOwnerStopFailure(ownerId, error);
    });
    void this.#trackOperation(supervised);
  }

  #auditOwnerStopFailure(ownerId: string, error: unknown): void {
    try {
      this.#store.appendAudit('agent-run', 'owner-close', 'failed', {
        ownerId,
        reason: error instanceof Error ? error.message : 'Unknown owner cleanup failure',
      });
    } catch {
      // The local store may already be closing; process supervision must remain rejection-safe.
    }
  }

  #send(ownerId: string, envelope: RunEventEnvelope): void {
    const owner = this.#owners.get(ownerId);
    if (owner === undefined || owner.isDestroyed() || this.#disposed) return;
    owner.send(IPC_CHANNELS.runsEvent, RunEventEnvelopeSchema.parse(envelope));
  }

  #emitExecutionEvent(ownerId: string, untrustedEnvelope: RunEventEnvelope): void {
    const envelope = RunEventEnvelopeSchema.parse(untrustedEnvelope);
    this.#send(ownerId, envelope);
    const listeners = this.#executionSubscribers.get(ownerId);
    if (listeners === undefined || this.#disposed) return;
    for (const listener of [...listeners]) {
      try {
        listener(envelope);
      } catch {
        // One internal observer cannot disrupt process supervision or other exact-owner observers.
      }
    }
  }

  #trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation),
    );
    return operation;
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    schema: z.ZodType<Args>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    this.#registeredChannels.push(channel);
    ipcMain.handle(channel, async (event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
      try {
        this.#assertLiveMainFrame(event);
        const args = schema.parse(rawArgs);
        const value = await operation(event, ...args);
        this.#assertLiveMainFrame(event);
        return { ok: true, value };
      } catch (error) {
        const validation = error instanceof z.ZodError;
        return {
          ok: false,
          error: {
            code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
            message: validation
              ? 'Forgeboard rejected an invalid run request.'
              : error instanceof Error
                ? error.message
                : 'The agent operation failed.',
          },
        };
      }
    });
  }
}

function assertPreparedContextDisclosure(
  resolution: PersistedAgentContextResolution,
  disclosure: RunDisclosure,
): void {
  const expectedManifestId = resolution.context.manifestId ?? null;
  const expectedManifestDigest = resolution.context.manifestDigest ?? null;
  if (
    disclosure.contextManifestId !== expectedManifestId ||
    disclosure.contextManifestDigest !== expectedManifestDigest
  ) {
    throw new Error('The prepared Agent context manifest differs from the persisted selection.');
  }
  if (disclosure.contextAttachments.length !== resolution.context.attachments.length) {
    throw new Error('The prepared Agent context attachment count changed before disclosure.');
  }
  disclosure.contextAttachments.forEach((attachment, index) => {
    const expected = resolution.context.attachments[index];
    const expectedRelativePath = resolution.authority.relativePaths[index];
    if (
      expected === undefined ||
      expectedRelativePath === undefined ||
      attachment.kind !== 'file' ||
      attachment.sha256 !== expected.sha256 ||
      portableRelativePath(disclosure.cwd, attachment.path) !== expectedRelativePath
    ) {
      throw new Error('The prepared Agent context differs from the persisted File-node selection.');
    }
  });
}

function portableRelativePath(root: string, candidate: string): string {
  return path.relative(path.resolve(root), path.resolve(candidate)).split(path.sep).join('/');
}

async function testAgentCliPath(): Promise<string> {
  if (app.isPackaged) {
    const packagedPath = path.join(process.resourcesPath, 'test-agent', 'cli.js');
    await access(packagedPath);
    return packagedPath;
  }
  const candidates = [
    path.resolve(app.getAppPath(), '../../../../packages/test-agent/dist/cli.js'),
    path.resolve(process.cwd(), '../../packages/test-agent/dist/cli.js'),
    path.resolve(process.cwd(), 'packages/test-agent/dist/cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through fixed development locations without searching the filesystem.
    }
  }
  throw new Error('The bundled deterministic test agent is missing. Rebuild Forgeboard and retry.');
}

function runLaunchConfirmation(
  disclosure: RunDisclosure,
  disclosureFingerprint: string,
  expiresAt: string,
): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Launch agent process',
    message: `Launch ${disclosure.adapterId} for this node?`,
    detail: [
      `Provider: ${literal(disclosure.provider)}`,
      `Executable: ${literal(disclosure.executable)}`,
      `Arguments: ${JSON.stringify(disclosure.arguments)}`,
      `Working directory: ${literal(disclosure.cwd)}`,
      `Runtime: ${disclosure.runtime}`,
      `Environment variable names: ${JSON.stringify(disclosure.environmentVariableNames)}`,
      `Context attachments: ${JSON.stringify(disclosure.contextAttachments)}`,
      `Context manifest ID: ${literal(disclosure.contextManifestId ?? 'none')}`,
      `Context manifest SHA-256: ${literal(disclosure.contextManifestDigest ?? 'none')}`,
      `Permission profile: ${JSON.stringify(disclosure.permissionProfile)}`,
      `Branch: ${literal(disclosure.branch ?? 'none')}`,
      `Base commit: ${literal(disclosure.baseCommit ?? 'none')}`,
      `Disclosure SHA-256: ${disclosureFingerprint}`,
      `Approval expires at: ${expiresAt}`,
      '',
      ...disclosure.warnings,
      '',
      'Warning: the selected executable will run locally with the disclosed arguments and permissions. It may implement arbitrary effects and may contact the named provider.',
    ].join('\n'),
    buttons: ['Cancel', 'Launch agent'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function dockerPreparationConfirmation(approval: DockerPreparationApproval): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Inspect Docker for agent preparation',
    message: `Run Docker metadata probes for ${approval.image}?`,
    detail: [
      `Docker executable: ${literal(approval.executable)}`,
      `Executable SHA-256: ${approval.executableIdentity.digest}`,
      `Daemon command: ${JSON.stringify(['version', '--format', '{{.Server.Version}}'])}`,
      `Image command: ${JSON.stringify(['image', 'inspect', approval.image])}`,
      '',
      'Warning: the selected Docker executable will run locally. It can implement arbitrary effects. These probes inspect daemon and local image metadata only; they do not run or pull the image.',
    ].join('\n'),
    buttons: ['Cancel', 'Run Docker probes'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function requiresDockerPreparation(input: PrepareRunInput, settings: AppSettings): boolean {
  if (input.adapterId === 'test-agent') return false;
  return (
    input.permissionProfile === 'docker-isolated' ||
    (input.permissionProfile === 'custom' && settings.customPermissionProfile.runtime === 'docker')
  );
}

function literal(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
