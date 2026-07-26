import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BaseWindow, IpcMainInvokeEvent, MessageBoxOptions } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  return {
    handlers: new Map<string, Handler>(),
    fromWebContents: vi.fn(),
    fromId: vi.fn(),
    handle: vi.fn((channel: string, handler: Handler) => {
      electronMock.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      electronMock.handlers.delete(channel);
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
  ipcMain: { handle: electronMock.handle, removeHandler: electronMock.removeHandler },
  webContents: { fromId: electronMock.fromId },
}));

import { CanvasSchema, type Canvas } from '@forgeboard/core/domain';
import { createWorkflowExecutionRuntime } from '@forgeboard/core';
import {
  GitDelegateApprovalRequiredError,
  type GitDelegateAuthorizer,
  type GitDelegatePlan,
} from '@forgeboard/git-engine';

import { legacySurfaceFromCanonical } from '../../../shared/canvas/adapter.js';
import type { Project } from '../../../shared/application/contracts.js';
import type { CheckExecutionView } from '../../../shared/checks/contracts.js';
import {
  WORKFLOW_IPC_CHANNELS,
  WorkflowEventEnvelopeSchema,
  WorkflowInteractionEventEnvelopeSchema,
} from '../../../shared/workflow/contracts.js';
import { LocalStore, type WorkflowJsonValue } from '../../storage.js';
import { WorkflowHost } from './service.js';
import type {
  WorkflowHostInteractionNotification,
  WorkflowHostNotification,
  WorkflowNodeExecutionCompletion,
  WorkflowNodeExecutionHandle,
  WorkflowNodeExecutor,
} from './contracts.js';
import { WorkflowIpcService, type WorkflowIpcServiceOptions } from './ipc.js';

const PROJECT_ID = 'd284f7b1-550d-44fd-b30f-e8e43ffdd1fb';
const CANVAS_ID = 'a55d26b8-cfa8-46ea-9fab-7114c18a47d8';
const NODE_ID = 'agent-1';
const RECOVERED_EXECUTION_ID = '8f28e278-9fc9-4d6b-a92c-6244045ae769';
const T0 = '2026-07-15T20:00:00.000Z';
const openFixtures: Fixture[] = [];

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset();
  electronMock.fromId.mockReset();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

afterEach(async () => {
  for (const fixture of openFixtures.splice(0)) await fixture.close();
});

describe('WorkflowIpcService', () => {
  it('rejects renderer authority fields and subframes before starting work', async () => {
    const fixture = createFixture();
    const invalid = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(liveEvent(), {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
      command: { executable: '/bin/sh', args: ['-c', 'untrusted'] },
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(fixture.store.listProjectWorkflowExecutions(PROJECT_ID)).toEqual([]);

    const subframe = await requiredHandler(WORKFLOW_IPC_CHANNELS.list)(subframeEvent(), {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      limit: 10,
    });
    expect(subframe).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    const subframeMessage = (subframe as { error?: { message?: unknown } }).error?.message;
    expect(typeof subframeMessage).toBe('string');
    expect(subframeMessage).toMatch(/main Artemis frame/iu);
  });

  it('main-authorizes mutations while keeping workflow history readable', async () => {
    const authorizeMutation = vi.fn(() => {
      throw new Error('This collaboration role cannot mutate workflow execution.');
    });
    const fixture = createFixture({ authorizeMutation, canvas: reviewGateCanvas() });
    const owner = liveEvent(10);

    const listed = await requiredHandler(WORKFLOW_IPC_CHANNELS.list)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      limit: 10,
    });
    expect(listed).toEqual({ ok: true, value: [] });
    expect(authorizeMutation).not.toHaveBeenCalled();

    const start = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    expect(start).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(JSON.stringify(start)).toMatch(/collaboration role cannot mutate/u);
    const deniedMutations: readonly [string, Record<string, unknown>][] = [
      [
        WORKFLOW_IPC_CHANNELS.approveNode,
        {
          executionId: 'workflow-execution',
          nodeId: NODE_ID,
          preparationId: 'prepared-launch',
          approvalFingerprint: 'fingerprint-123',
          confirmed: true,
        },
      ],
      [
        WORKFLOW_IPC_CHANNELS.approveHuman,
        {
          executionId: 'workflow-execution',
          targetId: 'execute-edge',
          targetType: 'execute-edge',
          targetAttempt: 1,
          evidenceFingerprint: 'evidence',
          confirmed: true,
        },
      ],
      [
        WORKFLOW_IPC_CHANNELS.decideReview,
        {
          executionId: 'workflow-execution',
          targetId: 'review-edge',
          targetType: 'human-review',
          targetAttempt: 1,
          evidenceFingerprint: 'evidence',
          decision: 'approved',
          confirmed: true,
        },
      ],
      [
        WORKFLOW_IPC_CHANNELS.resolveRevisionEscape,
        {
          executionId: 'workflow-execution',
          loopId: 'revision-loop',
          attemptsStarted: 1,
          evidenceFingerprint: 'evidence',
          decision: 'cancel',
          confirmed: true,
        },
      ],
      [WORKFLOW_IPC_CHANNELS.cancel, { executionId: 'workflow-execution', confirmed: true }],
      [
        WORKFLOW_IPC_CHANNELS.cancelNode,
        { executionId: 'workflow-execution', nodeId: NODE_ID, attempt: 1, confirmed: true },
      ],
      [
        WORKFLOW_IPC_CHANNELS.sendInput,
        { executionId: 'workflow-execution', nodeId: NODE_ID, attempt: 1, data: 'input\n' },
      ],
      [
        WORKFLOW_IPC_CHANNELS.interrupt,
        { executionId: 'workflow-execution', nodeId: NODE_ID, attempt: 1 },
      ],
    ];
    for (const [channel, input] of deniedMutations) {
      const result = await requiredHandler(channel)(owner, input);
      expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
      expect(JSON.stringify(result)).toMatch(/collaboration role cannot mutate/u);
    }
    expect(authorizeMutation).toHaveBeenCalledTimes(1 + deniedMutations.length);
    expect(fixture.store.listProjectWorkflowExecutions(PROJECT_ID)).toEqual([]);
  });

  it('reloads the persisted canonical canvas and returns a renderer-safe execution view', async () => {
    createFixture({ canvas: reviewGateCanvas() });
    const owner = liveEvent(11);
    const result = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        status: 'succeeded',
        nodeRuns: [{ nodeId: 'gate-1', status: 'succeeded' }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('runtime_json');
    const listed = await requiredHandler(WORKFLOW_IPC_CHANNELS.list)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      limit: 10,
    });
    expect(listed).toMatchObject({ ok: true, value: [{ revision: 2 }] });
  });

  it('loads Test results through their durable workflow binding', async () => {
    const fixture = createFixture({ canvas: reviewGateCanvas() });
    const owner = liveEvent(13);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const executionId = executionIdFrom(started);
    const check: CheckExecutionView = {
      id: '20000000-0000-4000-8000-000000000013',
      projectId: PROJECT_ID,
      checkId: 'test',
      label: 'Bound test',
      kind: 'test',
      executable: 'node',
      arguments: ['--test'],
      cwd: '/tmp/forgeboard-workflow-ipc-project',
      environmentVariableNames: [],
      target: { kind: 'primary-project', projectId: PROJECT_ID },
      workflowBinding: { executionId, nodeId: 'gate-1', attempt: 1 },
      status: 'passed',
      exitCode: 0,
      startedAt: T0,
      endedAt: '2026-07-15T20:00:01.000Z',
      output: 'Tests: 1 passed, 1 total',
      outputTruncated: false,
      summary: { passed: 1, failed: 0, skipped: 0, total: 1, parser: 'generic' },
      artifacts: [],
      updatedAt: '2026-07-15T20:00:01.000Z',
    };
    fixture.store.saveCheckExecution(check);
    const bindingQuery = vi.spyOn(fixture.store, 'listWorkflowCheckExecutions');
    const globalQuery = vi.spyOn(fixture.store, 'listCheckExecutions').mockImplementation(() => {
      throw new Error('The workflow view must not use the project-wide recency query.');
    });

    const result = await requiredHandler(WORKFLOW_IPC_CHANNELS.get)(owner, { executionId });

    expect(result).toMatchObject({
      ok: true,
      value: {
        testResults: [
          {
            checkExecutionId: check.id,
            executionId,
            nodeId: 'gate-1',
            attempt: 1,
            status: 'passed',
          },
        ],
      },
    });
    expect(bindingQuery).toHaveBeenCalledWith(PROJECT_ID, executionId);
    expect(globalQuery).not.toHaveBeenCalled();
  });

  it('reveals and opens only main-resolved artifacts for an owned workflow', async () => {
    const resolveArtifact = vi.fn(() => Promise.resolve('/trusted/worktree/coverage/index.html'));
    const showItemInFolder = vi.fn();
    const openPath = vi.fn(() => Promise.resolve(''));
    const authorizeMutation = vi.fn();
    const fixture = createFixture({
      canvas: reviewGateCanvas(),
      authorizeMutation,
      resolveArtifact,
      nativeShell: { showItemInFolder, openPath },
    });
    const owner = liveEvent(14);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const input = {
      checkExecutionId: '20000000-0000-4000-8000-000000000001',
      executionId: executionIdFrom(started),
      nodeId: 'test-node',
      attempt: 1,
      relativePath: 'coverage/index.html',
      sha256: 'a'.repeat(64),
    };

    await expect(
      requiredHandler(WORKFLOW_IPC_CHANNELS.revealArtifact)(owner, input),
    ).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(
      requiredHandler(WORKFLOW_IPC_CHANNELS.openArtifact)(owner, input),
    ).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(resolveArtifact).toHaveBeenCalledTimes(2);
    expect(showItemInFolder).toHaveBeenCalledWith('/trusted/worktree/coverage/index.html');
    expect(openPath).toHaveBeenCalledWith('/trusted/worktree/coverage/index.html');
    expect(authorizeMutation).toHaveBeenCalledTimes(1);
    expect(fixture.appendAuditSpy).toHaveBeenCalledWith(
      'workflow',
      'artifact-open',
      'allowed',
      expect.objectContaining({ relativePath: 'coverage/index.html' }),
    );
  });

  it('recovers without inherited Git authority and retries only under a fresh live IPC authorizer', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const authorization = new AsyncLocalStorage<GitDelegateAuthorizer>();
    const plan = delegatePlan();
    const fake = fakeExecutor();
    fake.prepare.mockImplementation(async () => {
      const authorize = authorization.getStore();
      if (authorize === undefined) {
        throw new GitDelegateApprovalRequiredError(plan, 'approval-required');
      }
      const approved = await authorize(plan);
      if (approved === null) {
        throw new GitDelegateApprovalRequiredError(plan, 'approval-cancelled');
      }
      approved.assertCurrent();
      return {
        preparationId: 'workflow-preparation-after-git-approval',
        approvalFingerprint: 'workflow-fingerprint-after-git-approval',
        expiresAt: '2099-07-15T20:00:00.000Z',
        disclosure: { executable: 'forgeboard-codex', arguments: ['--stdio'] },
      };
    });
    const fixture = createFixture({
      nativeResponse: 1,
      fake,
      seedRecoverableExecution: true,
      withGitDelegateAuthorization: async (authorize, operation) =>
        await authorization.run(authorize, operation),
    });

    await vi.waitFor(() =>
      expect(fixture.store.listWorkflowNodeBindings(RECOVERED_EXECUTION_ID)).toMatchObject([
        { binding: { payload: { phase: 'waiting-delegate-approval' } } },
      ]),
    );
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    expect(fixture.fake.prepare).toHaveBeenCalledTimes(1);

    const listed = await requiredHandler(WORKFLOW_IPC_CHANNELS.list)(liveEvent(12), {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      limit: 10,
    });

    expect(listed).toMatchObject({
      ok: true,
      value: [
        {
          id: RECOVERED_EXECUTION_ID,
          status: 'queued',
          approvals: [{ preparationId: 'workflow-preparation-after-git-approval' }],
        },
      ],
    });
    expect(fixture.fake.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.fake.launch).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).toHaveBeenCalledTimes(1);
    expect(messageBoxOptions(fixture.showMessageBox)).toMatchObject({
      buttons: ['Cancel', 'Run filter commands'],
      defaultId: 0,
      cancelId: 0,
    });
  });

  it('keeps native launch cancellation non-executing and owner-bound', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 0 });
    const owner = liveEvent(21);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const approval = approvalFrom(started);

    const foreign = await requiredHandler(WORKFLOW_IPC_CHANNELS.approveNode)(liveEvent(22), {
      ...approval,
      confirmed: true,
    });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.fake.launch).not.toHaveBeenCalled();

    const cancelled = await requiredHandler(WORKFLOW_IPC_CHANNELS.approveNode)(owner, {
      ...approval,
      confirmed: true,
    });
    expect(cancelled).toEqual({ ok: true, value: null });
    expect(fixture.fake.launch).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).toHaveBeenCalledTimes(1);
    const options = messageBoxOptions(fixture.showMessageBox);
    expect(options.buttons).toEqual(['Cancel', 'Run node']);
    expect(options.defaultId).toBe(0);
    expect(options.detail).toContain('What will run');
    expect(fixture.appendAuditSpy).toHaveBeenCalledWith(
      'workflow',
      'launch-node',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-cancelled' }),
    );
  });

  it('rejects native launch approval when the exact parent window changes', async () => {
    const parent = { isDestroyed: () => false };
    const replacement = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 1 });
    const owner = liveEvent(23);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const approval = approvalFrom(started);
    fixture.showMessageBox.mockImplementationOnce(() => {
      electronMock.fromWebContents.mockReturnValue(replacement);
      return Promise.resolve({ response: 1, checkboxChecked: false });
    });

    const result = await requiredHandler(WORKFLOW_IPC_CHANNELS.approveNode)(owner, {
      ...approval,
      confirmed: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(JSON.stringify(result)).toContain('window changed');
    expect(fixture.fake.launch).not.toHaveBeenCalled();
  });

  it('rejects a foreign read before getState can pump or prepare the workflow', async () => {
    const fixture = createFixture();
    const owner = liveEvent(23);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const executionId = executionIdFrom(started);
    const durableBefore = fixture.store.getWorkflowExecution(executionId);
    const getState = vi.spyOn(fixture.host, 'getState');
    fixture.fake.prepare.mockClear();

    const foreign = await requiredHandler(WORKFLOW_IPC_CHANNELS.get)(liveEvent(24), {
      executionId,
    });

    expect(foreign).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(getState).not.toHaveBeenCalled();
    expect(fixture.fake.prepare).not.toHaveBeenCalled();
    expect(fixture.store.getWorkflowExecution(executionId)).toEqual(durableBefore);
  });

  it('rejects a foreign mutation before state pumping, confirmation, or launch', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 1 });
    const owner = liveEvent(25);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const executionId = executionIdFrom(started);
    const durableBefore = fixture.store.getWorkflowExecution(executionId);
    const getState = vi.spyOn(fixture.host, 'getState');
    const approveNode = vi.spyOn(fixture.host, 'approveNode');

    const foreign = await requiredHandler(WORKFLOW_IPC_CHANNELS.approveNode)(liveEvent(26), {
      ...approvalFrom(started),
      confirmed: true,
    });

    expect(foreign).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(getState).not.toHaveBeenCalled();
    expect(approveNode).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    expect(fixture.fake.launch).not.toHaveBeenCalled();
    expect(fixture.store.getWorkflowExecution(executionId)).toEqual(durableBefore);
  });

  it('allows a live window to adopt an execution after its previous owner closes', async () => {
    const fixture = createFixture({ canvas: reviewGateCanvas() });
    const originalOwner = destroyableEvent(27);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(originalOwner.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const executionId = executionIdFrom(started);
    originalOwner.destroy();
    const getState = vi.spyOn(fixture.host, 'getState');

    const adopted = await requiredHandler(WORKFLOW_IPC_CHANNELS.get)(liveEvent(28), {
      executionId,
    });
    const foreign = await requiredHandler(WORKFLOW_IPC_CHANNELS.get)(liveEvent(29), {
      executionId,
    });

    expect(adopted).toMatchObject({ ok: true, value: { id: executionId } });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('drops stale notifications when a destroyed numeric WebContents ID is reused', async () => {
    const fixture = createFixture({ canvas: reviewGateCanvas() });
    const originalSend = vi.fn();
    const original = destroyableEvent(30, originalSend);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(original.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const executionId = executionIdFrom(started);
    const snapshot = await fixture.host.getState(executionId);
    const release = deferred<void>();
    const getState = vi.spyOn(fixture.host, 'getState').mockImplementationOnce(async () => {
      await release.promise;
      return snapshot;
    });
    fixture.emit({
      executionId,
      type: 'decision-recorded',
      occurredAt: T0,
      payload: {},
    });
    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(1));

    original.destroy();
    const replacementSend = vi.fn();
    const replacement = liveEvent(30, replacementSend);
    const adopted = requiredHandler(WORKFLOW_IPC_CHANNELS.get)(replacement, { executionId });
    release.resolve(undefined);
    await expect(adopted).resolves.toMatchObject({ ok: true, value: { id: executionId } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(originalSend).not.toHaveBeenCalled();
    expect(replacementSend).not.toHaveBeenCalled();
    expect(electronMock.fromId).not.toHaveBeenCalled();
  });

  it('launches the exact approved node and forwards its durable completion view', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const send = vi.fn();
    const fixture = createFixture({ nativeResponse: 1 });
    const owner = liveEvent(31, send);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'node', nodeId: NODE_ID },
    });
    const approval = approvalFrom(started);
    const running = await requiredHandler(WORKFLOW_IPC_CHANNELS.approveNode)(owner, {
      ...approval,
      confirmed: true,
    });
    expect(running).toMatchObject({
      ok: true,
      value: { nodeRuns: [{ nodeId: NODE_ID, status: 'running' }] },
    });
    expect(fixture.fake.launch).toHaveBeenCalledTimes(1);

    fixture.fake.complete({ completion: { status: 'succeeded' } });
    await vi.waitFor(() => {
      const completed = sentWorkflowEvents(send).find((event) => event.type === 'node-completed');
      expect(completed?.execution.status).toBe('succeeded');
    });
  });

  it('routes ephemeral output and live controls through the exact execution owner and node attempt', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const send = vi.fn();
    const fixture = createFixture({ nativeResponse: 1 });
    const owner = liveEvent(35, send);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const approval = approvalFrom(started);
    await requiredHandler(WORKFLOW_IPC_CHANNELS.approveNode)(owner, {
      ...approval,
      confirmed: true,
    });
    const identity = { executionId: approval.executionId, nodeId: NODE_ID, attempt: 1 };

    fixture.emitInteraction({
      ...identity,
      sequence: 1,
      occurredAt: T0,
      kind: 'stream',
      channel: 'stdout',
      text: 'live output',
      truncated: false,
    });
    expect(sentInteractionEvents(send)).toEqual([
      expect.objectContaining({ ...identity, text: 'live output' }),
    ]);

    const sent = await requiredHandler(WORKFLOW_IPC_CHANNELS.sendInput)(owner, {
      ...identity,
      data: 'continue\n',
    });
    const interrupted = await requiredHandler(WORKFLOW_IPC_CHANNELS.interrupt)(owner, identity);
    expect(sent).toEqual({ ok: true, value: true });
    expect(interrupted).toEqual({ ok: true, value: true });
    expect(fixture.fake.sendInput).toHaveBeenCalledWith('continue\n');
    expect(fixture.fake.interrupt).toHaveBeenCalledTimes(1);

    const foreign = await requiredHandler(WORKFLOW_IPC_CHANNELS.sendInput)(liveEvent(36), {
      ...identity,
      data: 'foreign',
    });
    const stale = await requiredHandler(WORKFLOW_IPC_CHANNELS.sendInput)(owner, {
      ...identity,
      attempt: 2,
      data: 'stale',
    });
    const nul = await requiredHandler(WORKFLOW_IPC_CHANNELS.sendInput)(owner, {
      ...identity,
      data: 'bad\0input',
    });
    const oversized = await requiredHandler(WORKFLOW_IPC_CHANNELS.sendInput)(owner, {
      ...identity,
      data: 'x'.repeat(65_537),
    });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(stale).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(nul).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(oversized).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(fixture.fake.sendInput).toHaveBeenCalledTimes(1);
    fixture.fake.complete({
      completion: { status: 'cancelled', reason: 'Interrupted by the local user.' },
    });
    await vi.waitFor(() => {
      expect(fixture.store.getWorkflowExecution(identity.executionId)?.status).toBe('cancelled');
    });
  });

  it('rechecks the opaque owner inside a queued live-control operation', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 1 });
    const owner = destroyableEvent(37);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner.event, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const approval = approvalFrom(started);
    await requiredHandler(WORKFLOW_IPC_CHANNELS.approveNode)(owner.event, {
      ...approval,
      confirmed: true,
    });
    const reachedHost = deferred<void>();
    const release = deferred<void>();
    const sendInput = vi
      .spyOn(fixture.host, 'sendInput')
      .mockImplementationOnce(async (_input, assertAuthorized) => {
        reachedHost.resolve(undefined);
        await release.promise;
        if (assertAuthorized === undefined) {
          throw new Error('Expected an execution-time owner authorization guard.');
        }
        assertAuthorized();
        return true;
      });
    const sending = requiredHandler(WORKFLOW_IPC_CHANNELS.sendInput)(owner.event, {
      executionId: approval.executionId,
      nodeId: NODE_ID,
      attempt: 1,
      data: 'stale queued input',
    });
    await reachedHost.promise;

    owner.destroy();
    release.resolve(undefined);

    const sendResult = await sending;
    expect(sendResult).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    const sendErrorMessage = (sendResult as { error?: { message?: unknown } }).error?.message;
    expect(typeof sendErrorMessage).toBe('string');
    expect(sendErrorMessage).toMatch(/closed|stale/iu);
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(fixture.fake.sendInput).not.toHaveBeenCalled();
    fixture.fake.complete({
      completion: { status: 'cancelled', reason: 'The owner window closed.' },
    });
  });

  it('requires cancel-default native confirmation before cancellation', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 0, canvas: reviewGateCanvas() });
    const owner = liveEvent(41);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const executionId = executionIdFrom(started);
    const result = await requiredHandler(WORKFLOW_IPC_CHANNELS.cancel)(owner, {
      executionId,
      confirmed: true,
    });
    expect(result).toEqual({ ok: true, value: null });
    expect(messageBoxOptions(fixture.showMessageBox)).toMatchObject({
      buttons: ['Keep running', 'Cancel workflow'],
      defaultId: 0,
      cancelId: 0,
    });
  });

  it('rechecks the collaboration role after node-cancel confirmation', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    let role: 'editor' | 'viewer' = 'editor';
    const authorizeMutation = vi.fn(() => {
      if (role !== 'editor') {
        throw new Error('This collaboration role cannot mutate workflow execution.');
      }
    });
    const fixture = createFixture({ nativeResponse: 1, authorizeMutation });
    const owner = liveEvent(42);
    const started = await requiredHandler(WORKFLOW_IPC_CHANNELS.start)(owner, {
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'workflow' },
    });
    const approval = approvalFrom(started);
    await requiredHandler(WORKFLOW_IPC_CHANNELS.approveNode)(owner, {
      ...approval,
      confirmed: true,
    });
    const confirmation = deferred<{ response: number; checkboxChecked: boolean }>();
    fixture.showMessageBox.mockImplementationOnce(() => confirmation.promise);
    const cancelNode = vi.spyOn(fixture.host, 'cancelNode');

    const cancelling = requiredHandler(WORKFLOW_IPC_CHANNELS.cancelNode)(owner, {
      executionId: approval.executionId,
      nodeId: NODE_ID,
      attempt: 1,
      confirmed: true,
    });
    await vi.waitFor(() => expect(fixture.showMessageBox).toHaveBeenCalledTimes(2));
    role = 'viewer';
    confirmation.resolve({ response: 1, checkboxChecked: false });

    const result = await cancelling;
    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(JSON.stringify(result)).toMatch(/collaboration role cannot mutate/u);
    expect(cancelNode).not.toHaveBeenCalled();
    fixture.fake.complete({
      completion: { status: 'cancelled', reason: 'Test cleanup after denied cancellation.' },
    });
    await vi.waitFor(() => {
      expect(fixture.store.getWorkflowExecution(approval.executionId)?.status).toBe('cancelled');
    });
  });

  it('resets and disposes its owned executor runtime after the host is drained', async () => {
    const resetRuntime = vi.fn(() => Promise.resolve());
    const disposeRuntime = vi.fn(() => Promise.resolve());
    const fixture = createFixture({ resetRuntime, disposeRuntime });

    await fixture.service.resetForPrivacy();
    expect(resetRuntime).toHaveBeenCalledTimes(1);
    await fixture.service.dispose();
    expect(disposeRuntime).toHaveBeenCalledTimes(1);
  });
});

interface Fixture {
  readonly appendAuditSpy: ReturnType<typeof vi.spyOn>;
  readonly fake: ReturnType<typeof fakeExecutor>;
  readonly emit: (notification: WorkflowHostNotification) => void;
  readonly emitInteraction: (notification: WorkflowHostInteractionNotification) => void;
  readonly host: WorkflowHost;
  readonly service: WorkflowIpcService;
  readonly showMessageBox: ReturnType<typeof vi.fn>;
  readonly store: LocalStore;
  close(): Promise<void>;
}

function createFixture({
  nativeResponse = 0,
  canvas = agentCanvas(),
  fake = fakeExecutor(),
  seedRecoverableExecution = false,
  resetRuntime,
  disposeRuntime,
  withGitDelegateAuthorization,
  authorizeMutation,
  resolveArtifact,
  nativeShell,
}: {
  nativeResponse?: number;
  canvas?: Canvas;
  fake?: ReturnType<typeof fakeExecutor>;
  seedRecoverableExecution?: boolean;
  resetRuntime?: () => Promise<void>;
  disposeRuntime?: () => Promise<void>;
  withGitDelegateAuthorization?: NonNullable<
    WorkflowIpcServiceOptions['withGitDelegateAuthorization']
  >;
  authorizeMutation?: NonNullable<WorkflowIpcServiceOptions['authorizeMutation']>;
  resolveArtifact?: NonNullable<WorkflowIpcServiceOptions['resolveArtifact']>;
  nativeShell?: NonNullable<WorkflowIpcServiceOptions['nativeShell']>;
} = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-workflow-ipc-test-'));
  const store = new LocalStore(join(directory, 'forgeboard.sqlite3'));
  store.saveProject(project());
  const surface = legacySurfaceFromCanonical(canvas);
  store.saveCanvas({
    ...surface,
    nodes: [...surface.nodes],
    edges: [...surface.edges],
    schemaVersion: 2,
    canonical: canvas,
  });
  if (seedRecoverableExecution) seedRecoverableWorkflow(store, canvas);
  const showMessageBox = vi.fn((...args: [BaseWindow, MessageBoxOptions] | [MessageBoxOptions]) => {
    void args;
    return Promise.resolve({ response: nativeResponse, checkboxChecked: false });
  });
  const appendAuditSpy = vi.spyOn(store, 'appendAudit');
  const hosts: WorkflowHost[] = [];
  let emitHostNotification: (notification: WorkflowHostNotification) => void = () => undefined;
  let emitHostInteraction: (notification: WorkflowHostInteractionNotification) => void = () =>
    undefined;
  const service = new WorkflowIpcService(
    { showMessageBox },
    store,
    (emit, emitInteraction) => {
      emitHostNotification = emit;
      emitHostInteraction = emitInteraction ?? (() => undefined);
      const host = new WorkflowHost(store, [fake.executor], {
        emit,
        ...(emitInteraction === undefined ? {} : { emitInteraction }),
      });
      hosts.push(host);
      return host;
    },
    {
      ...(resetRuntime === undefined ? {} : { resetRuntime }),
      ...(disposeRuntime === undefined ? {} : { disposeRuntime }),
      ...(withGitDelegateAuthorization === undefined ? {} : { withGitDelegateAuthorization }),
      ...(authorizeMutation === undefined ? {} : { authorizeMutation }),
      ...(resolveArtifact === undefined ? {} : { resolveArtifact }),
      ...(nativeShell === undefined ? {} : { nativeShell }),
    },
  );
  const host = hosts[0];
  if (host === undefined) throw new Error('Expected the workflow host factory to run.');
  service.registerIpcHandlers();
  const fixture: Fixture = {
    appendAuditSpy,
    emit: emitHostNotification,
    emitInteraction: emitHostInteraction,
    fake,
    host,
    service,
    showMessageBox,
    store,
    close: async () => {
      await service.dispose();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  openFixtures.push(fixture);
  return fixture;
}

function fakeExecutor() {
  let resolveCompletion: (completion: WorkflowNodeExecutionCompletion) => void = () => undefined;
  const completion = new Promise<WorkflowNodeExecutionCompletion>((resolve) => {
    resolveCompletion = resolve;
  });
  const sendInput = vi.fn();
  const interrupt = vi.fn();
  const unsubscribeInteraction = vi.fn();
  const handle: WorkflowNodeExecutionHandle = {
    externalId: 'workflow-agent-1',
    executionReference: {
      kind: 'internal',
      executionId: 'workflow-agent-1',
      startedAt: T0,
    },
    completion,
    cancel: vi.fn(() => Promise.resolve()),
    sendInput,
    interrupt,
    subscribeInteraction: () => unsubscribeInteraction,
  };
  const prepare = vi.fn(() =>
    Promise.resolve({
      preparationId: 'workflow-preparation-1',
      approvalFingerprint: 'workflow-fingerprint-1',
      expiresAt: '2099-07-15T20:00:00.000Z',
      disclosure: { executable: 'forgeboard-codex', arguments: ['--stdio'] },
    }),
  );
  const launch = vi.fn(() => Promise.resolve(handle));
  const executor: WorkflowNodeExecutor = {
    id: 'fake-workflow-agent',
    supports: (node) => node.type === 'agent',
    prepare,
    launch,
  };
  return {
    executor,
    prepare,
    launch,
    sendInput,
    interrupt,
    unsubscribeInteraction,
    complete: resolveCompletion,
  };
}

function seedRecoverableWorkflow(store: LocalStore, canvas: Canvas): void {
  const runtime = createWorkflowExecutionRuntime(canvas, {
    planId: 'recovered-plan',
    runId: RECOVERED_EXECUTION_ID,
    scope: { kind: 'workflow' },
    occurredAt: T0,
    eligibleNodeIds: canvas.nodes.map((node) => node.id),
  });
  store.createWorkflowExecution({
    schemaVersion: 1,
    id: RECOVERED_EXECUTION_ID,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    status: runtime.run.status,
    revision: 0,
    runtime: { schemaVersion: 1, payload: json(runtime) },
    snapshot: { schemaVersion: 1, payload: json(canvas) },
    createdAt: T0,
    updatedAt: T0,
  });
}

function delegatePlan(): GitDelegatePlan {
  return {
    schemaVersion: 1,
    fingerprint: 'a'.repeat(64),
    repositoryPath: '/tmp/forgeboard-filtered-repository',
    operation: 'worktree-inspection',
    filters: [
      {
        driver: 'lfs',
        executableConfigured: true,
        pathCount: 1,
        pathDigest: 'b'.repeat(64),
        disclosedPaths: ['assets/model.bin'],
        pathsTruncated: false,
        declarations: [
          {
            phase: 'process',
            command: 'git-lfs filter-process',
            origin: '/tmp/forgeboard-filtered-repository/.git/config',
          },
        ],
      },
    ],
  };
}

function json(value: unknown): WorkflowJsonValue {
  return JSON.parse(JSON.stringify(value)) as WorkflowJsonValue;
}

function agentCanvas(): Canvas {
  return canvas([
    {
      id: NODE_ID,
      type: 'agent',
      title: 'Agent',
      color: '#445566',
      icon: 'bot',
      position: { x: 0, y: 0 },
      size: { width: 320, height: 180 },
      status: 'ready',
      data: {
        adapterId: 'codex',
        permissionProfileId: 'worktree-write',
        promptDraft: 'Make a deterministic change.',
      },
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
}

function reviewGateCanvas(): Canvas {
  return canvas([
    {
      id: 'gate-1',
      type: 'review-gate',
      title: 'Gate',
      color: '#445566',
      icon: 'gate',
      position: { x: 0, y: 0 },
      size: { width: 320, height: 180 },
      status: 'ready',
      data: { humanApprovalRequired: false },
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
}

function canvas(nodes: unknown[]): Canvas {
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Workflow IPC',
    nodes,
    edges: [],
    groups: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    revisionLoops: [],
    workflowLimits: {},
    createdAt: T0,
    updatedAt: T0,
  });
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Workflow IPC project',
    path: '/tmp/forgeboard-workflow-ipc-project',
    openedAt: T0,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function liveEvent(ownerId = 7, send = vi.fn()): IpcMainInvokeEvent {
  const mainFrame = {};
  const sender = {
    id: ownerId,
    mainFrame,
    isDestroyed: () => false,
    once: vi.fn(),
    send,
  };
  return { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
}

function subframeEvent(ownerId = 7): IpcMainInvokeEvent {
  return { ...liveEvent(ownerId), senderFrame: {} } as unknown as IpcMainInvokeEvent;
}

function destroyableEvent(
  ownerId: number,
  send = vi.fn(),
): {
  readonly event: IpcMainInvokeEvent;
  destroy(): void;
} {
  const mainFrame = {};
  let destroyed = false;
  let onDestroyed: (() => void) | undefined;
  const sender = {
    id: ownerId,
    mainFrame,
    isDestroyed: () => destroyed,
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'destroyed') onDestroyed = listener;
    }),
    send,
  };
  return {
    event: { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent,
    destroy: () => {
      destroyed = true;
      onDestroyed?.();
    },
  };
}

function requiredHandler(channel: string) {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler ${channel}.`);
  return handler;
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function approvalFrom(result: unknown) {
  const parsed = result as {
    ok?: boolean;
    value?: { approvals?: Array<Record<string, unknown>> };
  };
  const approval = parsed.value?.approvals?.[0];
  if (approval === undefined) throw new Error('Expected workflow launch approval.');
  return {
    executionId: String(approval['executionId']),
    nodeId: String(approval['nodeId']),
    preparationId: String(approval['preparationId']),
    approvalFingerprint: String(approval['approvalFingerprint']),
  };
}

function executionIdFrom(result: unknown): string {
  const parsed = result as { value?: { id?: unknown } };
  if (typeof parsed.value?.id !== 'string') throw new Error('Expected workflow execution ID.');
  return parsed.value.id;
}

function messageBoxOptions(mock: ReturnType<typeof vi.fn>): MessageBoxOptions {
  const call = mock.mock.calls[0] as unknown[] | undefined;
  const options = call?.[1];
  if (options === null || typeof options !== 'object') {
    throw new Error('Expected native message-box options.');
  }
  return options as MessageBoxOptions;
}

function sentWorkflowEvents(mock: ReturnType<typeof vi.fn>) {
  const calls = mock.mock.calls as unknown[][];
  return calls.flatMap((call) => {
    if (call[0] !== WORKFLOW_IPC_CHANNELS.event) return [];
    const parsed = WorkflowEventEnvelopeSchema.safeParse(call[1]);
    return parsed.success ? [parsed.data] : [];
  });
}

function sentInteractionEvents(mock: ReturnType<typeof vi.fn>) {
  const calls = mock.mock.calls as unknown[][];
  return calls.flatMap((call) => {
    if (call[0] !== WORKFLOW_IPC_CHANNELS.interactionEvent) return [];
    const parsed = WorkflowInteractionEventEnvelopeSchema.safeParse(call[1]);
    return parsed.success ? [parsed.data] : [];
  });
}
