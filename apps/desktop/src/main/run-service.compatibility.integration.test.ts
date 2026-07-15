import type { RepositoryService } from '@forgeboard/git-engine';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  IPC_CHANNELS,
  type AppSettings,
  type PrepareRunInput,
  type RunEventEnvelope,
} from '../shared/contracts.js';
import type {
  AgentExecutionEventSink,
  AgentExecutionLaunchHandle,
  AgentExecutionOperations,
  AgentExecutionRequest,
  PreparedAgentExecution,
} from './agent-execution/contracts.js';
import { RunService } from './run-service.js';
import type { LocalStore } from './storage.js';

const electronMock = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: { readonly sender: unknown }, ...arguments_: unknown[]) => Promise<unknown>
  >(),
  removed: [] as string[],
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app/apps/desktop',
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: { readonly sender: unknown }, ...arguments_: unknown[]) => Promise<unknown>,
    ) => {
      electronMock.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      electronMock.handlers.delete(channel);
      electronMock.removed.push(channel);
    },
  },
}));

const PROJECT_ID = '123fae6e-e213-4a10-a0db-0f85b791f7e9';
const PREPARE_INPUT: PrepareRunInput = {
  projectId: PROJECT_ID,
  nodeId: 'agent-node',
  adapterId: 'test-agent',
  prompt: 'Inspect this repository.',
  permissionProfile: 'plan-read-only',
};

class FakeAgentExecutionRuntime implements AgentExecutionOperations {
  readonly prepareCalls: Array<{
    readonly ownerId: string;
    readonly input: AgentExecutionRequest;
  }> = [];
  readonly launchCalls: Array<{
    readonly ownerId: string;
    readonly planId: string;
    readonly disclosureFingerprint: string;
  }> = [];
  readonly inputCalls: Array<{
    readonly ownerId: string;
    readonly runId: string;
    readonly data: string;
  }> = [];
  readonly interruptCalls: Array<{ readonly ownerId: string; readonly runId: string }> = [];
  readonly terminateCalls: Array<{ readonly ownerId: string; readonly runId: string }> = [];
  readonly stopOwnerCalls: string[] = [];
  disposed = false;
  paused = false;
  reset = false;
  prepareGate: Promise<void> | undefined;
  resetResult: Promise<void> | undefined;
  stopOwnerResult: Promise<void> | undefined;
  stopOwnerError: Error | undefined;
  #nextRun = 1;

  public async prepare(
    ownerId: string,
    input: AgentExecutionRequest,
  ): Promise<PreparedAgentExecution> {
    this.prepareCalls.push({ ownerId, input });
    const runId = `00000000-0000-4000-8000-${String(this.#nextRun).padStart(12, '0')}`;
    this.#nextRun += 1;
    if (this.prepareGate !== undefined) await this.prepareGate;
    return {
      planId: runId,
      runId,
      ownerId,
      disclosure: {
        runId,
        nodeId: input.nodeId,
        adapterId: input.adapterId,
        provider: 'Local test provider',
        executable: '/test-agent',
        arguments: [],
        cwd: '/repo',
        runtime: 'pipes',
        environmentVariableNames: [],
        contextAttachments: [],
        contextManifestId: input.context.manifestId ?? null,
        contextManifestDigest: input.context.manifestDigest ?? null,
        permissionProfile: {
          name: 'Read only',
          mode: 'plan-read-only',
          enforcement: 'provider',
          readRoots: ['/repo'],
          writeRoots: [],
          network: 'blocked',
        },
        warnings: [],
        branch: 'main',
        baseCommit: '1'.repeat(40),
        primaryWasDirty: false,
      },
      disclosureFingerprint: 'a'.repeat(64),
      expiresAt: '2026-07-15T12:01:00.000Z',
    };
  }

  public launch(
    ownerId: string,
    planId: string,
    disclosureFingerprint: string,
  ): Promise<AgentExecutionLaunchHandle> {
    this.launchCalls.push({ ownerId, planId, disclosureFingerprint });
    return Promise.resolve({
      runId: planId,
      process: null,
      completion: Promise.resolve({
        runId: planId,
        nodeId: 'agent-node',
        status: 'succeeded',
        exitCode: 0,
        startedAt: '2026-07-15T12:00:00.000Z',
        endedAt: '2026-07-15T12:00:01.000Z',
        changedFiles: [],
        outputDigest: 'b'.repeat(64),
        branch: 'main',
        worktreePath: null,
      }),
      writeInput: () => undefined,
      interrupt: () => undefined,
      terminate: () => Promise.resolve(),
    });
  }

  public sendInput(ownerId: string, runId: string, data: string): boolean {
    this.inputCalls.push({ ownerId, runId, data });
    return true;
  }

  public interrupt(ownerId: string, runId: string): boolean {
    this.interruptCalls.push({ ownerId, runId });
    return true;
  }

  public terminate(ownerId: string, runId: string): Promise<boolean> {
    this.terminateCalls.push({ ownerId, runId });
    return Promise.resolve(true);
  }

  public stopOwner(ownerId: string): Promise<void> {
    this.stopOwnerCalls.push(ownerId);
    if (this.stopOwnerError !== undefined) return Promise.reject(this.stopOwnerError);
    return this.stopOwnerResult ?? Promise.resolve();
  }

  public resetForPrivacy(): Promise<void> {
    this.reset = true;
    return this.resetResult ?? Promise.resolve();
  }

  public pauseForDataMutation(): void {
    this.paused = true;
  }

  public pauseForShutdown(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  public resumeAfterPrivacyReset(): void {
    this.paused = false;
  }

  public dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

describe('RunService Electron compatibility', () => {
  it('delivers main-process execution events only to the exact opaque owner subscription', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const { emit, service } = serviceHarness(runtime);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = service.subscribeExecutionEvents('workflow:first', first);
    service.subscribeExecutionEvents('workflow:second', second);
    const event = runSummary('00000000-0000-4000-8000-000000000099', 'agent-node');

    emit('workflow:first', event);
    expect(first).toHaveBeenCalledWith(event);
    expect(second).not.toHaveBeenCalled();

    unsubscribe();
    emit('workflow:first', event);
    expect(first).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('preserves IPC contracts while routing execution through opaque string owners', async () => {
    electronMock.handlers.clear();
    electronMock.removed.length = 0;
    const runtime = new FakeAgentExecutionRuntime();
    let emit: AgentExecutionEventSink | undefined;
    const service = new RunService(
      {} as LocalStore,
      () => ({}) as AppSettings,
      () => Promise.resolve(undefined),
      undefined,
      {} as RepositoryService,
      (eventSink) => {
        emit = eventSink;
        return runtime;
      },
    );
    const firstOwner = webContents(7);
    const secondOwner = webContents(8);
    service.registerIpcHandlers();

    const prepareHandler = requiredHandler(IPC_CHANNELS.runsPrepare);
    const firstPrepared = await prepareHandler({ sender: firstOwner.owner }, PREPARE_INPUT);
    const secondPrepared = await prepareHandler({ sender: secondOwner.owner }, PREPARE_INPUT);

    expect(firstPrepared).toMatchObject({ ok: true, value: { nodeId: 'agent-node' } });
    expect(secondPrepared).toMatchObject({ ok: true, value: { nodeId: 'agent-node' } });
    expect(runtime.prepareCalls[0]?.input.context).toEqual({ attachments: [] });
    expect(runtime.prepareCalls[0]?.ownerId).toMatch(/^web-contents:7:/u);
    expect(runtime.prepareCalls[1]?.ownerId).toMatch(/^web-contents:8:/u);
    expect(runtime.prepareCalls[0]?.ownerId).not.toBe(runtime.prepareCalls[1]?.ownerId);

    const firstRunId = runtime.prepareCalls.length > 0 ? extractRunId(firstPrepared) : '';
    const approveHandler = requiredHandler(IPC_CHANNELS.runsApprove);
    await expect(approveHandler({ sender: firstOwner.owner }, firstRunId)).resolves.toEqual({
      ok: true,
      value: true,
    });
    expect(runtime.launchCalls).toEqual([
      {
        ownerId: runtime.prepareCalls[0]?.ownerId,
        planId: firstRunId,
        disclosureFingerprint: 'a'.repeat(64),
      },
    ]);

    const envelope: RunEventEnvelope = {
      runId: firstRunId,
      nodeId: 'agent-node',
      kind: 'run-summary',
      payload: { status: 'succeeded' },
    };
    emit?.(runtime.prepareCalls[0]?.ownerId ?? '', envelope);
    expect(firstOwner.sent).toEqual([[IPC_CHANNELS.runsEvent, envelope]]);
    expect(secondOwner.sent).toEqual([]);

    const invalid = await prepareHandler(
      { sender: firstOwner.owner },
      { ...PREPARE_INPUT, prompt: '' },
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });

    await service.dispose();
    expect(runtime.disposed).toBe(true);
    expect(electronMock.removed).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.runsPrepare,
        IPC_CHANNELS.runsApprove,
        IPC_CHANNELS.runsInput,
        IPC_CHANNELS.runsInterrupt,
        IPC_CHANNELS.runsTerminate,
      ]),
    );
  });

  it('releases only the destroyed window owner and removes its approval and event route', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const { emit, service } = serviceHarness(runtime);
    const firstOwner = webContents(7);
    const secondOwner = webContents(8);
    const firstDisclosure = await service.prepare(firstOwner.owner, PREPARE_INPUT);
    const secondDisclosure = await service.prepare(secondOwner.owner, {
      ...PREPARE_INPUT,
      nodeId: 'second-agent-node',
    });
    const firstOwnerId = runtime.prepareCalls[0]?.ownerId ?? '';
    const secondOwnerId = runtime.prepareCalls[1]?.ownerId ?? '';

    firstOwner.destroy();
    firstOwner.destroy();

    expect(runtime.stopOwnerCalls).toEqual([firstOwnerId]);
    emit(firstOwnerId, runSummary(firstDisclosure.runId, 'agent-node'));
    emit(secondOwnerId, runSummary(secondDisclosure.runId, 'second-agent-node'));
    expect(firstOwner.sent).toEqual([]);
    expect(secondOwner.sent).toEqual([
      [IPC_CHANNELS.runsEvent, runSummary(secondDisclosure.runId, 'second-agent-node')],
    ]);

    const reusedNumericId = webContents(7);
    await expect(service.approve(reusedNumericId.owner, firstDisclosure.runId)).rejects.toThrow(
      'prepared run no longer exists',
    );
    await expect(service.approve(secondOwner.owner, secondDisclosure.runId)).resolves.toBe(true);
    expect(runtime.launchCalls).toEqual([
      {
        ownerId: secondOwnerId,
        planId: secondDisclosure.runId,
        disclosureFingerprint: 'a'.repeat(64),
      },
    ]);
    await service.dispose();
  });

  it('does not recreate an approval when preparation finishes after its window closes', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const preparation = deferred<void>();
    runtime.prepareGate = preparation.promise;
    const { service } = serviceHarness(runtime);
    const owner = webContents(7);
    const preparing = service.prepare(owner.owner, PREPARE_INPUT);
    await vi.waitFor(() => expect(runtime.prepareCalls).toHaveLength(1));

    owner.destroy();
    preparation.resolve();

    await expect(preparing).rejects.toThrow('window closed while preparing');
    expect(runtime.stopOwnerCalls).toEqual([runtime.prepareCalls[0]?.ownerId]);
    const reusedNumericId = webContents(7);
    await expect(
      service.approve(reusedNumericId.owner, '00000000-0000-4000-8000-000000000001'),
    ).rejects.toThrow('prepared run no longer exists');
    await service.dispose();
  });

  it('audits a rejected owner cleanup without leaking an unhandled rejection', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    runtime.stopOwnerError = new Error('termination failed');
    const { appendAudit, service } = serviceHarness(runtime);
    appendAudit.mockImplementationOnce(() => {
      throw new Error('local store already closed');
    });
    const owner = webContents(7);
    await service.prepare(owner.owner, PREPARE_INPUT);

    owner.destroy();

    await vi.waitFor(() =>
      expect(appendAudit).toHaveBeenCalledWith(
        'agent-run',
        'owner-close',
        'failed',
        expect.objectContaining({
          ownerId: runtime.prepareCalls[0]?.ownerId,
          reason: 'termination failed',
        }),
      ),
    );
    await expect(service.dispose()).resolves.toBeUndefined();
  });

  it('drains owner cleanup before privacy reset and disposal race the runtime', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const cleanup = deferred<void>();
    runtime.stopOwnerResult = cleanup.promise;
    const { service } = serviceHarness(runtime);
    const owner = webContents(7);
    await service.prepare(owner.owner, PREPARE_INPUT);
    owner.destroy();

    const resetting = service.resetForPrivacy();
    const disposing = service.dispose();
    await Promise.resolve();
    expect(runtime.reset).toBe(false);
    expect(runtime.disposed).toBe(false);

    cleanup.resolve();

    await expect(resetting).resolves.toBeUndefined();
    await expect(disposing).resolves.toBeUndefined();
    expect(runtime.reset).toBe(true);
    expect(runtime.disposed).toBe(true);
  });
});

function serviceHarness(runtime: FakeAgentExecutionRuntime): {
  readonly appendAudit: ReturnType<typeof vi.fn>;
  readonly emit: AgentExecutionEventSink;
  readonly service: RunService;
} {
  const appendAudit = vi.fn();
  let emit!: AgentExecutionEventSink;
  const service = new RunService(
    { appendAudit } as unknown as LocalStore,
    () => ({}) as AppSettings,
    () => Promise.resolve(undefined),
    undefined,
    {} as RepositoryService,
    (eventSink) => {
      emit = eventSink;
      return runtime;
    },
  );
  return { appendAudit, emit, service };
}

function runSummary(runId: string, nodeId: string): RunEventEnvelope {
  return {
    runId,
    nodeId,
    kind: 'run-summary',
    payload: { status: 'succeeded' },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function webContents(id: number): {
  readonly owner: WebContents;
  readonly sent: Array<readonly [string, unknown]>;
  destroy(): void;
} {
  const sent: Array<readonly [string, unknown]> = [];
  let destroyed = false;
  let destroyedListener: (() => void) | undefined;
  return {
    owner: {
      id,
      isDestroyed: () => destroyed,
      once: (event: string, listener: () => void) => {
        if (event === 'destroyed') destroyedListener = listener;
      },
      send: (channel: string, value: unknown) => {
        sent.push([channel, value]);
      },
    } as unknown as WebContents,
    sent,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      const listener = destroyedListener;
      destroyedListener = undefined;
      listener?.();
    },
  };
}

function requiredHandler(
  channel: string,
): (event: { readonly sender: unknown }, ...arguments_: unknown[]) => Promise<unknown> {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler for ${channel}.`);
  return handler;
}

function extractRunId(result: unknown): string {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('value' in result) ||
    typeof result.value !== 'object' ||
    result.value === null ||
    !('runId' in result.value) ||
    typeof result.value.runId !== 'string'
  ) {
    throw new Error('Prepared IPC result did not contain a run ID.');
  }
  return result.value.runId;
}
