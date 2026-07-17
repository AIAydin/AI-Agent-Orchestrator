import type {
  BrowserWindow,
  Dialog,
  IpcMainInvokeEvent,
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogOptions,
  OpenDialogReturnValue,
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
  ipcMain: { handle: electronMock.handle, removeHandler: electronMock.removeHandler },
}));

import {
  GIT_CONNECTIONS_IPC_CHANNELS,
  type GitConnectionMutationPlanView,
  type GitConnectionsView,
  type GitHubCliSelectionPlanView,
  type GitHubCliStatusView,
} from '../../../shared/git/connections/index.js';
import type { GitHubCliSelectionReview } from '../github-cli/runtime.js';
import {
  GitConnectionsIpcService,
  type GitConnectionsOperations,
  type GitHubCliRuntimeOperations,
} from './ipc.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const REMOTE_PLAN_ID = '20000000-0000-4000-8000-000000000001';
const CLI_PLAN_ID = '30000000-0000-4000-8000-000000000001';
const REVISION = 'a'.repeat(64);
const NOW = '2026-07-17T14:00:00.000Z';
const LOCAL_REPOSITORY_PATH = '/private/forgeboard-e2e/local-backup.git';
const CUSTOM_GH_PATH = '/Applications/Forgeboard Test Tools/fake-gh';
const PROJECT_INPUT = { projectId: PROJECT_ID };
const NETWORK_INPUT = {
  projectId: PROJECT_ID,
  expectedRevision: REVISION,
  operation: 'add' as const,
  remoteName: 'origin',
  url: 'git@github.invalid:forgeboard/example.git',
};
const LOCAL_INPUT = {
  projectId: PROJECT_ID,
  expectedRevision: REVISION,
  operation: 'add' as const,
  remoteName: 'backup',
};

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

describe('GitConnectionsIpcService authority and native routing', () => {
  it('rejects hostile request shapes and every caller outside the live main frame', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandlers();
    const mainFrame = liveEvent();

    await expect(
      handler(GIT_CONNECTIONS_IPC_CHANNELS.list)(mainFrame, {
        ...PROJECT_INPUT,
        projectPath: '/private/renderer-selected/repository',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });

    const subframe = liveEvent();
    Object.defineProperty(subframe, 'senderFrame', { configurable: true, value: {} });
    await expect(
      handler(GIT_CONNECTIONS_IPC_CHANNELS.prepareNetwork)(subframe, NETWORK_INPUT),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });

    const destroyed = liveEvent();
    destroyed.sender.emitDestroyed();
    await expect(
      handler(GIT_CONNECTIONS_IPC_CHANNELS.prepareNetwork)(destroyed, NETWORK_INPUT),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });

    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.prepareNetwork).not.toHaveBeenCalled();
    expect(mainFrame.sender.destroyedListenerCount()).toBe(0);
    expect(subframe.sender.destroyedListenerCount()).toBe(0);
    expect(destroyed.sender.destroyedListenerCount()).toBe(0);
    await fixture.service.dispose();
  });

  it('routes only exact native directory and executable selections to owner-bound operations', async () => {
    const fixture = createFixture();
    fixture.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [LOCAL_REPOSITORY_PATH] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [CUSTOM_GH_PATH] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });
    fixture.service.registerIpcHandlers();
    const event = liveEvent(52);

    const localResult = await handler(GIT_CONNECTIONS_IPC_CHANNELS.prepareLocal)(
      event,
      LOCAL_INPUT,
    );
    const cliResult = await handler(GIT_CONNECTIONS_IPC_CHANNELS.githubCliChoose)(event);

    expect(localResult).toEqual({ ok: true, value: remotePlan('backup', 'local-filesystem') });
    expect(cliResult).toEqual({ ok: true, value: cliPlan() });
    expect(fixture.showOpenDialog).toHaveBeenNthCalledWith(1, fixture.parent, {
      title: 'Choose local Git repository',
      buttonLabel: 'Choose repository',
      properties: ['openDirectory'],
    });
    expect(fixture.showOpenDialog).toHaveBeenNthCalledWith(2, fixture.parent, {
      title: 'Choose GitHub CLI executable',
      buttonLabel: 'Choose GitHub CLI',
      properties: ['openFile'],
    });
    const ownerId = fixture.prepareLocal.mock.calls[0]?.[0];
    expect(ownerId).toMatch(/^git-connections-window:52:/u);
    expect(fixture.prepareLocal).toHaveBeenCalledWith(ownerId, LOCAL_INPUT, LOCAL_REPOSITORY_PATH);
    expect(fixture.prepareCustomSelection).toHaveBeenCalledWith(ownerId, CUSTOM_GH_PATH);
    expect(JSON.stringify([localResult, cliResult])).not.toContain(LOCAL_REPOSITORY_PATH);
    expect(JSON.stringify([localResult, cliResult])).not.toContain(CUSTOM_GH_PATH);

    await expect(
      handler(GIT_CONNECTIONS_IPC_CHANNELS.prepareLocal)(event, LOCAL_INPUT),
    ).resolves.toEqual({ ok: true, value: null });
    await expect(handler(GIT_CONNECTIONS_IPC_CHANNELS.githubCliChoose)(event)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(fixture.prepareLocal).toHaveBeenCalledTimes(1);
    expect(fixture.prepareCustomSelection).toHaveBeenCalledTimes(1);
    await fixture.service.dispose();
  });

  it('rechecks window authority after the native picker before accepting its path', async () => {
    const fixture = createFixture();
    const selection = deferred<OpenDialogReturnValue>();
    fixture.showOpenDialog.mockReturnValueOnce(selection.promise);
    fixture.service.registerIpcHandlers();
    const event = liveEvent();
    const request = handler(GIT_CONNECTIONS_IPC_CHANNELS.githubCliChoose)(event);
    await vi.waitFor(() => expect(fixture.showOpenDialog).toHaveBeenCalledTimes(1));

    Object.defineProperty(event, 'senderFrame', { configurable: true, value: {} });
    selection.resolve({ canceled: false, filePaths: [CUSTOM_GH_PATH] });

    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(fixture.prepareCustomSelection).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('aborts CLI confirmation and discards both owner domains when the sender is destroyed', async () => {
    const fixture = createFixture();
    let confirmationSignal: AbortSignal | undefined;
    fixture.confirmSelection.mockImplementationOnce(
      async (_ownerId, _planId, _authorize, signal) => {
        confirmationSignal = signal;
        if (signal === undefined) throw new Error('Expected sender-bound cancellation.');
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return null;
      },
    );
    fixture.service.registerIpcHandlers();
    const event = liveEvent(73);

    const request = handler(GIT_CONNECTIONS_IPC_CHANNELS.githubCliConfirm)(event, {
      planId: CLI_PLAN_ID,
    });
    await vi.waitFor(() => expect(fixture.confirmSelection).toHaveBeenCalledTimes(1));
    const ownerId = fixture.confirmSelection.mock.calls[0]?.[0];
    expect(confirmationSignal?.aborted).toBe(false);

    event.sender.emitDestroyed();

    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(confirmationSignal?.aborted).toBe(true);
    expect(fixture.discardConnectionOwner).toHaveBeenCalledWith(ownerId);
    expect(fixture.discardCliOwner).toHaveBeenCalledWith(ownerId);
    expect(fixture.onGitHubCliChanged).not.toHaveBeenCalled();
    expect(event.sender.destroyedListenerCount()).toBe(0);
    await fixture.service.dispose();
  });

  it('runs the composed CLI invalidation hook only after approved path-free status', async () => {
    const events: string[] = [];
    const fixture = createFixture({ nativeResponse: 1, admissionEvents: events });
    fixture.confirmSelection.mockImplementationOnce(
      async (_ownerId, _planId, authorize, _signal, _assertCurrent, withAdmission) => {
        if ((await authorize(cliReview())) !== 'approved') return null;
        if (withAdmission === undefined) throw new Error('Expected CLI mutation admission.');
        return await withAdmission(() => {
          events.push('persist-selection');
          return Promise.resolve(cliStatus());
        });
      },
    );
    fixture.service.registerIpcHandlers();
    const event = liveEvent();

    const result = await handler(GIT_CONNECTIONS_IPC_CHANNELS.githubCliConfirm)(event, {
      planId: CLI_PLAN_ID,
    });

    expect(result).toEqual({ ok: true, value: cliStatus() });
    expect(JSON.stringify(result)).not.toContain(CUSTOM_GH_PATH);
    expect(fixture.showMessageBox).toHaveBeenCalledWith(
      fixture.parent,
      expect.objectContaining({
        title: 'Change GitHub CLI configuration?',
        buttons: ['Cancel', 'Use selected GitHub CLI'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(fixture.showMessageBox.mock.calls[0]?.[1].detail).toContain(
      `${CUSTOM_GH_PATH} --version`,
    );
    expect(fixture.onGitHubCliChanged).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'admission:start',
      'persist-selection',
      'invalidate-runtime',
      'admission:finish',
    ]);
    expect(event.sender.destroyedListenerCount()).toBe(1);
    await fixture.service.dispose();
  });

  it('invalidates CLI-bound delivery after persistence even if the sender closes before return', async () => {
    const events: string[] = [];
    const fixture = createFixture({ nativeResponse: 1, admissionEvents: events });
    const event = liveEvent();
    fixture.confirmSelection.mockImplementationOnce(
      async (_ownerId, _planId, authorize, _signal, _assertCurrent, withAdmission) => {
        if ((await authorize(cliReview())) !== 'approved') return null;
        if (withAdmission === undefined) throw new Error('Expected CLI mutation admission.');
        return await withAdmission(() => {
          events.push('persist-selection');
          event.sender.emitDestroyed();
          return Promise.resolve(cliStatus());
        });
      },
    );
    fixture.service.registerIpcHandlers();

    await expect(
      handler(GIT_CONNECTIONS_IPC_CHANNELS.githubCliConfirm)(event, {
        planId: CLI_PLAN_ID,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });

    expect(fixture.onGitHubCliChanged).toHaveBeenCalledOnce();
    expect(events).toEqual([
      'admission:start',
      'persist-selection',
      'invalidate-runtime',
      'admission:finish',
    ]);
    await fixture.service.dispose();
  });
});

describe('GitConnectionsIpcService lifecycle and renderer-safe failures', () => {
  it('pauses and resumes mutation admission while clearing pending selections and owners', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandlers();
    const event = liveEvent();
    await handler(GIT_CONNECTIONS_IPC_CHANNELS.prepareNetwork)(event, NETWORK_INPUT);
    expect(event.sender.destroyedListenerCount()).toBe(1);

    await fixture.service.pauseForDataMutation();

    expect(fixture.pauseConnections).toHaveBeenCalledTimes(1);
    expect(fixture.clearPendingSelections).toHaveBeenCalledTimes(1);
    expect(event.sender.destroyedListenerCount()).toBe(0);
    await expect(handler(GIT_CONNECTIONS_IPC_CHANNELS.list)(event, PROJECT_INPUT)).resolves.toEqual(
      {
        ok: false,
        error: {
          code: 'OPERATION_FAILED',
          message: 'Git connections are paused for a local-data operation.',
        },
      },
    );

    fixture.service.resumeAfterPrivacyReset();
    expect(fixture.resumeConnections).toHaveBeenCalledTimes(1);
    await expect(handler(GIT_CONNECTIONS_IPC_CHANNELS.list)(event, PROJECT_INPUT)).resolves.toEqual(
      {
        ok: true,
        value: connectionsView(),
      },
    );
    await fixture.service.dispose();
  });

  it('privacy reset drains admitted work, fails it closed, clears owners, and remains paused', async () => {
    const fixture = createFixture();
    const pending = deferred<GitConnectionsView>();
    fixture.list.mockImplementationOnce(async () => await pending.promise);
    fixture.service.registerIpcHandlers();
    const event = liveEvent();
    await handler(GIT_CONNECTIONS_IPC_CHANNELS.prepareNetwork)(event, NETWORK_INPUT);
    const request = handler(GIT_CONNECTIONS_IPC_CHANNELS.list)(event, PROJECT_INPUT);
    await vi.waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(1));

    const resetting = fixture.service.resetForPrivacy();
    let resetFinished = false;
    void resetting.then(() => {
      resetFinished = true;
    });
    await Promise.resolve();
    expect(resetFinished).toBe(false);
    expect(fixture.resetConnections).not.toHaveBeenCalled();
    pending.resolve(connectionsView());

    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    await resetting;
    expect(fixture.resetConnections).toHaveBeenCalledTimes(1);
    expect(fixture.resetCli).toHaveBeenCalledTimes(1);
    expect(event.sender.destroyedListenerCount()).toBe(0);
    await expect(handler(GIT_CONNECTIONS_IPC_CHANNELS.list)(event, PROJECT_INPUT)).resolves.toEqual(
      {
        ok: false,
        error: {
          code: 'OPERATION_FAILED',
          message: 'Git connections are paused for a local-data operation.',
        },
      },
    );

    fixture.service.resumeAfterPrivacyReset();
    await expect(handler(GIT_CONNECTIONS_IPC_CHANNELS.list)(event, PROJECT_INPUT)).resolves.toEqual(
      {
        ok: true,
        value: connectionsView(),
      },
    );
    await fixture.service.dispose();
  });

  it.each([
    '/private/forgeboard/repository/.git/config',
    'file:///private/forgeboard/repository/.git/config',
    String.raw`C:\Users\forgeboard\repository\.git\config`,
    String.raw`\\server\forgeboard\repository\.git\config`,
  ])(
    'scrubs main-only picker path %s from renderer errors and audit metadata',
    async (secretPath) => {
      const fixture = createFixture();
      fixture.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [secretPath] });
      fixture.prepareLocal.mockRejectedValueOnce(new Error(`Cannot inspect ${secretPath}`));
      fixture.service.registerIpcHandlers();

      const result = await handler(GIT_CONNECTIONS_IPC_CHANNELS.prepareLocal)(
        liveEvent(),
        LOCAL_INPUT,
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'OPERATION_FAILED',
          message:
            'Git connections could not verify the exact current repository state. Refresh and try again.',
        },
      });
      expect(JSON.stringify(result)).not.toContain(secretPath);
      expect(JSON.stringify(fixture.appendAudit.mock.calls)).not.toContain(secretPath);
      expect(fixture.appendAudit).toHaveBeenLastCalledWith(
        'git-connections',
        'ipc-request',
        'failed',
        { validation: false, errorKind: 'Error' },
      );
      await fixture.service.dispose();
    },
  );
});

function createFixture(
  options: {
    readonly nativeResponse?: number;
    readonly admissionEvents?: string[];
  } = {},
) {
  const parent = { isDestroyed: () => false } as BrowserWindow;
  electronMock.fromWebContents.mockReturnValue(parent);
  const list = vi.fn<GitConnectionsOperations['list']>().mockResolvedValue(connectionsView());
  const prepareNetwork = vi
    .fn<GitConnectionsOperations['prepareNetwork']>()
    .mockResolvedValue(remotePlan('origin', 'network'));
  const prepareLocal = vi
    .fn<GitConnectionsOperations['prepareLocal']>()
    .mockResolvedValue(remotePlan('backup', 'local-filesystem'));
  const prepareRemove = vi.fn<GitConnectionsOperations['prepareRemove']>();
  const confirm = vi.fn<GitConnectionsOperations['confirm']>().mockResolvedValue(null);
  const tryCancelPlan = vi.fn<GitConnectionsOperations['tryCancelPlan']>().mockReturnValue(true);
  const discardConnectionOwner = vi.fn<GitConnectionsOperations['discardOwner']>();
  const pauseConnections = vi.fn<GitConnectionsOperations['pauseForDataMutation']>();
  const resetConnections = vi.fn<GitConnectionsOperations['resetForPrivacy']>();
  const pauseConnectionsForShutdown = vi.fn<GitConnectionsOperations['pauseForShutdown']>();
  const resumeConnections = vi.fn<GitConnectionsOperations['resumeAfterPrivacyReset']>();
  const disposeConnections = vi.fn<GitConnectionsOperations['dispose']>();
  const connections = {
    list,
    prepareNetwork,
    prepareLocal,
    prepareRemove,
    confirm,
    tryCancelPlan,
    discardOwner: discardConnectionOwner,
    pauseForDataMutation: pauseConnections,
    resetForPrivacy: resetConnections,
    pauseForShutdown: pauseConnectionsForShutdown,
    resumeAfterPrivacyReset: resumeConnections,
    dispose: disposeConnections,
  } satisfies GitConnectionsOperations;

  const getPublicStatus = vi
    .fn<GitHubCliRuntimeOperations['getPublicStatus']>()
    .mockResolvedValue(cliStatus());
  const prepareCustomSelection = vi
    .fn<GitHubCliRuntimeOperations['prepareCustomSelection']>()
    .mockResolvedValue(cliPlan());
  const prepareAutomaticSelection = vi
    .fn<GitHubCliRuntimeOperations['prepareAutomaticSelection']>()
    .mockResolvedValue(automaticCliPlan());
  const confirmSelection = vi
    .fn<GitHubCliRuntimeOperations['confirmSelection']>()
    .mockResolvedValue(null);
  const cancelSelection = vi
    .fn<GitHubCliRuntimeOperations['cancelSelection']>()
    .mockReturnValue(false);
  const discardCliOwner = vi.fn<GitHubCliRuntimeOperations['discardOwner']>();
  const clearPendingSelections = vi.fn<GitHubCliRuntimeOperations['clearPendingSelections']>();
  const resetCli = vi.fn<GitHubCliRuntimeOperations['resetForPrivacy']>();
  const githubCli = {
    getPublicStatus,
    prepareCustomSelection,
    prepareAutomaticSelection,
    confirmSelection,
    cancelSelection,
    discardOwner: discardCliOwner,
    clearPendingSelections,
    resetForPrivacy: resetCli,
  } satisfies GitHubCliRuntimeOperations;

  const showOpenDialog = vi
    .fn<
      (parentWindow: BrowserWindow, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>
    >()
    .mockResolvedValue({ canceled: true, filePaths: [] });
  const showMessageBox = vi
    .fn<
      (parentWindow: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
    >()
    .mockResolvedValue({ response: options.nativeResponse ?? 0, checkboxChecked: false });
  const appendAudit = vi.fn();
  const onGitHubCliChanged = vi.fn(() => {
    options.admissionEvents?.push('invalidate-runtime');
    return Promise.resolve();
  });
  const withGitHubCliMutationAdmission = async <Output>(
    operation: () => Promise<Output>,
  ): Promise<Output> => {
    options.admissionEvents?.push('admission:start');
    try {
      return await operation();
    } finally {
      options.admissionEvents?.push('admission:finish');
    }
  };
  const service = new GitConnectionsIpcService(
    { showOpenDialog, showMessageBox } as unknown as Pick<
      Dialog,
      'showOpenDialog' | 'showMessageBox'
    >,
    connections,
    githubCli,
    { appendAudit },
    async (operation) => await operation(),
    onGitHubCliChanged,
    undefined,
    withGitHubCliMutationAdmission,
  );
  return {
    service,
    parent,
    list,
    prepareNetwork,
    prepareLocal,
    confirmSelection,
    prepareCustomSelection,
    discardConnectionOwner,
    discardCliOwner,
    pauseConnections,
    resetConnections,
    resetCli,
    resumeConnections,
    clearPendingSelections,
    showOpenDialog,
    showMessageBox,
    onGitHubCliChanged,
    withGitHubCliMutationAdmission,
    appendAudit,
  };
}

function connectionsView(): GitConnectionsView {
  return {
    projectId: PROJECT_ID,
    projectName: 'Example repository',
    configurationRevision: REVISION,
    remotes: [],
    capturedAt: NOW,
  };
}

function remotePlan(
  remoteName: string,
  kind: 'network' | 'local-filesystem',
): GitConnectionMutationPlanView {
  return {
    kind: 'git-remote-mutation',
    planId: REMOTE_PLAN_ID,
    expiresAt: '2026-07-17T14:05:00.000Z',
    projectId: PROJECT_ID,
    projectName: 'Example repository',
    sourceRevision: REVISION,
    operation: 'add',
    remoteName,
    before: null,
    after:
      kind === 'local-filesystem'
        ? {
            kind,
            name: remoteName,
            endpoint: 'local-filesystem',
            resource: 'Local Git repository',
            transport: 'local',
            githubCompatible: false,
          }
        : {
            kind,
            name: remoteName,
            endpoint: 'github.invalid',
            resource: 'forgeboard/example',
            transport: 'ssh',
            githubCompatible: false,
          },
    remoteTrackingRefs: [],
    networkAccess: false,
  };
}

function cliPlan(): GitHubCliSelectionPlanView {
  return {
    kind: 'github-cli-selection',
    planId: CLI_PLAN_ID,
    expiresAt: '2026-07-17T14:05:00.000Z',
    source: 'custom',
    candidate: {
      source: 'custom',
      filename: 'fake-gh',
      sizeBytes: 42,
      sha256: 'b'.repeat(64),
      version: null,
    },
    networkAccess: false,
  };
}

function automaticCliPlan(): GitHubCliSelectionPlanView {
  return {
    kind: 'github-cli-selection',
    planId: CLI_PLAN_ID,
    expiresAt: '2026-07-17T14:05:00.000Z',
    source: 'automatic',
    candidate: null,
    networkAccess: false,
  };
}

function cliStatus(): GitHubCliStatusView {
  return {
    source: 'custom',
    state: 'ready',
    identity: {
      source: 'custom',
      filename: 'fake-gh',
      sizeBytes: 42,
      sha256: 'b'.repeat(64),
      version: '2.76.1',
    },
    verifiedAt: NOW,
    checkedAt: NOW,
  };
}

function cliReview(): GitHubCliSelectionReview {
  return {
    ...cliPlan(),
    executablePath: CUSTOM_GH_PATH,
    versionArguments: ['--version'],
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
