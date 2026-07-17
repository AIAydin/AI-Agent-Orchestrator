import type { IpcMainInvokeEvent, MessageBoxOptions, WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  return {
    handlers: new Map<string, Handler>(),
    fromWebContents: vi.fn(),
    handle: vi.fn((channel: string, handler: Handler) => {
      electronMock.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => electronMock.handlers.delete(channel)),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
  ipcMain: { handle: electronMock.handle, removeHandler: electronMock.removeHandler },
}));

import {
  GIT_DELIVERY_READINESS_IPC_CHANNELS,
  evaluateGitDeliveryReadiness,
} from '../../../shared/git/readiness/index.js';
import {
  READINESS_TEST_IDS,
  readinessFingerprint,
  readinessGetView,
  readinessView,
} from '../../../shared/git/readiness/test-fixtures.js';
import { createExactCheckDisclosure } from '../../workflow/exact-check/contracts.js';
import { GitDeliveryReadinessIpcService, type GitDeliveryReadinessOperations } from './ipc.js';

const TARGET = {
  kind: 'agent-worktree' as const,
  projectId: READINESS_TEST_IDS.projectId,
  runId: READINESS_TEST_IDS.runId,
};
const RUN_INPUT = {
  readinessId: READINESS_TEST_IDS.readinessId,
  checkId: READINESS_TEST_IDS.checkId,
  expectedSourceFingerprint: readinessFingerprint().digest,
};
const PREPARE_INPUT = {
  target: TARGET,
  workflowExecutionId: READINESS_TEST_IDS.workflowExecutionId,
  additionalCheckIds: [READINESS_TEST_IDS.checkId],
};
const APPROVE_INPUT = {
  readinessId: READINESS_TEST_IDS.readinessId,
  expectedSourceFingerprint: readinessFingerprint().digest,
  confirmed: true as const,
};

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
  electronMock.fromWebContents.mockReset();
});

describe('GitDeliveryReadinessIpcService', () => {
  it('validates and forwards the exact workflow-bound prepare request', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandlers();

    await expect(
      handler(GIT_DELIVERY_READINESS_IPC_CHANNELS.prepare)(liveEvent(), PREPARE_INPUT),
    ).resolves.toEqual({ ok: true, value: unapprovedReadiness() });
    expect(fixture.prepare).toHaveBeenCalledWith(PREPARE_INPUT);
    await expect(
      handler(GIT_DELIVERY_READINESS_IPC_CHANNELS.prepare)(liveEvent(), {
        ...PREPARE_INPUT,
        additionalCheckIds: [READINESS_TEST_IDS.checkId, READINESS_TEST_IDS.checkId],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    await fixture.service.dispose();
  });

  it('keeps native check cancellation default-safe and launches no exact process', async () => {
    const fixture = createFixture({ responses: [0] });
    fixture.service.registerIpcHandlers();

    await expect(
      handler(GIT_DELIVERY_READINESS_IPC_CHANNELS.run)(liveEvent(), RUN_INPUT),
    ).resolves.toEqual({ ok: true, value: null });
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(fixture.launched).toBe(false);
    expect(fixture.showMessageBox).toHaveBeenCalledWith(
      fixture.parent,
      expect.objectContaining({
        title: 'Run delivery check',
        buttons: ['Cancel', 'Run exact check'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    const options = fixture.showMessageBox.mock.calls[0]?.[1] as MessageBoxOptions;
    expect(options.detail).toContain('/private/managed/worktree');
    expect(options.detail).toContain(process.execPath);
    await fixture.service.dispose();
  });

  it('binds native human review to evidence A and refuses evidence B after the dialog', async () => {
    const decision = deferred<{ response: number; checkboxChecked: boolean }>();
    const reviewed = unapprovedReadiness();
    let currentEvidence = reviewed.evidenceFingerprint;
    const fixture = createFixture({ decision: decision.promise, reviewed });
    fixture.approve.mockImplementation((_input, expectedEvidenceFingerprint) => {
      if (expectedEvidenceFingerprint !== currentEvidence) {
        return Promise.reject(new Error('Delivery check evidence changed after human review.'));
      }
      return Promise.resolve(readinessView());
    });
    fixture.service.registerIpcHandlers();
    const request = handler(GIT_DELIVERY_READINESS_IPC_CHANNELS.approve)(
      liveEvent(),
      APPROVE_INPUT,
    );
    await vi.waitFor(() => expect(fixture.showMessageBox).toHaveBeenCalledTimes(1));

    currentEvidence = '8'.repeat(64);
    decision.resolve({ response: 1, checkboxChecked: false });
    const result = await request;
    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(JSON.stringify(result)).toContain('evidence changed');
    expect(fixture.approve).toHaveBeenCalledWith(APPROVE_INPUT, reviewed.evidenceFingerprint);
    await fixture.service.dispose();
  });

  it('requires explicit native human approval and returns null on cancellation', async () => {
    const reviewed = unapprovedReadiness();
    const fixture = createFixture({ responses: [0], reviewed });
    fixture.service.registerIpcHandlers();

    await expect(
      handler(GIT_DELIVERY_READINESS_IPC_CHANNELS.approve)(liveEvent(), APPROVE_INPUT),
    ).resolves.toEqual({ ok: true, value: null });
    expect(fixture.approve).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).toHaveBeenCalledWith(
      fixture.parent,
      expect.objectContaining({
        title: 'Approve delivery readiness',
        buttons: ['Cancel', 'Approve readiness'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'git-delivery-readiness',
      'approve-human',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-cancelled' }),
    );
    await fixture.service.dispose();
  });

  it('rejects subframes before discovery and stops exact work when its owner closes', async () => {
    const fixture = createFixture({ responses: [1] });
    fixture.service.registerIpcHandlers();
    const invalid = liveEvent();
    Object.defineProperty(invalid, 'senderFrame', { value: {} });
    await expect(
      handler(GIT_DELIVERY_READINESS_IPC_CHANNELS.get)(invalid, { target: TARGET }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.get).not.toHaveBeenCalled();

    const event = liveEvent();
    await handler(GIT_DELIVERY_READINESS_IPC_CHANNELS.run)(event, RUN_INPUT);
    event.sender.emitDestroyed();
    await vi.waitFor(() => expect(fixture.stopOwner).toHaveBeenCalledTimes(1));
    await fixture.service.dispose();
  });

  it('removes owner close listeners across privacy resets before assigning a new owner', async () => {
    const fixture = createFixture({ responses: [0, 0] });
    fixture.service.registerIpcHandlers();
    const event = liveEvent();

    await handler(GIT_DELIVERY_READINESS_IPC_CHANNELS.run)(event, RUN_INPUT);
    expect(event.sender.destroyedListenerCount()).toBe(1);
    await fixture.service.resetForPrivacy();
    expect(event.sender.destroyedListenerCount()).toBe(0);

    fixture.service.resumeAfterPrivacyReset();
    await handler(GIT_DELIVERY_READINESS_IPC_CHANNELS.run)(event, RUN_INPUT);
    expect(event.sender.destroyedListenerCount()).toBe(1);
    event.sender.emitDestroyed();
    await vi.waitFor(() => expect(fixture.stopOwner).toHaveBeenCalledTimes(1));
    expect(event.sender.destroyedListenerCount()).toBe(0);
    await fixture.service.dispose();
  });

  it('keeps absolute main-only paths out of renderer error responses', async () => {
    const fixture = createFixture();
    fixture.get.mockRejectedValueOnce(
      new Error('Cannot stat executable /private/managed/worktree/node_modules/.bin/lint'),
    );
    fixture.service.registerIpcHandlers();

    const result = await handler(GIT_DELIVERY_READINESS_IPC_CHANNELS.get)(liveEvent(), {
      target: TARGET,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message:
          'Delivery readiness could not verify the current source or command. Refresh and try again.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('/private/managed/worktree');
    expect(fixture.appendAudit.mock.calls.at(-1)?.slice(0, 3)).toEqual([
      'git-delivery-readiness',
      'ipc-request',
      'failed',
    ]);
    expect(JSON.stringify(fixture.appendAudit.mock.calls.at(-1)?.[3])).toContain(
      '/private/managed/worktree',
    );
    await fixture.service.dispose();
  });
});

function createFixture(
  options: {
    readonly responses?: number[];
    readonly decision?: Promise<{ response: number; checkboxChecked: boolean }>;
    readonly reviewed?: ReturnType<typeof unapprovedReadiness>;
  } = {},
) {
  const parent = { isDestroyed: () => false };
  electronMock.fromWebContents.mockReturnValue(parent);
  const responses = [...(options.responses ?? [])];
  let launched = false;
  const get = vi.fn(() => Promise.resolve(readinessGetView(null)));
  const prepare = vi.fn(() => Promise.resolve(options.reviewed ?? unapprovedReadiness()));
  const run = vi.fn(
    async (
      _input: Parameters<GitDeliveryReadinessOperations['run']>[0],
      authority: Parameters<GitDeliveryReadinessOperations['run']>[1],
    ) => {
      const disclosure = createExactCheckDisclosure({
        schemaVersion: 1,
        planId: '94000000-0000-4000-8000-000000000001',
        ownerId: authority.ownerId,
        target: {
          kind: 'managed-worktree',
          projectId: TARGET.projectId,
          runId: TARGET.runId,
        },
        checkId: RUN_INPUT.checkId,
        label: 'Deterministic verification',
        kind: 'custom',
        executable: process.execPath,
        arguments: ['--version'],
        cwd: '/private/managed/worktree',
        environmentVariableNames: ['PATH'],
        expiresAt: '2026-07-16T21:00:00.000Z',
      });
      await authority.authorize(disclosure);
      launched = true;
      return readinessView();
    },
  );
  const reviewed = options.reviewed ?? unapprovedReadiness();
  const reviewApproval = vi.fn(() => Promise.resolve(reviewed));
  const approve = vi.fn<GitDeliveryReadinessOperations['approve']>(
    (input, expectedEvidenceFingerprint) => {
      void input;
      void expectedEvidenceFingerprint;
      return Promise.resolve(readinessView());
    },
  );
  const stopOwner = vi.fn(() => Promise.resolve());
  const resetForPrivacy = vi.fn(() => Promise.resolve());
  const dispose = vi.fn(() => Promise.resolve());
  const appendAudit = vi.fn();
  const showMessageBox = vi.fn((parentWindow: unknown, messageOptions: MessageBoxOptions) => {
    void parentWindow;
    void messageOptions;
    return (
      options.decision ??
      Promise.resolve({ response: responses.shift() ?? 0, checkboxChecked: false })
    );
  });
  const operations = {
    get,
    prepare,
    run,
    reviewApproval,
    approve,
    stopOwner,
    resetForPrivacy,
    dispose,
  } satisfies GitDeliveryReadinessOperations;
  const service = new GitDeliveryReadinessIpcService({ showMessageBox } as never, operations, {
    appendAudit,
  });
  return {
    service,
    parent,
    get,
    prepare,
    run,
    approve,
    stopOwner,
    appendAudit,
    showMessageBox,
    get launched() {
      return launched;
    },
  };
}

function unapprovedReadiness() {
  const base = readinessView();
  const evidence = {
    readinessId: base.readinessId,
    target: base.target,
    sourceFingerprint: base.sourceFingerprint,
    workflowBinding: base.workflowBinding,
    availableChecks: base.availableChecks,
    requiredChecks: base.requiredChecks,
    approvals: [],
    evidenceFingerprint: base.evidenceFingerprint,
    updatedAt: base.updatedAt,
  };
  return { ...evidence, evaluation: evaluateGitDeliveryReadiness(evidence) };
}

type LiveInvokeEvent = IpcMainInvokeEvent & {
  readonly sender: WebContents & {
    emitDestroyed(): void;
    destroyedListenerCount(): number;
  };
};

function liveEvent(): LiveInvokeEvent {
  const mainFrame = {};
  const destroyedListeners = new Set<() => void>();
  const rawSender = {
    id: 41,
    mainFrame,
    isDestroyed: () => false,
    once(eventName: string, listener: () => void) {
      if (eventName === 'destroyed') destroyedListeners.add(listener);
      return rawSender;
    },
    removeListener(eventName: string, listener: () => void) {
      if (eventName === 'destroyed') destroyedListeners.delete(listener);
      return rawSender;
    },
    emitDestroyed() {
      const listeners = [...destroyedListeners];
      destroyedListeners.clear();
      for (const listener of listeners) listener();
    },
    destroyedListenerCount() {
      return destroyedListeners.size;
    },
  };
  const sender = rawSender as unknown as LiveInvokeEvent['sender'];
  return { sender, senderFrame: mainFrame } as unknown as LiveInvokeEvent;
}

function handler(channel: string) {
  const registered = electronMock.handlers.get(channel);
  if (registered === undefined) throw new Error(`Missing handler ${channel}`);
  return registered;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
