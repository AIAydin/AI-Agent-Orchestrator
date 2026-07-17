import type {
  BrowserWindow,
  Dialog,
  IpcMainInvokeEvent,
  MessageBoxOptions,
  MessageBoxReturnValue,
  WebContents,
} from 'electron';
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
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler,
  },
}));

import {
  READINESS_TEST_IDS,
  readinessGetView,
  readinessView,
} from '../../../shared/git/readiness/test-fixtures.js';
import { GIT_REMOTE_IPC_CHANNELS } from '../../../shared/git/remote/index.js';
import type { OutboundApprovalPlan } from '../../outbound/outbound-action-gate.js';
import { GitRemoteDeliveryIpcService, type GitRemoteDeliveryOperations } from './ipc.js';

const NOW = '2026-07-17T12:00:00.000Z';
const PLAN_ID = '80000000-0000-4000-8000-000000000001';
const SOURCE_HEAD = 'a'.repeat(40);
const BASE_OID = 'f'.repeat(40);
const TARGET = {
  kind: 'agent-worktree' as const,
  projectId: READINESS_TEST_IDS.projectId,
  runId: READINESS_TEST_IDS.runId,
};
const REMOTE = {
  kind: 'network' as const,
  name: 'origin',
  endpoint: 'github.com',
  resource: 'forgeboard/example',
  transport: 'ssh' as const,
  githubCompatible: true,
};
const PUSH_INPUT = {
  target: TARGET,
  remote: 'origin',
  destinationBranch: 'feature/remote-delivery',
};
const CONFIRM_INPUT = { planId: PLAN_ID };
const APPROVAL_PLAN: OutboundApprovalPlan = {
  id: PLAN_ID,
  expiresAt: NOW,
  disclosureSha256: '9'.repeat(64),
  disclosure: {
    action: 'git-push',
    title: 'Push reviewed commits?',
    summary: 'Push one exact commit to the selected remote branch.',
    confirmLabel: 'Push commits',
    destination: {
      kind: 'git-remote',
      endpoint: 'github.com',
      resource: 'forgeboard/example',
      transport: 'SSH',
    },
    details: [
      { label: 'Source', value: SOURCE_HEAD },
      { label: 'Destination branch', value: PUSH_INPUT.destinationBranch },
    ],
    warning: 'This changes a remote Git repository.',
  },
};

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

describe('GitRemoteDeliveryIpcService', () => {
  it('rejects hostile shapes and non-main-frame callers before assigning authority', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandlers();
    const event = liveEvent();

    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.inspect)(event, {
        target: TARGET,
        repositoryPath: '/private/renderer-selected/repository',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.preparePush)(event, {
        ...PUSH_INPUT,
        force: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.cancelPlan)(event, {
        planId: PLAN_ID,
        ownerId: 'renderer-selected-owner',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });

    const subframe = liveEvent();
    Object.defineProperty(subframe, 'senderFrame', { value: {} });
    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.preparePush)(subframe, PUSH_INPUT),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });

    const detachedMainFrame = liveEvent();
    Object.defineProperty(detachedMainFrame.senderFrame, 'detached', {
      value: true,
    });
    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.preparePush)(detachedMainFrame, PUSH_INPUT),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });

    const missingFrame = liveEvent();
    Object.defineProperty(missingFrame, 'senderFrame', { value: null });
    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.preparePush)(missingFrame, PUSH_INPUT),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });

    expect(fixture.inspect).not.toHaveBeenCalled();
    expect(fixture.preparePush).not.toHaveBeenCalled();
    expect(fixture.cancelPlan).not.toHaveBeenCalled();
    expect(event.sender.destroyedListenerCount()).toBe(0);
    expect(subframe.sender.destroyedListenerCount()).toBe(0);
    expect(detachedMainFrame.sender.destroyedListenerCount()).toBe(0);
    expect(missingFrame.sender.destroyedListenerCount()).toBe(0);
    await fixture.service.dispose();
  });

  it('uses one opaque owner for one live main frame and never shares it across windows', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandlers();
    const first = liveEvent(41);
    const second = liveEvent(42);

    await expect(handler(GIT_REMOTE_IPC_CHANNELS.preparePush)(first, PUSH_INPUT)).resolves.toEqual({
      ok: true,
      value: pushPlan(),
    });
    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.confirmPush)(first, CONFIRM_INPUT),
    ).resolves.toEqual({ ok: true, value: null });
    await handler(GIT_REMOTE_IPC_CHANNELS.preparePush)(second, PUSH_INPUT);

    const preparedOwner = fixture.preparePush.mock.calls[0]?.[0];
    const confirmedOwner = fixture.confirmPush.mock.calls[0]?.[0];
    const secondOwner = fixture.preparePush.mock.calls[1]?.[0];
    expect(preparedOwner).toMatch(/^git-remote-window:41:/u);
    expect(confirmedOwner).toBe(preparedOwner);
    expect(secondOwner).toMatch(/^git-remote-window:42:/u);
    expect(secondOwner).not.toBe(preparedOwner);
    expect(first.sender.destroyedListenerCount()).toBe(1);
    expect(second.sender.destroyedListenerCount()).toBe(1);
    await fixture.service.dispose();
  });

  it('derives plan-cancellation ownership from each live main frame', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandlers();
    const first = liveEvent(51);
    const second = liveEvent(52);

    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.cancelPlan)(first, { planId: PLAN_ID }),
    ).resolves.toEqual({ ok: true, value: { acknowledged: true } });
    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.cancelPlan)(second, { planId: PLAN_ID }),
    ).resolves.toEqual({ ok: true, value: { acknowledged: true } });

    const firstOwner = fixture.cancelPlan.mock.calls[0]?.[0];
    const secondOwner = fixture.cancelPlan.mock.calls[1]?.[0];
    expect(firstOwner).toMatch(/^git-remote-window:51:/u);
    expect(secondOwner).toMatch(/^git-remote-window:52:/u);
    expect(secondOwner).not.toBe(firstOwner);
    expect(fixture.cancelPlan.mock.calls.map((call) => call[1])).toEqual([PLAN_ID, PLAN_ID]);
    await fixture.service.dispose();
  });

  it('keeps native cancellation default-safe and executes no remote delivery', async () => {
    const fixture = createFixture({ nativeResponse: 0 });
    fixture.service.registerIpcHandlers();

    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.confirmPush)(liveEvent(), CONFIRM_INPUT),
    ).resolves.toEqual({ ok: true, value: null });
    expect(fixture.confirmPush).toHaveBeenCalledTimes(1);
    expect(fixture.executed).toBe(false);
    expect(fixture.showMessageBox).toHaveBeenCalledWith(
      fixture.parent,
      expect.objectContaining({
        title: APPROVAL_PLAN.disclosure.title,
        buttons: ['Cancel', APPROVAL_PLAN.disclosure.confirmLabel],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    await fixture.service.dispose();
  });

  it('rechecks the originating main frame after native approval before execution', async () => {
    const decision = deferred<MessageBoxReturnValue>();
    const fixture = createFixture({ decision: decision.promise });
    fixture.service.registerIpcHandlers();
    const event = liveEvent();
    const request = handler(GIT_REMOTE_IPC_CHANNELS.confirmPush)(event, CONFIRM_INPUT);
    await vi.waitFor(() => expect(fixture.showMessageBox).toHaveBeenCalledTimes(1));

    Object.defineProperty(event, 'senderFrame', { value: {} });
    decision.resolve({ response: 1, checkboxChecked: false });

    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(fixture.executed).toBe(false);
    await fixture.service.dispose();
  });

  it('discards every pending plan owned by a destroyed renderer window', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandlers();
    const event = liveEvent(73);
    await handler(GIT_REMOTE_IPC_CHANNELS.preparePush)(event, PUSH_INPUT);
    const ownerId = fixture.preparePush.mock.calls[0]?.[0];

    event.sender.emitDestroyed();

    expect(fixture.discardOwner).toHaveBeenCalledTimes(1);
    expect(fixture.discardOwner).toHaveBeenCalledWith(ownerId);
    expect(event.sender.destroyedListenerCount()).toBe(0);
    await fixture.service.dispose();
  });

  it.each([
    '/private/managed/worktree/.git/config',
    'file:///private/managed/worktree/.git/config',
    '~/managed/worktree/.git/config',
    String.raw`C:\Users\forgeboard\managed\.git\config`,
    String.raw`\\server\managed\worktree\.git\config`,
  ])('keeps main-only path %s out of renderer errors and audit metadata', async (secretPath) => {
    const fixture = createFixture();
    fixture.inspect.mockRejectedValueOnce(new Error(`Cannot inspect ${secretPath}`));
    fixture.service.registerIpcHandlers();

    const result = await handler(GIT_REMOTE_IPC_CHANNELS.inspect)(liveEvent(), {
      target: TARGET,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message:
          'Remote delivery could not verify the exact current source or destination. Refresh and try again.',
      },
    });
    expect(JSON.stringify(result)).not.toContain(secretPath);
    expect(JSON.stringify(fixture.appendAudit.mock.calls)).not.toContain(secretPath);
    expect(fixture.appendAudit).toHaveBeenLastCalledWith(
      'git-remote-delivery',
      'ipc-request',
      'failed',
      { validation: false, errorKind: 'Error' },
    );
    await fixture.service.dispose();
  });

  it.each([
    'token=path-free-secret-value',
    'Authorization: Bearer path-free-secret-value',
    'client_secret: path-free-secret-value',
    'ghp_1234567890abcdef',
  ])('keeps path-free credential text out of renderer errors: %s', async (secretText) => {
    const fixture = createFixture();
    fixture.inspect.mockRejectedValueOnce(new Error(`Request failed: ${secretText}`));
    fixture.service.registerIpcHandlers();

    const result = await handler(GIT_REMOTE_IPC_CHANNELS.inspect)(liveEvent(), {
      target: TARGET,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message:
          'Remote delivery could not verify the exact current source or destination. Refresh and try again.',
      },
    });
    expect(JSON.stringify(result)).not.toContain(secretText);
    expect(JSON.stringify(fixture.appendAudit.mock.calls)).not.toContain(secretText);
    await fixture.service.dispose();
  });

  it('refuses a data mutation pause while an admitted IPC operation is active', async () => {
    const fixture = createFixture();
    const pending = deferred<ReturnType<typeof inspectView>>();
    fixture.inspect.mockImplementationOnce(() => pending.promise);
    fixture.service.registerIpcHandlers();
    const event = liveEvent();
    const request = handler(GIT_REMOTE_IPC_CHANNELS.inspect)(event, {
      target: TARGET,
    });
    await vi.waitFor(() => expect(fixture.inspect).toHaveBeenCalledTimes(1));

    await expect(fixture.service.pauseForDataMutation()).rejects.toThrow(
      'Wait for every Git remote-delivery operation before changing worktrees.',
    );
    expect(fixture.resetForPrivacy).not.toHaveBeenCalled();

    pending.resolve(inspectView());
    await expect(request).resolves.toEqual({ ok: true, value: inspectView() });
    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.inspect)(event, { target: TARGET }),
    ).resolves.toEqual({ ok: true, value: inspectView() });
    await fixture.service.dispose();
  });

  it('invalidates CLI-bound delivery state without pausing ordinary IPC admission', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandlers();

    fixture.service.invalidateGitHubRuntime();

    expect(fixture.invalidateGitHubRuntime).toHaveBeenCalledTimes(1);
    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.inspect)(liveEvent(), { target: TARGET }),
    ).resolves.toEqual({ ok: true, value: inspectView() });
    await fixture.service.dispose();
  });

  it('admits a CLI-only mutation only while delivery is idle and does not reset push state', async () => {
    const fixture = createFixture();
    const pending = deferred<ReturnType<typeof inspectView>>();
    fixture.inspect.mockImplementationOnce(() => pending.promise);
    fixture.service.registerIpcHandlers();
    const event = liveEvent();
    const request = handler(GIT_REMOTE_IPC_CHANNELS.inspect)(event, {
      target: TARGET,
    });
    await vi.waitFor(() => expect(fixture.inspect).toHaveBeenCalledTimes(1));

    expect(() => fixture.service.pauseForGitHubRuntimeMutation()).toThrow(
      'Wait for every Git remote-delivery operation before changing GitHub CLI.',
    );
    pending.resolve(inspectView());
    await expect(request).resolves.toEqual({ ok: true, value: inspectView() });

    fixture.service.pauseForGitHubRuntimeMutation();
    expect(fixture.resetForPrivacy).not.toHaveBeenCalled();
    expect(fixture.invalidateGitHubRuntime).not.toHaveBeenCalled();
    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.inspect)(event, { target: TARGET }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });

    fixture.service.invalidateGitHubRuntime();
    fixture.service.resumeAfterPrivacyReset();
    expect(fixture.invalidateGitHubRuntime).toHaveBeenCalledOnce();
    await expect(
      handler(GIT_REMOTE_IPC_CHANNELS.inspect)(event, { target: TARGET }),
    ).resolves.toEqual({ ok: true, value: inspectView() });
    await fixture.service.dispose();
  });

  it('removes every handler and owner listener, drains admitted work, and cannot revive', async () => {
    const fixture = createFixture();
    const pending = deferred<ReturnType<typeof inspectView>>();
    fixture.inspect.mockImplementationOnce(() => pending.promise);
    fixture.service.registerIpcHandlers();
    const event = liveEvent();
    await handler(GIT_REMOTE_IPC_CHANNELS.preparePush)(event, PUSH_INPUT);
    const request = handler(GIT_REMOTE_IPC_CHANNELS.inspect)(event, {
      target: TARGET,
    });
    await vi.waitFor(() => expect(fixture.inspect).toHaveBeenCalledTimes(1));

    const disposal = fixture.service.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await vi.waitFor(() => expect(fixture.dispose).toHaveBeenCalledTimes(1));
    expect(disposed).toBe(false);
    for (const channel of Object.values(GIT_REMOTE_IPC_CHANNELS)) {
      expect(electronMock.handlers.has(channel)).toBe(false);
      expect(electronMock.removeHandler).toHaveBeenCalledWith(channel);
    }

    pending.resolve(inspectView());
    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    await disposal;
    expect(disposed).toBe(true);
    expect(event.sender.destroyedListenerCount()).toBe(0);
    expect(() => fixture.service.registerIpcHandlers()).toThrow(
      'The Git remote-delivery IPC service is disposed.',
    );
    await fixture.service.dispose();
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
  });
});

function createFixture(
  options: {
    readonly nativeResponse?: number;
    readonly decision?: Promise<MessageBoxReturnValue>;
  } = {},
) {
  const parent = { isDestroyed: () => false } as BrowserWindow;
  electronMock.fromWebContents.mockReturnValue(parent);
  let executed = false;
  const inspect = vi.fn<GitRemoteDeliveryOperations['inspect']>().mockResolvedValue(inspectView());
  const cancelPlan = vi
    .fn<GitRemoteDeliveryOperations['cancelPlan']>()
    .mockResolvedValue({ acknowledged: true });
  const preparePush = vi
    .fn<GitRemoteDeliveryOperations['preparePush']>()
    .mockResolvedValue(pushPlan());
  const confirmPush = vi.fn<GitRemoteDeliveryOperations['confirmPush']>(
    async (_ownerId, _planId, confirmation) => {
      if ((await confirmation.confirm(APPROVAL_PLAN)) !== 'approved') return null;
      executed = true;
      return {
        remote: REMOTE.name,
        destinationBranch: PUSH_INPUT.destinationBranch,
        sourceOid: SOURCE_HEAD,
      };
    },
  );
  const prepareGitHubStatus = vi.fn<GitRemoteDeliveryOperations['prepareGitHubStatus']>();
  const confirmGitHubStatus = vi
    .fn<GitRemoteDeliveryOperations['confirmGitHubStatus']>()
    .mockResolvedValue(null);
  const preparePullRequest = vi.fn<GitRemoteDeliveryOperations['preparePullRequest']>();
  const confirmPullRequest = vi
    .fn<GitRemoteDeliveryOperations['confirmPullRequest']>()
    .mockResolvedValue(null);
  const prepareCi = vi.fn<GitRemoteDeliveryOperations['prepareCi']>();
  const confirmCi = vi.fn<GitRemoteDeliveryOperations['confirmCi']>().mockResolvedValue(null);
  const invalidateGitHubRuntime = vi.fn<GitRemoteDeliveryOperations['invalidateGitHubRuntime']>();
  const discardOwner = vi.fn<GitRemoteDeliveryOperations['discardOwner']>();
  const resetForPrivacy = vi
    .fn<GitRemoteDeliveryOperations['resetForPrivacy']>()
    .mockResolvedValue(undefined);
  const pauseForShutdown = vi
    .fn<GitRemoteDeliveryOperations['pauseForShutdown']>()
    .mockResolvedValue(undefined);
  const resumeAfterPrivacyReset = vi.fn<GitRemoteDeliveryOperations['resumeAfterPrivacyReset']>();
  const dispose = vi.fn<GitRemoteDeliveryOperations['dispose']>().mockResolvedValue(undefined);
  const delivery = {
    inspect,
    cancelPlan,
    preparePush,
    confirmPush,
    prepareGitHubStatus,
    confirmGitHubStatus,
    preparePullRequest,
    confirmPullRequest,
    prepareCi,
    confirmCi,
    invalidateGitHubRuntime,
    discardOwner,
    resetForPrivacy,
    pauseForShutdown,
    resumeAfterPrivacyReset,
    dispose,
  } satisfies GitRemoteDeliveryOperations;
  const showMessageBox = vi.fn<
    (parentWindow: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  >(
    () =>
      options.decision ??
      Promise.resolve({
        response: options.nativeResponse ?? 0,
        checkboxChecked: false,
      }),
  );
  const appendAudit = vi.fn();
  const service = new GitRemoteDeliveryIpcService(
    { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
    delivery,
    { appendAudit },
  );
  return {
    service,
    parent,
    inspect,
    cancelPlan,
    preparePush,
    confirmPush,
    invalidateGitHubRuntime,
    discardOwner,
    resetForPrivacy,
    dispose,
    showMessageBox,
    appendAudit,
    get executed() {
      return executed;
    },
  };
}

function inspectView() {
  return {
    target: TARGET,
    projectName: 'Example',
    sourceBranch: 'forgeboard/agent-run',
    baseRef: 'main',
    baseCommit: BASE_OID,
    divergenceBaseCommit: BASE_OID,
    sourceHead: SOURCE_HEAD,
    ahead: 1,
    behind: 0,
    dirty: false,
    commitCount: 1,
    commits: [SOURCE_HEAD],
    commitsTruncated: false,
    fileCount: 1,
    files: [{ oldPath: null, newPath: 'src/app.ts', status: 'added' as const }],
    filesTruncated: false,
    additions: 12,
    deletions: 0,
    remotes: [REMOTE],
    defaultRemote: 'origin',
    readiness: readinessGetView(readinessView()),
    refreshedAt: NOW,
  };
}

function pushPlan() {
  return {
    kind: 'git-push' as const,
    planId: PLAN_ID,
    expiresAt: NOW,
    target: TARGET,
    projectName: 'Example',
    remote: REMOTE,
    sourceBranch: 'forgeboard/agent-run',
    destinationBranch: PUSH_INPUT.destinationBranch,
    baseCommit: BASE_OID,
    sourceHead: SOURCE_HEAD,
    commitCount: 1,
    commits: [SOURCE_HEAD],
    fileCount: 1,
    files: [{ oldPath: null, newPath: 'src/app.ts', status: 'added' as const }],
    additions: 12,
    deletions: 0,
    force: false as const,
    readiness: readinessView(),
    readinessApprovalId: READINESS_TEST_IDS.approvalId,
  };
}

type LiveInvokeEvent = IpcMainInvokeEvent & {
  readonly sender: WebContents & {
    emitDestroyed(): void;
    destroyedListenerCount(): number;
  };
};

function liveEvent(id = 41): LiveInvokeEvent {
  const mainFrame = {};
  let destroyed = false;
  const destroyedListeners = new Set<() => void>();
  const rawSender = {
    id,
    mainFrame,
    isDestroyed: () => destroyed,
    once(eventName: string, listener: () => void) {
      if (eventName === 'destroyed') destroyedListeners.add(listener);
      return rawSender;
    },
    removeListener(eventName: string, listener: () => void) {
      if (eventName === 'destroyed') destroyedListeners.delete(listener);
      return rawSender;
    },
    emitDestroyed() {
      destroyed = true;
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
  if (registered === undefined) throw new Error(`Missing IPC handler ${channel}.`);
  return registered;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
