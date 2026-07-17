import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RepositoryService } from '@forgeboard/git-engine';
import { RepositoryService as RealRepositoryService } from '@forgeboard/git-engine';
import type { IpcMainInvokeEvent, MessageBoxOptions, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  IPC_CHANNELS,
  type AppSettings,
  type CanvasDocument,
  type PrepareRunInput,
  type RunEventEnvelope,
} from '../../shared/application/contracts.js';
import type {
  AgentExecutionEventSink,
  AgentExecutionLaunchHandle,
  AgentExecutionOperations,
  AgentExecutionRequest,
  PreparedAgentExecution,
} from '../agent-execution/contracts.js';
import type {
  AgentRunContextResolver,
  PersistedAgentContextResolution,
} from './context/persisted-agent-context.js';
import { RunService } from './run-service.js';
import type { RunServicePersistedLaunchAuthorizer } from './run-service.js';
import type { LocalStore } from '../storage.js';
import type { StoredRunRecord } from '../storage-schemas.js';

const electronMock = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: { readonly sender: unknown }, ...arguments_: unknown[]) => Promise<unknown>
  >(),
  removed: [] as string[],
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app/apps/desktop',
  },
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
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
  readonly continuationCalls: Array<{
    readonly action: 'resume' | 'retry';
    readonly ownerId: string;
    readonly parentRunId: string;
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
  launchAuthorizationGate: Promise<void> | undefined;
  resetResult: Promise<void> | undefined;
  stopOwnerResult: Promise<void> | undefined;
  stopOwnerError: Error | undefined;
  beforeAuthorizeLaunch: (() => void) | undefined;
  prepareAction: (() => Promise<void>) | undefined;
  omitContextDisclosure = false;
  #nextRun = 1;

  public async prepare(
    ownerId: string,
    input: AgentExecutionRequest,
  ): Promise<PreparedAgentExecution> {
    this.prepareCalls.push({ ownerId, input });
    await this.prepareAction?.();
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
        contextAttachments: this.omitContextDisclosure
          ? []
          : input.context.attachments.map((attachment) => ({
              path: attachment.path,
              kind: attachment.kind,
              sha256: attachment.sha256!,
            })),
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

  public prepareResume(
    ownerId: string,
    parentRunId: string,
    input: AgentExecutionRequest,
  ): Promise<PreparedAgentExecution> {
    this.continuationCalls.push({ action: 'resume', ownerId, parentRunId });
    return this.prepare(ownerId, input);
  }

  public prepareRetry(
    ownerId: string,
    parentRunId: string,
    input: AgentExecutionRequest,
  ): Promise<PreparedAgentExecution> {
    this.continuationCalls.push({ action: 'retry', ownerId, parentRunId });
    return this.prepare(ownerId, input);
  }

  public async launch(
    ownerId: string,
    planId: string,
    disclosureFingerprint: string,
    authorizeLaunch?: () => void,
  ): Promise<AgentExecutionLaunchHandle> {
    this.beforeAuthorizeLaunch?.();
    if (this.launchAuthorizationGate !== undefined) await this.launchAuthorizationGate;
    authorizeLaunch?.();
    this.launchCalls.push({ ownerId, planId, disclosureFingerprint });
    return {
      runId: planId,
      process: null,
      capabilities: {
        interactiveInput: true,
        interrupt: true,
        terminate: true,
        pause: false,
        resume: false,
        source: 'manifest',
      },
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
        worktreeId: null,
        worktreePath: null,
        capabilities: {
          interactiveInput: true,
          interrupt: true,
          terminate: true,
          pause: false,
          resume: false,
          source: 'manifest',
        },
      }),
      writeInput: () => undefined,
      interrupt: () => undefined,
      terminate: () => Promise.resolve(),
    };
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
  it('lists bounded path-free project and node attempt history for the current window', async () => {
    const available = storedRun('00000000-0000-4000-8000-000000000091', {
      model: 'provider-model-1',
      providerSessionId: 'provider-session-7',
      action: 'retry',
      parentRunId: '00000000-0000-4000-8000-000000000090',
      tokenUsage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
      costUsd: 0.0042,
      outputPreview: 'Changed /repo/.forgeboard/worktrees/agent-node/src/a.ts',
    });
    const legacy = storedRun('00000000-0000-4000-8000-000000000092', {
      status: 'failed',
      managedRoot: null,
      repositoryRoot: null,
      baseRef: null,
      baseCommit: null,
    });
    const runtime = new FakeAgentExecutionRuntime();
    const { listProjectRuns, service } = serviceHarness(runtime, {
      runRecords: [
        available,
        legacy,
        storedRun('00000000-0000-4000-8000-000000000093', {
          status: 'running',
          endedAt: null,
        }),
        storedRun('00000000-0000-4000-8000-000000000094', { worktreeId: null }),
      ],
    });
    const owner = webContents(6);
    const handler = requiredHandler(IPC_CHANNELS.runsList);

    await expect(
      handler(invokeEvent(owner.owner), { projectId: PROJECT_ID, limit: 20 }),
    ).resolves.toEqual({
      ok: true,
      value: [
        {
          id: available.id,
          projectId: PROJECT_ID,
          nodeId: 'agent-node',
          adapterId: 'test-agent',
          model: 'provider-model-1',
          permissionProfile: null,
          providerSessionAvailable: true,
          resumeSupported: false,
          resumeCapabilitySource: null,
          action: 'retry',
          parentRunId: '00000000-0000-4000-8000-000000000090',
          status: 'succeeded',
          branch: 'forgeboard/agent-node',
          worktreeState: 'active',
          worktreeAvailable: true,
          supersededByNewerAttempt: false,
          startedAt: '2026-07-15T12:00:00.000Z',
          endedAt: '2026-07-15T12:01:00.000Z',
          exitCode: 0,
          outputDigest: null,
          changedFileCount: null,
          tokenUsage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
          costUsd: 0.0042,
          outputPreview: 'Changed <run-worktree>/src/a.ts',
          createdAt: '2026-07-15T11:59:00.000Z',
          updatedAt: '2026-07-15T12:01:00.000Z',
        },
        expect.objectContaining({ id: legacy.id, worktreeAvailable: false }),
        expect.objectContaining({
          id: '00000000-0000-4000-8000-000000000093',
          status: 'running',
          endedAt: null,
        }),
        expect.objectContaining({
          id: '00000000-0000-4000-8000-000000000094',
          worktreeState: 'none',
          worktreeAvailable: false,
        }),
      ],
    });
    expect(listProjectRuns).toHaveBeenCalledWith(PROJECT_ID, 20, undefined);
    const result = await handler(invokeEvent(owner.owner), { projectId: PROJECT_ID, limit: 20 });
    expect(JSON.stringify(result)).not.toMatch(
      /cwd|repositoryRoot|managedRoot|worktreeId|\/repo/iu,
    );

    listProjectRuns.mockClear();
    await expect(
      handler(invokeEvent(owner.owner), {
        projectId: PROJECT_ID,
        nodeId: 'agent-node',
        limit: 5,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(listProjectRuns).toHaveBeenCalledWith(PROJECT_ID, 5, 'agent-node');

    listProjectRuns.mockClear();
    await expect(
      handler(invokeEvent(owner.owner), { projectId: PROJECT_ID, limit: 201 }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(listProjectRuns).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('gets one exact path-free run only when it belongs to the requested project', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const run = storedRun('00000000-0000-4000-8000-000000000095');
    const { service } = serviceHarness(runtime, { runRecords: [run] });
    const handler = requiredHandler(IPC_CHANNELS.runsGet);
    const event = invokeEvent(webContents(95).owner);

    await expect(handler(event, { projectId: PROJECT_ID, runId: run.id })).resolves.toMatchObject({
      ok: true,
      value: { id: run.id, projectId: PROJECT_ID },
    });
    await expect(
      handler(event, {
        projectId: '223fae6e-e213-4a10-a0db-0f85b791f7e9',
        runId: run.id,
      }),
    ).resolves.toEqual({ ok: true, value: null });
    await service.dispose();
  });

  it('rejects run-history subframes and a window replacement before returning storage data', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const { listProjectRuns, service } = serviceHarness(runtime, {
      runRecords: [storedRun('00000000-0000-4000-8000-000000000095')],
    });
    const owner = webContents(5);
    const handler = requiredHandler(IPC_CHANNELS.runsList);
    const subframe = invokeEvent(owner.owner);
    Object.defineProperty(subframe, 'senderFrame', { value: {} });

    await expect(handler(subframe, { projectId: PROJECT_ID, limit: 20 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(listProjectRuns).not.toHaveBeenCalled();

    const originalParent = { isDestroyed: () => false };
    const replacementParent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(originalParent);
    listProjectRuns.mockImplementationOnce(() => {
      electronMock.fromWebContents.mockReturnValue(replacementParent);
      return [];
    });
    const replacedWindowResult = await handler(invokeEvent(owner.owner), {
      projectId: PROJECT_ID,
      limit: 20,
    });
    expect(replacedWindowResult).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(JSON.stringify(replacedWindowResult)).toContain('changed or closed');
    await service.dispose();
  });

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
      {
        appendAudit: vi.fn(),
        getRun: () => undefined,
        listProjectRuns: () => [],
        loadCanvas: () => undefined,
      } as unknown as LocalStore,
      () => ({}) as AppSettings,
      () => Promise.resolve(undefined),
      undefined,
      repositoryService(),
      (eventSink) => {
        emit = eventSink;
        return runtime;
      },
      { showMessageBox: () => Promise.resolve({ response: 1, checkboxChecked: false }) },
      () => new Date('2026-07-15T12:00:00.000Z'),
      emptyContextResolver(),
      undefined,
      () => undefined,
    );
    const firstOwner = webContents(7);
    const secondOwner = webContents(8);
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    service.registerIpcHandlers();

    const prepareHandler = requiredHandler(IPC_CHANNELS.runsPrepare);
    const firstPrepared = await prepareHandler(invokeEvent(firstOwner.owner), PREPARE_INPUT);
    const secondPrepared = await prepareHandler(invokeEvent(secondOwner.owner), PREPARE_INPUT);

    expect(firstPrepared).toMatchObject({ ok: true, value: { nodeId: 'agent-node' } });
    expect(secondPrepared).toMatchObject({ ok: true, value: { nodeId: 'agent-node' } });
    expect(runtime.prepareCalls[0]?.input.context).toEqual({ attachments: [] });
    expect(runtime.prepareCalls[0]?.ownerId).toMatch(/^web-contents:7:/u);
    expect(runtime.prepareCalls[1]?.ownerId).toMatch(/^web-contents:8:/u);
    expect(runtime.prepareCalls[0]?.ownerId).not.toBe(runtime.prepareCalls[1]?.ownerId);

    const parentRunId = '00000000-0000-4000-8000-000000000090';
    const resumed = await requiredHandler(IPC_CHANNELS.runsResume)(invokeEvent(firstOwner.owner), {
      ...PREPARE_INPUT,
      parentRunId,
    });
    const retried = await requiredHandler(IPC_CHANNELS.runsRetry)(invokeEvent(firstOwner.owner), {
      ...PREPARE_INPUT,
      parentRunId,
    });
    expect(resumed).toMatchObject({ ok: true, value: { nodeId: 'agent-node' } });
    expect(retried).toMatchObject({ ok: true, value: { nodeId: 'agent-node' } });
    expect(runtime.continuationCalls).toEqual([
      { action: 'resume', ownerId: runtime.prepareCalls[0]?.ownerId, parentRunId },
      { action: 'retry', ownerId: runtime.prepareCalls[0]?.ownerId, parentRunId },
    ]);
    await expect(
      requiredHandler(IPC_CHANNELS.runsResume)(invokeEvent(firstOwner.owner), {
        ...PREPARE_INPUT,
        parentRunId,
        worktreePath: '/private/managed',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });

    const firstRunId = runtime.prepareCalls.length > 0 ? extractRunId(firstPrepared) : '';
    const approveHandler = requiredHandler(IPC_CHANNELS.runsApprove);
    await expect(approveHandler(invokeEvent(firstOwner.owner), firstRunId)).resolves.toEqual({
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

    const invalid = await prepareHandler(invokeEvent(firstOwner.owner), {
      ...PREPARE_INPUT,
      prompt: '',
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });

    await service.dispose();
    expect(runtime.disposed).toBe(true);
    expect(electronMock.removed).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.runsPrepare,
        IPC_CHANNELS.runsGet,
        IPC_CHANNELS.runsResume,
        IPC_CHANNELS.runsRetry,
        IPC_CHANNELS.runsApprove,
        IPC_CHANNELS.runsInput,
        IPC_CHANNELS.runsInterrupt,
        IPC_CHANNELS.runsTerminate,
      ]),
    );
  });

  it('denies renderer Agent mutations through the main collaboration gate while preserving termination', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const authorizeMutation = vi.fn(() => {
      throw new Error('This collaboration role cannot mutate a local coding agent.');
    });
    const { service } = serviceHarness(runtime, { authorizeMutation });
    const owner = webContents(91);
    const event = invokeEvent(owner.owner);
    const runId = '00000000-0000-4000-8000-000000000091';

    await expect(
      requiredHandler(IPC_CHANNELS.runsPrepare)(event, PREPARE_INPUT),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    for (const channel of [IPC_CHANNELS.runsResume, IPC_CHANNELS.runsRetry]) {
      await expect(
        requiredHandler(channel)(event, { ...PREPARE_INPUT, parentRunId: runId }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    }
    await expect(requiredHandler(IPC_CHANNELS.runsApprove)(event, runId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    await expect(
      requiredHandler(IPC_CHANNELS.runsInput)(event, runId, 'input'),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    await expect(requiredHandler(IPC_CHANNELS.runsInterrupt)(event, runId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    await expect(requiredHandler(IPC_CHANNELS.runsTerminate)(event, runId)).resolves.toEqual({
      ok: true,
      value: true,
    });

    expect(runtime.prepareCalls).toEqual([]);
    expect(runtime.inputCalls).toEqual([]);
    expect(runtime.interruptCalls).toEqual([]);
    expect(runtime.terminateCalls).toEqual([expect.objectContaining({ runId })]);
    expect(authorizeMutation).toHaveBeenCalledTimes(6);
    await service.dispose();
  });

  it('fails input and interrupt closed when durable Agent node authority is missing', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const { service } = serviceHarness(runtime);
    const event = invokeEvent(webContents(92).owner);
    const runId = '00000000-0000-4000-8000-000000000092';

    for (const channel of [IPC_CHANNELS.runsInput, IPC_CHANNELS.runsInterrupt]) {
      const arguments_ = channel === IPC_CHANNELS.runsInput ? [runId, 'input'] : [runId];
      const result = await requiredHandler(channel)(event, ...arguments_);
      expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
      expect(JSON.stringify(result)).toMatch(/durable node authority/iu);
    }
    expect(runtime.inputCalls).toEqual([]);
    expect(runtime.interruptCalls).toEqual([]);
    await service.dispose();
  });

  it('denies input and interrupt after the same Agent node points to a superseding run', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const oldRunId = '00000000-0000-4000-8000-000000000092';
    const newRunId = '00000000-0000-4000-8000-000000000093';
    const { service } = serviceHarness(runtime, {
      runRecords: [storedRun(oldRunId, { status: 'running', endedAt: null })],
      canvasDocument: agentCanvas(newRunId),
    });
    const event = invokeEvent(webContents(93).owner);

    for (const channel of [IPC_CHANNELS.runsInput, IPC_CHANNELS.runsInterrupt]) {
      const arguments_ = channel === IPC_CHANNELS.runsInput ? [oldRunId, 'input'] : [oldRunId];
      const result = await requiredHandler(channel)(event, ...arguments_);
      expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
      expect(JSON.stringify(result)).toMatch(/another run/iu);
    }
    expect(runtime.inputCalls).toEqual([]);
    expect(runtime.interruptCalls).toEqual([]);
    await service.dispose();
  });

  it('passes the exact persisted context manifest into ordinary preparation and disclosure', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const resolution = linkedContextResolution();
    const resolve = vi.fn().mockResolvedValue(resolution);
    const { service, showMessageBox } = serviceHarness(runtime, { contextResolver: { resolve } });
    const owner = webContents(9);

    const disclosure = await service.prepare(owner.owner, PREPARE_INPUT);

    expect(runtime.prepareCalls[0]?.input.context).toEqual(resolution.context);
    expect(disclosure).toMatchObject({
      contextAttachments: [
        {
          path: '/repo/src/context.ts',
          kind: 'file',
          sha256: 'd'.repeat(64),
        },
      ],
      contextManifestId: 'manifest-1',
      contextManifestDigest: 'e'.repeat(64),
    });
    expect(resolve).toHaveBeenCalledWith(PREPARE_INPUT, expect.anything());
    await expect(
      requiredHandler(IPC_CHANNELS.runsApprove)(invokeEvent(owner.owner), disclosure.runId),
    ).resolves.toMatchObject({ ok: true });
    expect(shownMessage(showMessageBox).detail).toContain('Context manifest ID: manifest-1');
    expect(shownMessage(showMessageBox).detail).toContain(
      `Context manifest SHA-256: ${'e'.repeat(64)}`,
    );
    await service.dispose();
  });

  it('terminates a prepared plan when the runtime omits reviewed context from disclosure', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    runtime.omitContextDisclosure = true;
    const resolution = linkedContextResolution();
    const { service } = serviceHarness(runtime, {
      contextResolver: { resolve: () => Promise.resolve(resolution) },
    });
    const owner = webContents(10);

    await expect(service.prepare(owner.owner, PREPARE_INPUT)).rejects.toThrow(
      /attachment count changed/iu,
    );
    expect(runtime.launchCalls).toEqual([]);
    expect(runtime.terminateCalls).toEqual([
      expect.objectContaining({ runId: '00000000-0000-4000-8000-000000000001' }),
    ]);
    await service.dispose();
  });

  it('fails closed when a linked file changes after Review but before native approval', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(linkedContextResolution())
      .mockResolvedValueOnce(
        linkedContextResolution({ contentHash: 'f'.repeat(64), fingerprint: '1'.repeat(64) }),
      );
    const { service } = serviceHarness(runtime, { contextResolver: { resolve } });
    const owner = webContents(11);
    const disclosure = await service.prepare(owner.owner, PREPARE_INPUT);

    await expect(
      requiredHandler(IPC_CHANNELS.runsApprove)(invokeEvent(owner.owner), disclosure.runId),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(runtime.launchCalls).toEqual([]);
    expect(runtime.terminateCalls).toEqual([expect.objectContaining({ runId: disclosure.runId })]);
    await service.dispose();
  });

  it('fails closed when the persisted Agent configuration changes after Review', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(linkedContextResolution())
      .mockRejectedValueOnce(
        new Error('The saved Agent prompt changed. Save and review a fresh run.'),
      );
    const { service } = serviceHarness(runtime, { contextResolver: { resolve } });
    const owner = webContents(12);
    const disclosure = await service.prepare(owner.owner, PREPARE_INPUT);

    await expect(
      requiredHandler(IPC_CHANNELS.runsApprove)(invokeEvent(owner.owner), disclosure.runId),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(runtime.launchCalls).toEqual([]);
    expect(runtime.terminateCalls).toHaveLength(1);
    await service.dispose();
  });

  it('keeps native launch cancellation non-executing and consumes the prepared run', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const { service, showMessageBox } = serviceHarness(runtime, { nativeResponse: 0 });
    const owner = webContents(17);
    const disclosure = await service.prepare(owner.owner, PREPARE_INPUT);

    await expect(
      requiredHandler(IPC_CHANNELS.runsApprove)(invokeEvent(owner.owner), disclosure.runId),
    ).resolves.toEqual({ ok: true, value: false });
    expect(runtime.launchCalls).toEqual([]);
    expect(runtime.terminateCalls).toEqual([
      { ownerId: runtime.prepareCalls[0]?.ownerId, runId: disclosure.runId },
    ]);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        buttons: ['Cancel', 'Launch agent'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(shownMessage(showMessageBox).detail).toContain('Executable: /test-agent');
    await service.dispose();
  });

  it('rechecks the exact parent at the final runtime launch boundary', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const parent = { isDestroyed: () => false };
    const replacement = { isDestroyed: () => false };
    const { service } = serviceHarness(runtime);
    electronMock.fromWebContents.mockReturnValue(parent);
    runtime.beforeAuthorizeLaunch = () => electronMock.fromWebContents.mockReturnValue(replacement);
    const owner = webContents(18);
    const disclosure = await service.prepare(owner.owner, PREPARE_INPUT);

    await expect(
      requiredHandler(IPC_CHANNELS.runsApprove)(invokeEvent(owner.owner), disclosure.runId),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(runtime.launchCalls).toEqual([]);
    await service.dispose();
  });

  it('revalidates persisted launch authority after deferred runtime work and before spawn', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const gate = deferred<void>();
    runtime.launchAuthorizationGate = gate.promise;
    let currentRunId = '00000000-0000-4000-8000-000000000001';
    const authorizePersistedLaunch = vi.fn<RunServicePersistedLaunchAuthorizer>(
      (_store, _input, _settings, expectedRunId) => {
        if (currentRunId !== expectedRunId) {
          throw new Error('The Agent node now points to another run.');
        }
      },
    );
    const { service } = serviceHarness(runtime, { authorizePersistedLaunch });
    const owner = webContents(181);
    const disclosure = await service.prepare(owner.owner, PREPARE_INPUT);
    const approving = requiredHandler(IPC_CHANNELS.runsApprove)(
      invokeEvent(owner.owner),
      disclosure.runId,
    );
    await vi.waitFor(() => expect(authorizePersistedLaunch).toHaveBeenCalledTimes(3));
    currentRunId = '00000000-0000-4000-8000-000000000002';
    gate.resolve();

    await expect(approving).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(runtime.launchCalls).toEqual([]);
    expect(authorizePersistedLaunch).toHaveBeenCalledTimes(4);
    await service.dispose();
  });

  it('cancels Docker preparation before runtime planning or any configured subprocess', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const { service, showMessageBox } = serviceHarness(runtime, {
      nativeResponse: 0,
      settings: {
        dockerEnabled: true,
        dockerExecutable: process.execPath,
        dockerImage: 'local/test:1',
        customPermissionProfile: { runtime: 'host' },
      } as unknown as AppSettings,
    });
    const owner = webContents(19);

    await expect(
      requiredHandler(IPC_CHANNELS.runsPrepare)(invokeEvent(owner.owner), {
        ...PREPARE_INPUT,
        adapterId: 'codex',
        permissionProfile: 'docker-isolated',
      }),
    ).resolves.toEqual({ ok: true, value: null });
    expect(runtime.prepareCalls).toEqual([]);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        buttons: ['Cancel', 'Run Docker probes'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(shownMessage(showMessageBox).detail).toContain('image","inspect","local/test:1');
    await service.dispose();
  });

  it('cancels a run-time Git filter in the exact native owner boundary', async () => {
    const fixture = await activeFilterRepository();
    const repositories = new RealRepositoryService();
    const runtime = new FakeAgentExecutionRuntime();
    runtime.prepareAction = async () => {
      await repositories.status(fixture.repository);
    };
    const { service, showMessageBox } = serviceHarness(runtime, {
      nativeResponse: 0,
      repositories,
    });
    const owner = webContents(23);

    try {
      await expect(
        requiredHandler(IPC_CHANNELS.runsPrepare)(invokeEvent(owner.owner), PREPARE_INPUT),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: 'Git filter execution was cancelled.' },
      });
      await expect(access(fixture.sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(showMessageBox).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          buttons: ['Cancel', 'Run exact Git filter'],
          defaultId: 0,
          cancelId: 0,
        }),
      );
      expect(shownMessage(showMessageBox).detail).toContain('run-filter');
    } finally {
      await service.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects subframes and foreign owners before run preparation or launch', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const { service, showMessageBox } = serviceHarness(runtime);
    const owner = webContents(20);
    const subframe = invokeEvent(owner.owner);
    Object.defineProperty(subframe, 'senderFrame', { value: {} });
    await expect(
      requiredHandler(IPC_CHANNELS.runsPrepare)(subframe, PREPARE_INPUT),
    ).resolves.toMatchObject({ ok: false });
    expect(runtime.prepareCalls).toEqual([]);

    const disclosure = await service.prepare(owner.owner, PREPARE_INPUT);
    const foreign = webContents(21);
    await expect(
      requiredHandler(IPC_CHANNELS.runsApprove)(invokeEvent(foreign.owner), disclosure.runId),
    ).resolves.toMatchObject({ ok: false });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(runtime.launchCalls).toEqual([]);
    await service.dispose();
  });

  it('discards a prepared run when its renderer stops being the main frame', async () => {
    const runtime = new FakeAgentExecutionRuntime();
    const preparation = deferred<void>();
    runtime.prepareGate = preparation.promise;
    const { service } = serviceHarness(runtime);
    const owner = webContents(22);
    const event = invokeEvent(owner.owner);
    const request = requiredHandler(IPC_CHANNELS.runsPrepare)(event, PREPARE_INPUT);
    await vi.waitFor(() => expect(runtime.prepareCalls).toHaveLength(1));
    Object.defineProperty(event, 'senderFrame', { value: {} });
    preparation.resolve();

    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(runtime.terminateCalls).toEqual([
      {
        ownerId: runtime.prepareCalls[0]?.ownerId,
        runId: '00000000-0000-4000-8000-000000000001',
      },
    ]);
    await service.dispose();
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
    const approveHandler = requiredHandler(IPC_CHANNELS.runsApprove);
    await expect(
      approveHandler(invokeEvent(reusedNumericId.owner), firstDisclosure.runId),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: 'The prepared run no longer exists.' },
    });
    await expect(
      approveHandler(invokeEvent(secondOwner.owner), secondDisclosure.runId),
    ).resolves.toEqual({ ok: true, value: true });
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
      requiredHandler(IPC_CHANNELS.runsApprove)(
        invokeEvent(reusedNumericId.owner),
        '00000000-0000-4000-8000-000000000001',
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: 'The prepared run no longer exists.' },
    });
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

function serviceHarness(
  runtime: FakeAgentExecutionRuntime,
  options: {
    readonly nativeResponse?: number;
    readonly repositories?: RepositoryService;
    readonly settings?: AppSettings;
    readonly contextResolver?: AgentRunContextResolver;
    readonly runRecords?: readonly StoredRunRecord[];
    readonly authorizeMutation?: (owner: WebContents) => void;
    readonly authorizePersistedLaunch?: RunServicePersistedLaunchAuthorizer;
    readonly canvasDocument?: CanvasDocument;
  } = {},
): {
  readonly appendAudit: ReturnType<typeof vi.fn>;
  readonly emit: AgentExecutionEventSink;
  readonly listProjectRuns: ReturnType<
    typeof vi.fn<(projectId: string, limit?: number, nodeId?: string) => StoredRunRecord[]>
  >;
  readonly service: RunService;
  readonly showMessageBox: ReturnType<typeof vi.fn>;
} {
  const appendAudit = vi.fn();
  const listProjectRuns = vi.fn<
    (projectId: string, limit?: number, nodeId?: string) => StoredRunRecord[]
  >(() => [...(options.runRecords ?? [])]);
  const showMessageBox = vi.fn(() =>
    Promise.resolve({ response: options.nativeResponse ?? 1, checkboxChecked: false }),
  );
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset().mockReturnValue({ isDestroyed: () => false });
  let emit!: AgentExecutionEventSink;
  const service = new RunService(
    {
      appendAudit,
      getRun: (runId: string) => options.runRecords?.find((run) => run.id === runId),
      listProjectRuns,
      loadCanvas: () => options.canvasDocument,
    } as unknown as LocalStore,
    () => options.settings ?? ({} as AppSettings),
    () => Promise.resolve(undefined),
    undefined,
    options.repositories ?? repositoryService(),
    (eventSink) => {
      emit = eventSink;
      return runtime;
    },
    { showMessageBox },
    () => new Date('2026-07-15T12:00:00.000Z'),
    options.contextResolver ?? emptyContextResolver(),
    options.authorizeMutation,
    options.authorizePersistedLaunch ?? (() => undefined),
  );
  service.registerIpcHandlers();
  return { appendAudit, emit, listProjectRuns, service, showMessageBox };
}

function storedRun(id: string, overrides: Partial<StoredRunRecord> = {}): StoredRunRecord {
  return {
    id,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'test-agent',
    status: 'succeeded',
    cwd: '/repo/.forgeboard/worktrees/agent-node',
    branch: 'forgeboard/agent-node',
    worktreeId: '00000000-0000-4000-8000-000000000096',
    repositoryRoot: '/repo',
    managedRoot: '/repo/.forgeboard/worktrees',
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    startedAt: '2026-07-15T12:00:00.000Z',
    endedAt: '2026-07-15T12:01:00.000Z',
    exitCode: 0,
    createdAt: '2026-07-15T11:59:00.000Z',
    updatedAt: '2026-07-15T12:01:00.000Z',
    ...overrides,
  };
}

function agentCanvas(runId: string): CanvasDocument {
  return {
    id: 'canvas-1',
    projectId: PROJECT_ID,
    name: 'Canvas',
    nodes: [
      {
        id: 'agent-node',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          kind: 'agent',
          title: 'Agent',
          description: 'Agent',
          status: 'running',
          locked: false,
          collapsed: false,
          color: '#445566',
          adapterId: 'test-agent',
          permissionProfile: 'plan-read-only',
          prompt: PREPARE_INPUT.prompt,
          contextAttachmentIds: [],
          runId,
        },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: '2026-07-15T12:00:00.000Z',
  };
}

function emptyContextResolver(): AgentRunContextResolver {
  return {
    resolve: () =>
      Promise.resolve({
        context: { attachments: [] },
        authority: {
          attachmentIds: [],
          canvasId: 'canvas-1',
          fingerprint: 'c'.repeat(64),
          manifestDigest: null,
          relativePaths: [],
        },
      }),
  };
}

function linkedContextResolution(
  overrides: {
    readonly contentHash?: string;
    readonly fingerprint?: string;
  } = {},
): PersistedAgentContextResolution {
  const contentHash = overrides.contentHash ?? 'd'.repeat(64);
  return {
    context: {
      attachments: [
        {
          path: '/repo/src/context.ts',
          kind: 'file',
          label: 'Context file',
          explicitlyApproved: true,
          sha256: contentHash,
        },
      ],
      manifestId: 'manifest-1',
      manifestDigest: 'e'.repeat(64),
    },
    authority: {
      attachmentIds: ['file-1'],
      canvasId: 'canvas-1',
      fingerprint: overrides.fingerprint ?? 'f'.repeat(64),
      manifestDigest: 'e'.repeat(64),
      relativePaths: ['src/context.ts'],
    },
  };
}

async function activeFilterRepository(): Promise<{
  readonly repository: string;
  readonly root: string;
  readonly sentinel: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-run-filter-'));
  const repository = path.join(root, 'repository');
  const sentinel = path.join(root, 'filter-ran');
  const script = path.join(root, 'filter.cjs');
  await mkdir(repository);
  await writeFile(
    script,
    "require('node:fs').writeFileSync(process.argv[2], 'ran\\n'); process.stdin.pipe(process.stdout);\n",
  );
  await runFixtureGit(repository, ['init', '-b', 'main']);
  await runFixtureGit(repository, ['config', 'user.name', 'Forgeboard Test']);
  await runFixtureGit(repository, ['config', 'user.email', 'forgeboard@example.invalid']);
  await writeFile(path.join(repository, '.gitattributes'), 'README.md filter=run-filter\n');
  await writeFile(path.join(repository, 'README.md'), '# fixture\n');
  await runFixtureGit(repository, ['add', '--', '.gitattributes', 'README.md']);
  await runFixtureGit(repository, ['commit', '-m', 'Initial fixture']);
  await runFixtureGit(repository, [
    'config',
    'filter.run-filter.clean',
    `${shellLiteral(process.execPath)} ${shellLiteral(script)} ${shellLiteral(sentinel)}`,
  ]);
  await writeFile(path.join(repository, 'README.md'), '# changed\n');
  return { repository, root, sentinel };
}

async function runFixtureGit(cwd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd }, (error) => {
      if (error === null) resolve();
      else reject(error instanceof Error ? error : new Error('Git fixture command failed.'));
    });
  });
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shownMessage(show: ReturnType<typeof vi.fn>): MessageBoxOptions {
  const options = show.mock.calls[0]?.[1] as MessageBoxOptions | undefined;
  if (options === undefined) throw new Error('Expected a native message-box call.');
  return options;
}

function runSummary(runId: string, nodeId: string): RunEventEnvelope {
  return {
    runId,
    nodeId,
    kind: 'run-summary',
    payload: { status: 'succeeded' },
  };
}

function repositoryService(): RepositoryService {
  return {
    git: {
      withDelegateAuthorization: async (_authorize: unknown, operation: () => Promise<unknown>) =>
        await operation(),
    },
  } as unknown as RepositoryService;
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
  const mainFrame = {};
  return {
    owner: {
      id,
      mainFrame,
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

function invokeEvent(owner: WebContents): IpcMainInvokeEvent {
  return { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
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
