import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  MessageBoxOptions,
  MessageBoxReturnValue,
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
  shell: { openExternal: vi.fn() },
}));

import {
  IPC_CHANNELS,
  type IpcResult,
  type PreviewSessionSnapshot,
  type PreviewStartInput,
} from '../../shared/application/contracts.js';
import { PreviewIpcService, type PreviewOperations } from './preview-ipc.js';
import type { PreviewLaunchPlan } from './preview-runtime.js';
import type { LocalStore } from '../storage.js';
import { PREVIEW_TARGET_IPC_CHANNELS } from '../../shared/preview/targets.js';

const input: PreviewStartInput = {
  projectId: '123fae6e-e213-4a10-a0db-0f85b791f7e9',
  nodeId: 'preview-node',
  cwdRelative: '.',
  readinessPath: '/',
  urlPath: '/',
  packageScript: 'dev',
};

const snapshot: PreviewSessionSnapshot = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'ready',
  startedAt: '2026-07-15T12:00:00.000Z',
  readyAt: '2026-07-15T12:00:01.000Z',
  stoppedAt: null,
  failure: null,
  trustedHosts: ['127.0.0.1'],
  processes: [],
};

const plan: PreviewLaunchPlan = {
  input,
  source: 'package-script',
  executable: '/canonical/bin/pnpm',
  arguments: ['run', 'dev'],
  cwd: '/repo',
  projectRoot: '/repo',
  executableIdentity: {
    path: '/canonical/bin/pnpm',
    executable: true,
    device: 1,
    inode: 2,
    size: 3,
    modifiedAtMs: 4,
    changedAtMs: 5,
    mode: 0o755,
    digest: 'a'.repeat(64),
  },
  indirectExecutableIdentity: null,
  projectIdentity: { path: '/repo', device: 10, inode: 20 },
  cwdIdentity: { path: '/repo', device: 10, inode: 20 },
  packageScript: {
    name: 'dev',
    declaration: 'vite --host 127.0.0.1',
    packageJsonIdentity: {
      path: '/repo/package.json',
      executable: false,
      device: 10,
      inode: 21,
      size: 100,
      modifiedAtMs: 4,
      changedAtMs: 5,
      mode: 0o644,
      digest: 'b'.repeat(64),
    },
  },
  portRange: { start: 41_000, end: 41_999 },
  trustedHosts: ['127.0.0.1', 'localhost'],
  fingerprint: 'c'.repeat(64),
};

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

describe('PreviewIpcService launch authority', () => {
  it('lists renderer-safe targets through a strict passive request', async () => {
    const fixture = createFixture();
    fixture.runtime.listTargets.mockResolvedValueOnce([
      {
        target: { kind: 'primary' },
        label: 'Primary checkout',
        badge: 'Primary checkout',
        available: true,
      },
    ]);
    await expect(
      requiredHandler(PREVIEW_TARGET_IPC_CHANNELS.list)(liveEvent(), {
        projectId: input.projectId,
      }),
    ).resolves.toMatchObject({ ok: true, value: [{ target: { kind: 'primary' } }] });
    await expect(
      requiredHandler(PREVIEW_TARGET_IPC_CHANNELS.list)(liveEvent(), {
        projectId: input.projectId,
        path: '/private/repository',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(fixture.runtime.listTargets).toHaveBeenCalledTimes(1);
    await fixture.service.dispose();
  });

  it('rejects invalid renderer input and subframes before passive preparation', async () => {
    const fixture = createFixture();
    const parent = liveParent();
    electronMock.fromWebContents.mockReturnValue(parent);

    await expect(
      requiredHandler(IPC_CHANNELS.previewsStart)(liveEvent(), { ...input, unexpected: true }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(fixture.runtime.prepare).not.toHaveBeenCalled();

    const subframe = liveEvent();
    Object.defineProperty(subframe, 'senderFrame', { value: {} });
    await expect(
      requiredHandler(IPC_CHANNELS.previewsStart)(subframe, input),
    ).resolves.toMatchObject({ ok: false });
    expect(fixture.runtime.prepare).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('preserves an opaque comparison slot and agent target through direct IPC launch', async () => {
    const parent = liveParent();
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 1 });
    const comparisonInput: PreviewStartInput = {
      ...input,
      slot: 'comparison-left',
      target: {
        kind: 'agent-run',
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    };
    fixture.runtime.prepare.mockResolvedValueOnce({ ...plan, input: comparisonInput });

    await expect(
      requiredHandler(IPC_CHANNELS.previewsStart)(liveEvent(), comparisonInput),
    ).resolves.toMatchObject({ ok: true });
    expect(fixture.runtime.prepare).toHaveBeenCalledWith(comparisonInput);
    expect(fixture.runtime.startPrepared).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ input: comparisonInput }),
      expect.any(Object),
    );
    await fixture.service.dispose();
  });

  it('uses a cancel-default native disclosure and starts no process when cancelled', async () => {
    const parent = liveParent();
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 0 });

    await expect(requiredHandler(IPC_CHANNELS.previewsStart)(liveEvent(), input)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(fixture.runtime.startPrepared).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({
        buttons: ['Cancel', 'Start preview'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(fixture.showMessageBox.mock.calls[0]?.[1].detail).toContain(
      `Package manifest SHA-256: ${'b'.repeat(64)}`,
    );
    expect(fixture.showMessageBox.mock.calls[0]?.[1]?.detail).toContain(
      'Script declaration: vite --host 127.0.0.1',
    );
    await fixture.service.dispose();
  });

  it('authorizes the exact live owner at the final process-launch callback', async () => {
    const parent = liveParent();
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 1 });
    fixture.runtime.startPrepared.mockImplementation((_ownerId, approved, authorization) => {
      authorization.authorizeSpawn({
        executable: approved.executable,
        arguments: approved.arguments,
        cwd: approved.cwd,
        port: 41_001,
      });
      return Promise.resolve(snapshot);
    });

    await expect(requiredHandler(IPC_CHANNELS.previewsStart)(liveEvent(), input)).resolves.toEqual({
      ok: true,
      value: snapshot,
    });
    expect(fixture.runtime.startPrepared).toHaveBeenCalledTimes(1);
    await fixture.service.dispose();
  });

  it('rejects an approval that expires while passive launch revalidation is still running', async () => {
    const parent = liveParent();
    electronMock.fromWebContents.mockReturnValue(parent);
    let clockMs = Date.parse('2026-07-15T12:00:00.000Z');
    const fixture = createFixture({
      nativeResponse: 1,
      now: () => new Date(clockMs),
    });
    fixture.runtime.startPrepared.mockImplementation((_ownerId, approved, authorization) => {
      clockMs += 6 * 60_000;
      authorization.authorizeSpawn({
        executable: approved.executable,
        arguments: approved.arguments,
        cwd: approved.cwd,
        port: 41_001,
      });
      return Promise.resolve(snapshot);
    });

    const result = (await requiredHandler(IPC_CHANNELS.previewsStart)(
      liveEvent(),
      input,
    )) as IpcResult<unknown>;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected the expired preview approval to be rejected.');
    expect(result.error.message).toContain('approval expired');
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'preview',
      'start',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-expired-before-launch' }),
    );
    await fixture.service.dispose();
  });

  it('rejects a replaced parent window after confirmation and before launch', async () => {
    const parent = liveParent();
    const replacement = liveParent();
    electronMock.fromWebContents.mockReturnValueOnce(parent).mockReturnValue(replacement);
    const fixture = createFixture({ nativeResponse: 1 });

    const result = (await requiredHandler(IPC_CHANNELS.previewsStart)(
      liveEvent(),
      input,
    )) as IpcResult<unknown>;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected the replaced preview owner to be rejected.');
    expect(result.error.message).toContain('window changed');
    expect(fixture.runtime.startPrepared).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('cancels Restart without stopping or replacing the existing preview', async () => {
    electronMock.fromWebContents.mockReturnValue(liveParent());
    const fixture = createFixture({ nativeResponse: 0 });

    await expect(
      requiredHandler(IPC_CHANNELS.previewsRestart)(liveEvent(), input),
    ).resolves.toEqual({ ok: true, value: null });
    expect(fixture.runtime.restartPrepared).not.toHaveBeenCalled();
    expect(fixture.runtime.stop).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('requires current owner authority before an approved Restart can stop the old preview', async () => {
    const parent = liveParent();
    electronMock.fromWebContents.mockReturnValue(parent);
    const fixture = createFixture({ nativeResponse: 1 });
    fixture.runtime.restartPrepared.mockImplementation((_ownerId, _approved, authorization) => {
      authorization.authorizeReplacement?.();
      return Promise.resolve(snapshot);
    });

    await expect(
      requiredHandler(IPC_CHANNELS.previewsRestart)(liveEvent(), input),
    ).resolves.toEqual({ ok: true, value: snapshot });
    expect(fixture.runtime.restartPrepared).toHaveBeenCalledTimes(1);
    await fixture.service.dispose();
  });

  it('registers no native preview-surface channels after the webview migration', () => {
    const fixture = createFixture();
    const surfaceChannels = [...electronMock.handlers.keys()].filter((channel) =>
      channel.startsWith('preview-surface:'),
    );
    expect(surfaceChannels).toEqual([]);
    return fixture.service.dispose();
  });
});

function createFixture(options: { nativeResponse?: number; now?: () => Date } = {}) {
  const runtime = createRuntime();
  const showMessageBox = vi
    .fn<(parent: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>()
    .mockResolvedValue({
      response: options.nativeResponse ?? 0,
      checkboxChecked: false,
    });
  const appendAudit = vi.fn();
  const service = new PreviewIpcService(
    { showMessageBox },
    { appendAudit } as unknown as LocalStore,
    () => ({}) as never,
    () => runtime,
    options.now ?? (() => new Date('2026-07-15T12:00:00.000Z')),
  );
  service.registerIpcHandlers();
  return { service, runtime, showMessageBox, appendAudit };
}

function createRuntime() {
  return {
    listTargets: vi.fn<PreviewOperations['listTargets']>().mockResolvedValue([]),
    prepare: vi.fn<PreviewOperations['prepare']>().mockResolvedValue(plan),
    startPrepared: vi.fn<PreviewOperations['startPrepared']>().mockResolvedValue(snapshot),
    restartPrepared: vi.fn<PreviewOperations['restartPrepared']>().mockResolvedValue(snapshot),
    stop: vi.fn<PreviewOperations['stop']>().mockResolvedValue(null),
    get: vi.fn<PreviewOperations['get']>().mockReturnValue(null),
    validateNavigation: vi
      .fn<PreviewOperations['validateNavigation']>()
      .mockReturnValue('http://127.0.0.1:41000/'),
    isAllowedFrameNavigation: vi
      .fn<PreviewOperations['isAllowedFrameNavigation']>()
      .mockReturnValue(false),
    resetForPrivacy: vi.fn<PreviewOperations['resetForPrivacy']>().mockResolvedValue(undefined),
    pauseForDataMutation: vi.fn<PreviewOperations['pauseForDataMutation']>(),
    resumeAfterPrivacyReset: vi.fn<PreviewOperations['resumeAfterPrivacyReset']>(),
    stopOwner: vi.fn<PreviewOperations['stopOwner']>().mockResolvedValue(undefined),
    dispose: vi.fn<PreviewOperations['dispose']>().mockResolvedValue(undefined),
  } satisfies PreviewOperations;
}

function liveEvent(): IpcMainInvokeEvent {
  const frame = {};
  const sender = {
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

function requiredHandler(channel: string) {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler;
}
