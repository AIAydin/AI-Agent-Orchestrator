import type {
  BrowserWindow,
  Dialog,
  IpcMainInvokeEvent,
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogReturnValue,
  WebContents,
} from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...arguments_: unknown[]) => Promise<unknown>;
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
  TERMINAL_IPC_CHANNELS,
  type TerminalLaunchPlanView,
  type TerminalReplayView,
  type TerminalSessionView,
} from '../../shared/terminal/index.js';
import { TerminalIpcService } from './ipc.js';
import type {
  TerminalLaunchAuthorizer,
  TerminalLaunchNativeReview,
  TerminalService,
} from './service.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const PLAN_ID = '20000000-0000-4000-8000-000000000001';
const SESSION_ID = '30000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T14:00:00.000Z';
const roleDeniedMessage =
  'This collaboration role cannot launch, type into, or reconfigure a local terminal.';

type CollaborationRole = 'owner' | 'editor' | 'reviewer' | 'viewer';

const chooseInput = { projectId: PROJECT_ID, nodeId: 'terminal-node' };
const prepareInput = {
  ...chooseInput,
  executable: process.execPath,
  arguments: ['--version'],
  cwdRelative: '.',
  environmentVariableNames: ['PATH'],
  columns: 120,
  rows: 30,
};
const targetInput = { sessionId: SESSION_ID };
const input = { ...targetInput, data: 'status\n' };
const resizeInput = { ...targetInput, columns: 132, rows: 42 };

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

describe('TerminalIpcService collaboration authority routing', () => {
  it.each(['reviewer', 'viewer'] satisfies CollaborationRole[])(
    'denies picker, prepare, confirm, input, and resize mutations to a %s',
    async (role) => {
      const fixture = createFixture(role);
      const event = liveEvent();

      for (const [channel, request] of [
        [TERMINAL_IPC_CHANNELS.chooseExecutable, chooseInput],
        [TERMINAL_IPC_CHANNELS.prepareLaunch, prepareInput],
        [TERMINAL_IPC_CHANNELS.confirmLaunch, { planId: PLAN_ID }],
        [TERMINAL_IPC_CHANNELS.sendInput, input],
        [TERMINAL_IPC_CHANNELS.resize, resizeInput],
      ] as const) {
        await expect(handler(channel)(event, request)).resolves.toMatchObject({
          ok: false,
          error: { code: 'OPERATION_FAILED', message: roleDeniedMessage },
        });
      }

      expect(fixture.showOpenDialog).not.toHaveBeenCalled();
      expect(fixture.showMessageBox).not.toHaveBeenCalled();
      expect(fixture.operations.assertProjectAvailable).not.toHaveBeenCalled();
      expect(fixture.operations.prepareLaunch).not.toHaveBeenCalled();
      expect(fixture.operations.confirmLaunch).not.toHaveBeenCalled();
      expect(fixture.operations.sendInput).not.toHaveBeenCalled();
      expect(fixture.operations.resize).not.toHaveBeenCalled();
      await fixture.ipc.dispose();
    },
  );

  it.each(['owner', 'editor'] satisfies CollaborationRole[])(
    'admits picker, prepare, confirm, input, and resize mutations for an authorized %s',
    async (role) => {
      const fixture = createFixture(role);
      const event = liveEvent(42);

      await expect(
        handler(TERMINAL_IPC_CHANNELS.chooseExecutable)(event, chooseInput),
      ).resolves.toMatchObject({
        ok: true,
        value: { executable: process.execPath },
      });
      await expect(
        handler(TERMINAL_IPC_CHANNELS.prepareLaunch)(event, prepareInput),
      ).resolves.toEqual({ ok: true, value: launchPlan });
      await expect(
        handler(TERMINAL_IPC_CHANNELS.confirmLaunch)(event, { planId: PLAN_ID }),
      ).resolves.toEqual({ ok: true, value: session });
      await expect(handler(TERMINAL_IPC_CHANNELS.sendInput)(event, input)).resolves.toEqual({
        ok: true,
        value: session,
      });
      await expect(handler(TERMINAL_IPC_CHANNELS.resize)(event, resizeInput)).resolves.toEqual({
        ok: true,
        value: session,
      });

      expect(fixture.showOpenDialog).toHaveBeenCalledTimes(1);
      expect(fixture.showMessageBox).toHaveBeenCalledWith(
        fixture.parent,
        expect.objectContaining({
          buttons: ['Cancel', 'Launch terminal'],
          defaultId: 0,
          cancelId: 0,
        }),
      );
      const ownerId = fixture.operations.prepareLaunch.mock.calls[0]?.[0];
      expect(ownerId).toMatch(/^terminal:web-contents:42:/u);
      expect(fixture.operations.confirmLaunch).toHaveBeenCalledWith(
        ownerId,
        PLAN_ID,
        expect.any(Function),
        expect.any(Function),
      );
      expect(fixture.operations.sendInput).toHaveBeenCalledWith(ownerId, input);
      expect(fixture.operations.resize).toHaveBeenCalledWith(ownerId, resizeInput);
      await fixture.ipc.dispose();
    },
  );

  it.each(['reviewer', 'viewer'] satisfies CollaborationRole[])(
    'admits read-only session get, list, and replay for a %s without mutation authority',
    async (role) => {
      const fixture = createFixture(role);
      const event = liveEvent();

      await expect(handler(TERMINAL_IPC_CHANNELS.getSession)(event, targetInput)).resolves.toEqual({
        ok: true,
        value: session,
      });
      await expect(
        handler(TERMINAL_IPC_CHANNELS.listSessions)(event, { projectId: PROJECT_ID }),
      ).resolves.toEqual({ ok: true, value: [session] });
      await expect(handler(TERMINAL_IPC_CHANNELS.replay)(event, targetInput)).resolves.toEqual({
        ok: true,
        value: replay,
      });

      expect(fixture.authorizeMutation).not.toHaveBeenCalled();
      expect(fixture.operations.getSession).toHaveBeenCalledWith(
        expect.stringMatching(/^terminal:web-contents:\d+:/u),
        targetInput,
      );
      expect(fixture.operations.listSessions).toHaveBeenCalledWith(
        expect.stringMatching(/^terminal:web-contents:\d+:/u),
        {
          projectId: PROJECT_ID,
        },
      );
      expect(fixture.operations.replay).toHaveBeenCalledWith(
        expect.stringMatching(/^terminal:web-contents:\d+:/u),
        targetInput,
      );
      await fixture.ipc.dispose();
    },
  );

  it.each(['reviewer', 'viewer'] satisfies CollaborationRole[])(
    'keeps owner-bound interrupt and terminate safety controls available to a %s',
    async (role) => {
      const fixture = createFixture(role);
      const event = liveEvent();

      await expect(handler(TERMINAL_IPC_CHANNELS.interrupt)(event, targetInput)).resolves.toEqual({
        ok: true,
        value: session,
      });
      await expect(handler(TERMINAL_IPC_CHANNELS.terminate)(event, targetInput)).resolves.toEqual({
        ok: true,
        value: session,
      });

      expect(fixture.authorizeMutation).not.toHaveBeenCalled();
      const interruptOwner = fixture.operations.interrupt.mock.calls[0]?.[0];
      const terminateOwner = fixture.operations.terminate.mock.calls[0]?.[0];
      expect(interruptOwner).toEqual(terminateOwner);
      expect(interruptOwner).toEqual(expect.stringMatching(/^terminal:web-contents:\d+:/u));
      expect(fixture.operations.interrupt).toHaveBeenCalledWith(interruptOwner, targetInput);
      expect(fixture.operations.terminate).toHaveBeenCalledWith(terminateOwner, targetInput);
      await fixture.ipc.dispose();
    },
  );

  it('fails closed when an editor is downgraded during native confirmation', async () => {
    const confirmation = deferred<MessageBoxReturnValue>();
    const fixture = createFixture('editor', { confirmation: confirmation.promise });
    const event = liveEvent();
    const request = handler(TERMINAL_IPC_CHANNELS.confirmLaunch)(event, { planId: PLAN_ID });
    await vi.waitFor(() => expect(fixture.showMessageBox).toHaveBeenCalledTimes(1));

    fixture.setRole('viewer');
    confirmation.resolve({ response: 1, checkboxChecked: false });

    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: roleDeniedMessage },
    });
    expect(fixture.operations.confirmLaunch).toHaveBeenCalledTimes(1);
    await fixture.ipc.dispose();
  });

  it('fails closed when an approved editor is downgraded at the final pre-spawn check', async () => {
    const beforeSpawn = deferred<void>();
    const fixture = createFixture('editor', { beforeSpawn: beforeSpawn.promise });
    const event = liveEvent();
    const request = handler(TERMINAL_IPC_CHANNELS.confirmLaunch)(event, { planId: PLAN_ID });
    await vi.waitFor(() => expect(fixture.showMessageBox).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(fixture.operations.confirmLaunch).toHaveBeenCalledTimes(1));

    fixture.setRole('reviewer');
    beforeSpawn.resolve();

    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: roleDeniedMessage },
    });
    await fixture.ipc.dispose();
  });
});

function createFixture(
  initialRole: CollaborationRole,
  options: { confirmation?: Promise<MessageBoxReturnValue>; beforeSpawn?: Promise<void> } = {},
) {
  let role = initialRole;
  const parent = liveParent();
  electronMock.fromWebContents.mockReturnValue(parent);
  const authorizeMutation = vi.fn(() => {
    if (role === 'reviewer' || role === 'viewer') throw new Error(roleDeniedMessage);
  });
  const showOpenDialog = vi
    .fn<() => Promise<OpenDialogReturnValue>>()
    .mockResolvedValue({ canceled: false, filePaths: [process.execPath] });
  const showMessageBox = vi
    .fn<(parent: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>()
    .mockImplementation(
      async () =>
        await (options.confirmation ?? Promise.resolve({ response: 1, checkboxChecked: false })),
    );
  const operations = createOperations(options.beforeSpawn);
  const ipc = new TerminalIpcService(
    { showOpenDialog, showMessageBox } as unknown as Pick<
      Dialog,
      'showOpenDialog' | 'showMessageBox'
    >,
    operations as unknown as TerminalService,
    () => parent,
    authorizeMutation,
  );
  ipc.registerIpcHandlers();
  return {
    ipc,
    operations,
    parent,
    authorizeMutation,
    showOpenDialog,
    showMessageBox,
    setRole(nextRole: CollaborationRole) {
      role = nextRole;
    },
  };
}

function createOperations(beforeSpawn?: Promise<void>) {
  return {
    subscribe: vi.fn(() => () => undefined),
    assertProjectAvailable: vi.fn().mockResolvedValue(undefined),
    prepareLaunch: vi
      .fn<(ownerId: string, input: typeof prepareInput) => Promise<TerminalLaunchPlanView>>()
      .mockResolvedValue(launchPlan),
    cancelLaunch: vi.fn().mockResolvedValue({ planId: PLAN_ID, cancelled: true }),
    confirmLaunch: vi.fn(
      async (
        _ownerId: string,
        _planId: string,
        authorize: TerminalLaunchAuthorizer,
        assertAuthority: () => void,
      ) => {
        assertAuthority();
        const decision = await authorize(nativeReview);
        if (decision !== 'approved') return null;
        if (beforeSpawn !== undefined) await beforeSpawn;
        assertAuthority();
        return session;
      },
    ),
    getSession: vi.fn().mockResolvedValue(session),
    listSessions: vi.fn().mockResolvedValue([session]),
    replay: vi.fn().mockResolvedValue(replay),
    sendInput: vi.fn().mockResolvedValue(session),
    resize: vi.fn().mockResolvedValue(session),
    interrupt: vi
      .fn<(ownerId: string, input: typeof targetInput) => Promise<TerminalSessionView>>()
      .mockResolvedValue(session),
    terminate: vi
      .fn<(ownerId: string, input: typeof targetInput) => Promise<TerminalSessionView>>()
      .mockResolvedValue(session),
    discardOwner: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

const permission = {
  label: 'Local terminal',
  sandboxed: false,
  filesystem: 'operating-system-user',
  network: 'operating-system-user',
  detail: 'Runs as the local operating-system user.',
} as const;

const launchPlan: TerminalLaunchPlanView = {
  kind: 'terminal-launch',
  planId: PLAN_ID,
  projectId: PROJECT_ID,
  projectName: 'IPC security fixture',
  nodeId: 'terminal-node',
  executable: process.execPath,
  arguments: ['--version'],
  cwdRelative: '.',
  environmentVariableNames: ['PATH'],
  columns: 120,
  rows: 30,
  permission,
  expiresAt: '2026-07-17T14:05:00.000Z',
};

const session: TerminalSessionView = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  nodeId: 'terminal-node',
  executable: process.execPath,
  arguments: ['--version'],
  cwdRelative: '.',
  environmentVariableNames: ['PATH'],
  columns: 120,
  rows: 30,
  permission,
  status: 'running',
  startedAt: NOW,
  endedAt: null,
  exitCode: null,
  exitSignal: null,
  earliestSequence: 1,
  nextSequence: 2,
  outputTruncated: false,
  updatedAt: NOW,
};

const replay: TerminalReplayView = {
  session,
  chunks: [{ sequence: 1, data: 'ready\n', occurredAt: NOW }],
  nextAfterSequence: 1,
  hasMore: false,
};

const nativeReview: TerminalLaunchNativeReview = {
  view: launchPlan,
  exact: {
    executable: process.execPath,
    arguments: ['--version'],
    cwd: process.cwd(),
    environmentVariableNames: ['PATH'],
  },
};

function liveEvent(id = 7): IpcMainInvokeEvent {
  const frame = {};
  const sender = {
    id,
    mainFrame: frame,
    isDestroyed: () => false,
    once: vi.fn(),
    send: vi.fn(),
  } as unknown as WebContents;
  return { sender, senderFrame: frame } as IpcMainInvokeEvent;
}

function liveParent(): BrowserWindow {
  return { isDestroyed: () => false } as BrowserWindow;
}

function handler(channel: string) {
  const registered = electronMock.handlers.get(channel);
  if (registered === undefined) throw new Error(`Missing IPC handler: ${channel}`);
  return registered;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
