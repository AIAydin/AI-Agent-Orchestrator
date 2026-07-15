import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';

import type { AgentAdapterManifest } from '@forgeboard/agent-adapters';
import { RepositoryService } from '@forgeboard/git-engine';
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { z } from 'zod';

import {
  IPC_CHANNELS,
  PrepareRunInputSchema,
  RunEventEnvelopeSchema,
  type AppSettings,
  type IpcResult,
  type PrepareRunInput,
  type RunDisclosure,
  type RunEventEnvelope,
} from '../shared/contracts.js';
import {
  type AgentExecutionEventSink,
  type AgentExecutionOperations,
  type TrustedAdapterLauncher,
} from './agent-execution/contracts.js';
import { AgentExecutionRuntime } from './agent-execution/runtime.js';
import type { LocalStore } from './storage.js';

const RunIdSchema = z.string().uuid();
const InputSchema = z
  .string()
  .max(1_000_000)
  .refine((value) => !value.includes('\0'), {
    message: 'Agent input cannot contain NUL bytes.',
  });

interface PreparedApproval {
  readonly disclosureFingerprint: string;
  readonly ownerId: string;
  readonly planId: string;
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
  readonly #runtime: AgentExecutionOperations;
  readonly #store: Pick<LocalStore, 'appendAudit'>;
  #disposed = false;
  #privacyResetting = false;
  #resetOperation: Promise<void> | null = null;

  public constructor(
    store: LocalStore,
    getSettings: () => AppSettings,
    getTrustedAdapter: (adapterId: string) => Promise<AgentAdapterManifest | undefined> = () =>
      Promise.resolve(undefined),
    launchTrustedAdapter?: TrustedAdapterLauncher,
    repositories: RepositoryService = new RepositoryService(),
    runtimeFactory?: RunServiceRuntimeFactory,
  ) {
    this.#store = store;
    const emit: AgentExecutionEventSink = (ownerId, envelope) => {
      this.#emitExecutionEvent(ownerId, envelope);
    };
    this.#runtime =
      runtimeFactory?.(emit) ??
      new AgentExecutionRuntime({
        store,
        getSettings,
        emit,
        getTrustedAdapter,
        ...(launchTrustedAdapter === undefined ? {} : { launchTrustedAdapter }),
        repositories,
        resolveTestAgentCliPath: testAgentCliPath,
      });
  }

  public registerIpcHandlers(): void {
    this.#handle(
      IPC_CHANNELS.runsPrepare,
      z.tuple([PrepareRunInputSchema]),
      async (event, input) => await this.#trackOperation(this.prepare(event.sender, input)),
    );
    this.#handle(
      IPC_CHANNELS.runsApprove,
      z.tuple([RunIdSchema]),
      async (event, runId) => await this.#trackOperation(this.approve(event.sender, runId)),
    );
    this.#handle(
      IPC_CHANNELS.runsInput,
      z.tuple([RunIdSchema, InputSchema]),
      (event, runId, data) => this.sendInput(event.sender, runId, data),
    );
    this.#handle(IPC_CHANNELS.runsInterrupt, z.tuple([RunIdSchema]), (event, runId) =>
      this.interrupt(event.sender, runId),
    );
    this.#handle(
      IPC_CHANNELS.runsTerminate,
      z.tuple([RunIdSchema]),
      async (event, runId) => await this.#trackOperation(this.terminate(event.sender, runId)),
    );
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

  public async prepare(owner: WebContents, input: PrepareRunInput): Promise<RunDisclosure> {
    this.#assertAvailable();
    const ownerId = this.#ownerId(owner);
    const prepared = await this.#runtime.prepare(ownerId, {
      ...input,
      context: { attachments: [] },
    });
    if (owner.isDestroyed() || this.#owners.get(ownerId) !== owner) {
      throw new Error('The originating Forgeboard window closed while preparing the agent run.');
    }
    this.#approvals.set(prepared.runId, {
      disclosureFingerprint: prepared.disclosureFingerprint,
      ownerId,
      planId: prepared.planId,
    });
    return prepared.disclosure;
  }

  public async approve(owner: WebContents, runId: string): Promise<boolean> {
    this.#assertAvailable();
    const ownerId = this.#ownerId(owner);
    const approval = this.#approvals.get(runId);
    if (approval === undefined) throw new Error('The prepared run no longer exists.');
    if (approval.ownerId !== ownerId) {
      await this.#runtime.launch(ownerId, approval.planId, approval.disclosureFingerprint);
      return true;
    }
    this.#approvals.delete(runId);
    await this.#runtime.launch(ownerId, approval.planId, approval.disclosureFingerprint);
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
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
    await this.#runtime.pauseForShutdown();
  }

  public resumeAfterPrivacyReset(): void {
    if (!this.#disposed) this.#runtime.resumeAfterPrivacyReset();
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
    if (this.#privacyResetting) {
      throw new Error('Agent runs are paused while Forgeboard resets local data.');
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
        const args = schema.parse(rawArgs);
        return { ok: true, value: await operation(event, ...args) };
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
