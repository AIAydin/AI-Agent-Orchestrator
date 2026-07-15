import type { BaseWindow, IpcMainInvokeEvent, MessageBoxOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
} from '../shared/check-contracts.js';
import { IPC_CHANNELS } from '../shared/contracts.js';
import { CheckIpcService, type CheckRuntimeOperations } from './check-ipc.js';

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset();
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
    expect(messageBoxCall[1].detail).toContain(`Executable: ${PLAN.executable}`);
    expect(messageBoxCall[1].detail).toContain('exportable without redaction');
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
    await requiredHandler(IPC_CHANNELS.checksPrepare)(liveEvent(31), {
      projectId: PLAN.projectId,
      checkId: 'lint',
    });

    const foreign = await requiredHandler(IPC_CHANNELS.checksConfirm)(liveEvent(32), {
      planId: PLAN.planId,
      confirmed: true,
    });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.startRuntime).not.toHaveBeenCalled();

    const approved = await requiredHandler(IPC_CHANNELS.checksConfirm)(liveEvent(31), {
      planId: PLAN.planId,
      confirmed: true,
    });
    expect(approved).toEqual({ ok: true, value: EXECUTION });
    expect(fixture.startRuntime).toHaveBeenCalledWith(31, PLAN.planId);

    const replay = await requiredHandler(IPC_CHANNELS.checksConfirm)(liveEvent(31), {
      planId: PLAN.planId,
      confirmed: true,
    });
    expect(replay).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.startRuntime).toHaveBeenCalledTimes(1);
    await fixture.service.dispose();
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
    expect(fixture.startRuntime).toHaveBeenCalledWith(41, PLAN.planId);

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
  plan = PLAN,
}: { nativeResponse?: number; plan?: CheckPlanView } = {}) {
  let emit!: (ownerId: number, event: CheckEventEnvelope) => void;
  const prepareRuntime = vi.fn(() => Promise.resolve(plan));
  const startRuntime = vi.fn(() => Promise.resolve(EXECUTION));
  const discardPlanRuntime = vi.fn();
  const listRuntime = vi.fn(() => []);
  const cancelRuntime = vi.fn(() => Promise.resolve(EXECUTION));
  const runtime: CheckRuntimeOperations = {
    prepare: prepareRuntime,
    start: startRuntime,
    discardPlan: discardPlanRuntime,
    list: listRuntime,
    cancel: cancelRuntime,
    stopOwner: vi.fn(() => Promise.resolve()),
    resetForPrivacy: vi.fn(() => Promise.resolve()),
    resumeAfterPrivacyReset: vi.fn(),
    dispose: vi.fn(),
  };
  const showMessageBox = vi.fn((...args: [BaseWindow, MessageBoxOptions] | [MessageBoxOptions]) => {
    void args;
    return Promise.resolve({ response: nativeResponse, checkboxChecked: false });
  });
  const appendAudit = vi.fn();
  const service = new CheckIpcService({ showMessageBox }, { appendAudit }, (eventEmitter) => {
    emit = eventEmitter;
    return runtime;
  });
  service.registerIpcHandlers();
  return {
    appendAudit,
    cancelRuntime,
    discardPlanRuntime,
    emit,
    listRuntime,
    prepareRuntime,
    service,
    showMessageBox,
    startRuntime,
  };
}

function liveEvent(ownerId = 7): IpcMainInvokeEvent {
  return {
    sender: {
      id: ownerId,
      isDestroyed: () => false,
      once: vi.fn(),
    },
  } as unknown as IpcMainInvokeEvent;
}

function requiredHandler(channel: string) {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler ${channel}.`);
  return handler;
}
