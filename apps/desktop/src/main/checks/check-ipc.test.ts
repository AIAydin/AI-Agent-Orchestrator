import type { BaseWindow, IpcMainInvokeEvent, MessageBoxOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalRecord } from '@forgeboard/core';

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
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler,
  },
  webContents: { fromId: electronMock.fromId },
}));

import type {
  CheckEventEnvelope,
  CheckExecutionView,
  CheckPlanView,
} from '../../shared/checks/contracts.js';
import type { ApprovalView } from '../../shared/approvals/contracts.js';
import { IPC_CHANNELS } from '../../shared/application/contracts.js';
import type { ApprovalCreateInput } from '../approvals/approval-contracts.js';
import { CheckIpcService, type CheckRuntimeOperations } from './check-ipc.js';

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset().mockReturnValue({ isDestroyed: () => false });
  electronMock.fromId.mockReset();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

describe('CheckIpcService', () => {
  it('rejects renderer-supplied command authority before touching the runtime', async () => {
    const fixture = createFixture();

    const result = await requiredHandler(IPC_CHANNELS.checksPrepare)(liveEvent(), {
      projectId: PLAN.projectId,
      checkId: 'lint',
      executable: '/bin/sh',
      cwd: '/tmp/foreign',
      environment: { TOKEN: 'must-not-enter-main' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(fixture.prepareRuntime).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('prepares only a project and check id and returns the main-owned disclosure', async () => {
    const fixture = createFixture();

    const result = await requiredHandler(IPC_CHANNELS.checksPrepare)(liveEvent(17), {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });

    expect(result).toEqual({ ok: true, value: PLAN });
    expect(fixture.prepareRuntime).toHaveBeenCalledWith(17, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });
    await fixture.service.dispose();
  });

  it('rejects subframes before preparing any executable plan', async () => {
    const fixture = createFixture();
    const event = liveEvent(18);
    Object.defineProperty(event, 'senderFrame', { value: {} });

    await expect(
      requiredHandler(IPC_CHANNELS.checksPrepare)(event, {
        projectId: PLAN.projectId,
        checkId: 'lint',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.prepareRuntime).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('discards a prepared plan when the owner stops being the main frame during preparation', async () => {
    const preparation = deferred<CheckPlanView>();
    const fixture = createFixture({ prepare: async () => await preparation.promise });
    const event = liveEvent(19);
    const resultPromise = requiredHandler(IPC_CHANNELS.checksPrepare)(event, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });
    await vi.waitFor(() => expect(fixture.prepareRuntime).toHaveBeenCalledTimes(1));
    Object.defineProperty(event, 'senderFrame', { value: {} });
    preparation.resolve(PLAN);

    const result = await resultPromise;

    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.discardPlanRuntime).toHaveBeenCalledWith(19, PLAN.planId);
    expect(fixture.startRuntime).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('keeps native cancellation non-executing, consumes the plan, and audits denial', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 0 });
    const event = liveEvent(23);
    await requiredHandler(IPC_CHANNELS.checksPrepare)(event, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });

    const result = await requiredHandler(IPC_CHANNELS.checksConfirm)(event, {
      planId: PLAN.planId,
      confirmed: true,
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(fixture.startRuntime).not.toHaveBeenCalled();
    expect(fixture.discardPlanRuntime).toHaveBeenCalledWith(23, PLAN.planId);
    expect(fixture.showMessageBox).toHaveBeenCalledTimes(1);
    const messageBoxCall = fixture.showMessageBox.mock.calls[0];
    expect(messageBoxCall).toHaveLength(2);
    if (!messageBoxCall || messageBoxCall.length !== 2) {
      throw new Error('Expected a parent window and message-box options.');
    }
    expect(messageBoxCall[0]).toBe(parent);
    expect(messageBoxCall[1].buttons).toEqual(['Cancel', 'Run check']);
    expect(messageBoxCall[1].defaultId).toBe(0);
    expect(messageBoxCall[1].cancelId).toBe(0);
    expect(messageBoxCall[1].detail).toContain(`Command: ${PLAN.executable}`);
    expect(messageBoxCall[1].detail).toContain(PLAN.approvalFingerprint);
    expect(messageBoxCall[1].detail).toContain('exported unchanged');
    expect(messageBoxCall[1].checkboxLabel).toContain('only this exact check');
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'check',
      'launch',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-cancelled' }),
    );
    await fixture.service.dispose();
  });

  it('discards renderer-cancelled plans without opening the native approval', async () => {
    const fixture = createFixture();
    const event = liveEvent(29);
    await requiredHandler(IPC_CHANNELS.checksPrepare)(event, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });

    const result = await requiredHandler(IPC_CHANNELS.checksConfirm)(event, {
      planId: PLAN.planId,
      confirmed: false,
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(fixture.discardPlanRuntime).toHaveBeenCalledWith(29, PLAN.planId);
    expect(fixture.startRuntime).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    expect(fixture.createApproval).not.toHaveBeenCalled();
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'check',
      'launch',
      'denied',
      expect.objectContaining({ reason: 'renderer-disclosure-cancelled' }),
    );
    await fixture.service.dispose();
  });

  it('starts exactly once after native approval and resists another owner consuming the plan', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const fixture = createFixture({ nativeResponse: 1 });
    const ownerEvent = liveEvent(31);
    await requiredHandler(IPC_CHANNELS.checksPrepare)(ownerEvent, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });

    const foreign = await requiredHandler(IPC_CHANNELS.checksConfirm)(liveEvent(32), {
      planId: PLAN.planId,
      confirmed: true,
    });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.startRuntime).not.toHaveBeenCalled();

    const approved = await requiredHandler(IPC_CHANNELS.checksConfirm)(ownerEvent, {
      planId: PLAN.planId,
      confirmed: true,
    });
    expect(approved).toEqual({ ok: true, value: EXECUTION });
    expect(fixture.startRuntime).toHaveBeenCalledWith(31, PLAN.planId, expect.any(Function));

    const replay = await requiredHandler(IPC_CHANNELS.checksConfirm)(ownerEvent, {
      planId: PLAN.planId,
      confirmed: true,
    });
    expect(replay).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.startRuntime).toHaveBeenCalledTimes(1);
    await fixture.service.dispose();
  });

  it('uses a live exact-scope saved approval without another native prompt', async () => {
    const fixture = createFixture({ savedApproval: savedCheckApproval() });
    const event = liveEvent(33);
    await requiredHandler(IPC_CHANNELS.checksPrepare)(event, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });

    const approved = await requiredHandler(IPC_CHANNELS.checksConfirm)(event, {
      planId: PLAN.planId,
      confirmed: true,
    });

    expect(approved).toEqual({ ok: true, value: EXECUTION });
    expect(fixture.findActiveApproval).toHaveBeenCalledWith({
      projectId: PLAN.projectId,
      action: 'command-execute',
      resourceFingerprint: PLAN.approvalFingerprint,
    });
    expect(fixture.authorizeApproval).toHaveBeenCalledWith({
      approvalId: 'saved-check-approval',
      scope: {
        projectId: PLAN.projectId,
        action: 'command-execute',
        resourceFingerprint: PLAN.approvalFingerprint,
      },
    });
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    expect(fixture.startRuntime).toHaveBeenCalledWith(33, PLAN.planId, expect.any(Function));
    expect(fixture.appendAudit).not.toHaveBeenCalledWith(
      'permission',
      'saved-approval-use',
      'allowed',
      expect.anything(),
    );
    await fixture.service.dispose();
  });

  it('lets a concurrent revoke win after async drift checks and before spawn authorization', async () => {
    const releaseRevalidation = deferred<boolean>();
    let revoked = false;
    const fixture = createFixture({
      savedApproval: savedCheckApproval(),
      start: async (authorizeLaunch) => {
        await releaseRevalidation.promise;
        authorizeLaunch?.();
        return EXECUTION;
      },
    });
    fixture.authorizeApproval.mockImplementation(() => {
      if (revoked) throw new Error('The scoped approval is revoked.');
      return savedCheckApproval();
    });
    const event = liveEvent(330);
    await requiredHandler(IPC_CHANNELS.checksPrepare)(event, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });

    const confirmation = requiredHandler(IPC_CHANNELS.checksConfirm)(event, {
      planId: PLAN.planId,
      confirmed: true,
    });
    await vi.waitFor(() => expect(fixture.startRuntime).toHaveBeenCalledTimes(1));
    expect(fixture.authorizeApproval).not.toHaveBeenCalled();
    revoked = true;
    releaseRevalidation.resolve(true);

    await expect(confirmation).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(fixture.authorizeApproval).toHaveBeenCalledTimes(1);
    expect(fixture.appendAudit).not.toHaveBeenCalledWith(
      'permission',
      'saved-approval-use',
      'allowed',
      expect.anything(),
    );
    await fixture.service.dispose();
  });

  it('does not reuse a saved approval after the exact check fingerprint changes', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const fixture = createFixture({
      nativeResponse: 0,
      savedApproval: savedCheckApproval('b'.repeat(64)),
    });
    const event = liveEvent(34);
    await requiredHandler(IPC_CHANNELS.checksPrepare)(event, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });

    const result = await requiredHandler(IPC_CHANNELS.checksConfirm)(event, {
      planId: PLAN.planId,
      confirmed: true,
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(fixture.showMessageBox).toHaveBeenCalledTimes(1);
    expect(fixture.startRuntime).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('persists a 30-day exact-scope grant only when the native checkbox is selected', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const fixture = createFixture({ nativeResponse: 1, nativeCheckbox: true });
    const event = liveEvent(36);
    await requiredHandler(IPC_CHANNELS.checksPrepare)(event, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });

    const result = await requiredHandler(IPC_CHANNELS.checksConfirm)(event, {
      planId: PLAN.planId,
      confirmed: true,
    });

    expect(result).toEqual({ ok: true, value: EXECUTION });
    expect(fixture.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          projectId: PLAN.projectId,
          action: 'command-execute',
          resourceFingerprint: PLAN.approvalFingerprint,
        },
        decidedBy: 'local-user',
        decision: 'approved',
        singleUse: false,
      }),
    );
    expect(fixture.appendAudit).not.toHaveBeenCalledWith(
      'permission',
      'saved-approval-grant',
      'allowed',
      expect.anything(),
    );
    await fixture.service.dispose();
  });

  it('removes handlers immediately and drains a deferred launch before disposal resolves', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const launch = deferred<CheckExecutionView>();
    const fixture = createFixture({ nativeResponse: 1, start: () => launch.promise });
    const event = liveEvent(35);
    await requiredHandler(IPC_CHANNELS.checksPrepare)(event, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });
    const confirmation = requiredHandler(IPC_CHANNELS.checksConfirm)(event, {
      planId: PLAN.planId,
      confirmed: true,
    });

    const disposal = fixture.service.dispose();
    expect(electronMock.handlers.size).toBe(0);
    expect(fixture.disposeRuntime).not.toHaveBeenCalled();
    launch.resolve(EXECUTION);

    await expect(confirmation).resolves.toEqual({ ok: true, value: EXECUTION });
    await disposal;
    expect(fixture.disposeRuntime).toHaveBeenCalledTimes(1);
  });

  it('discards the matching runtime plan when a renderer disclosure has expired', async () => {
    const expiredPlan = { ...PLAN, expiresAt: '2000-01-01T00:00:00.000Z' };
    const fixture = createFixture({ plan: expiredPlan });
    const event = liveEvent(37);
    await requiredHandler(IPC_CHANNELS.checksPrepare)(event, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });

    const result = await requiredHandler(IPC_CHANNELS.checksConfirm)(event, {
      planId: PLAN.planId,
      confirmed: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.discardPlanRuntime).toHaveBeenCalledWith(37, PLAN.planId);
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('approves once, returns the real running execution, and forwards bounded events', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const send = vi.fn();
    electronMock.fromId.mockReturnValue({ isDestroyed: () => false, send });
    const fixture = createFixture({ nativeResponse: 1 });
    const event = liveEvent(41);
    await requiredHandler(IPC_CHANNELS.checksPrepare)(event, {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });

    const result = await requiredHandler(IPC_CHANNELS.checksConfirm)(event, {
      planId: PLAN.planId,
      confirmed: true,
    });
    expect(result).toEqual({ ok: true, value: EXECUTION });
    expect(fixture.startRuntime).toHaveBeenCalledWith(41, PLAN.planId, expect.any(Function));

    fixture.emit(41, { projectId: PLAN.projectId, execution: EXECUTION });
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.checksEvent, {
      projectId: PLAN.projectId,
      execution: EXECUTION,
    });
    await fixture.service.dispose();
  });

  it('passes only validated execution ids to cancellation', async () => {
    const fixture = createFixture();
    const invalid = await requiredHandler(IPC_CHANNELS.checksCancel)(liveEvent(), {
      executionId: EXECUTION.id,
      signal: 'SIGKILL',
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(fixture.cancelRuntime).not.toHaveBeenCalled();

    const valid = await requiredHandler(IPC_CHANNELS.checksCancel)(liveEvent(7), {
      executionId: EXECUTION.id,
    });
    expect(valid).toEqual({ ok: true, value: EXECUTION });
    expect(fixture.cancelRuntime).toHaveBeenCalledWith(7, { executionId: EXECUTION.id });
    await fixture.service.dispose();
  });
});

const PLAN: CheckPlanView = {
  planId: '20000000-0000-4000-8000-000000000001',
  projectId: '20000000-0000-4000-8000-000000000002',
  checkId: 'lint',
  label: 'Lint',
  kind: 'lint',
  executable: '/usr/bin/node',
  arguments: ['--version'],
  cwd: '/tmp/project',
  environmentVariableNames: ['PATH'],
  approvalFingerprint: 'a'.repeat(64),
  expiresAt: '2099-07-15T00:05:00.000Z',
};

const EXECUTION: CheckExecutionView = {
  id: '20000000-0000-4000-8000-000000000003',
  projectId: PLAN.projectId,
  checkId: PLAN.checkId,
  label: PLAN.label,
  kind: PLAN.kind,
  executable: PLAN.executable,
  arguments: PLAN.arguments,
  cwd: PLAN.cwd,
  environmentVariableNames: PLAN.environmentVariableNames,
  status: 'running',
  exitCode: null,
  startedAt: '2026-07-15T00:00:00.000Z',
  endedAt: null,
  output: '',
  outputTruncated: false,
  updatedAt: '2026-07-15T00:00:00.000Z',
};

function createFixture({
  nativeResponse = 0,
  nativeCheckbox = false,
  plan = PLAN,
  savedApproval,
  prepare,
  start,
}: {
  nativeResponse?: number;
  nativeCheckbox?: boolean;
  plan?: CheckPlanView;
  savedApproval?: ApprovalRecord;
  prepare?: () => Promise<CheckPlanView>;
  start?: (authorizeLaunch?: () => void) => Promise<CheckExecutionView>;
} = {}) {
  let emit!: (ownerId: number, event: CheckEventEnvelope) => void;
  const prepareRuntime = vi.fn(() => prepare?.() ?? Promise.resolve(plan));
  const startRuntime = vi.fn((_ownerId: number, _planId: string, authorizeLaunch?: () => void) => {
    if (start !== undefined) return start(authorizeLaunch);
    authorizeLaunch?.();
    return Promise.resolve(EXECUTION);
  });
  const discardPlanRuntime = vi.fn();
  const listRuntime = vi.fn(() => []);
  const cancelRuntime = vi.fn(() => Promise.resolve(EXECUTION));
  const disposeRuntime = vi.fn();
  const runtime: CheckRuntimeOperations = {
    prepare: prepareRuntime,
    start: startRuntime,
    discardPlan: discardPlanRuntime,
    list: listRuntime,
    cancel: cancelRuntime,
    stopOwner: vi.fn(() => Promise.resolve()),
    resetForPrivacy: vi.fn(() => Promise.resolve()),
    pauseForDataMutation: vi.fn(),
    resumeAfterPrivacyReset: vi.fn(),
    dispose: disposeRuntime,
  };
  const showMessageBox = vi.fn((...args: [BaseWindow, MessageBoxOptions] | [MessageBoxOptions]) => {
    void args;
    return Promise.resolve({ response: nativeResponse, checkboxChecked: nativeCheckbox });
  });
  const appendAudit = vi.fn();
  const findActiveApproval = vi.fn((scope: ApprovalRecord['scope']) =>
    savedApproval !== undefined && sameScope(savedApproval.scope, scope)
      ? savedApproval
      : undefined,
  );
  const authorizeApproval = vi.fn(() => {
    if (savedApproval === undefined) throw new Error('No saved approval is active.');
    return savedApproval;
  });
  const createApproval = vi.fn(
    (input: ApprovalCreateInput): ApprovalView => ({
      status: 'active',
      record: {
        schemaVersion: 1,
        id: 'saved-check-approval',
        ...input,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
    }),
  );
  const service = new CheckIpcService(
    { showMessageBox },
    { appendAudit },
    (eventEmitter) => {
      emit = eventEmitter;
      return runtime;
    },
    { authorize: authorizeApproval, create: createApproval, findActive: findActiveApproval },
  );
  service.registerIpcHandlers();
  return {
    appendAudit,
    authorizeApproval,
    cancelRuntime,
    createApproval,
    discardPlanRuntime,
    disposeRuntime,
    emit,
    findActiveApproval,
    listRuntime,
    prepareRuntime,
    service,
    showMessageBox,
    startRuntime,
  };
}

function savedCheckApproval(resourceFingerprint = PLAN.approvalFingerprint): ApprovalRecord {
  return {
    schemaVersion: 1,
    id: 'saved-check-approval',
    scope: {
      projectId: PLAN.projectId,
      action: 'command-execute',
      resourceFingerprint,
    },
    decision: 'approved',
    decidedBy: 'local-user',
    reason: 'Remembered exact project check.',
    createdAt: '2026-07-15T00:00:00.000Z',
    expiresAt: '2099-07-15T00:00:00.000Z',
    singleUse: false,
  };
}

function sameScope(left: ApprovalRecord['scope'], right: ApprovalRecord['scope']): boolean {
  return (
    left.projectId === right.projectId &&
    left.action === right.action &&
    left.resourceFingerprint === right.resourceFingerprint &&
    left.agentId === right.agentId &&
    left.runId === right.runId
  );
}

function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let settle: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (settle === null) throw new Error('Deferred was not initialized.');
      settle(value);
    },
  };
}

function liveEvent(ownerId = 7): IpcMainInvokeEvent {
  const mainFrame = {};
  return {
    sender: {
      id: ownerId,
      mainFrame,
      isDestroyed: () => false,
      once: vi.fn(),
    },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
}

function requiredHandler(channel: string) {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler ${channel}.`);
  return handler;
}
