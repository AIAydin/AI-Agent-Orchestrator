import type {
  BrowserWindow,
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
  ipcMain: { handle: electronMock.handle, removeHandler: electronMock.removeHandler },
}));

import { IPC_CHANNELS } from '../../shared/application/contracts.js';
import type { DockerReadiness } from '../../shared/docker/contracts.js';
import { DockerIpcService, type DockerOperations } from './docker-ipc.js';
import type { ReadinessExecutableIdentity } from '../readiness/executable-identity.js';

const input = {
  dockerExecutable: '/selected/bin/docker',
  image: 'registry.example/agent:1',
  containerExecutable: '/usr/local/bin/codex',
};
const canonicalInput = { ...input, dockerExecutable: '/canonical/bin/docker' };
const identity: ReadinessExecutableIdentity = {
  device: 1,
  inode: 2,
  size: 3,
  modifiedAtMs: 4,
  sha256: 'a'.repeat(64),
};
const ready: DockerReadiness = {
  executable: canonicalInput.dockerExecutable,
  image: input.image,
  containerExecutable: input.containerExecutable,
  executableAvailable: true,
  daemonAvailable: true,
  imageAvailable: true,
  imageCompatible: true,
  containerExecutableAvailable: true,
  available: true,
  status: 'ready',
  checkedAt: '2026-07-14T16:00:00.000Z',
  daemonVersion: '27.5.1',
  imageId: 'sha256:abc123',
  agentVersion: 'codex 1.2.3',
};

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

describe('DockerIpcService', () => {
  it('rejects hostile renderer input before passive resolution or a process', async () => {
    const operations = createOperations();
    const fixture = createFixture({ operations });

    const result = await requiredHandler(IPC_CHANNELS.dockerCheck)(liveEvent(), {
      ...input,
      image: 'safe;touch /tmp/escaped',
      unexpected: true,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(operations.resolve).not.toHaveBeenCalled();
    expect(operations.check).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('returns passive missing-executable evidence without opening a native dialog', async () => {
    const operations = createOperations();
    operations.resolve.mockRejectedValueOnce(new Error('Docker executable is missing.'));
    const fixture = createFixture({ operations });

    await expect(
      requiredHandler(IPC_CHANNELS.dockerCheck)(liveEvent(), input),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: 'executable-unavailable', available: false },
    });
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    expect(operations.check).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('keeps readiness cancellation honest and starts no Docker subprocess', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const operations = createOperations();
    const fixture = createFixture({ operations, nativeResponse: 0 });

    await expect(requiredHandler(IPC_CHANNELS.dockerCheck)(liveEvent(), input)).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(operations.check).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({
        buttons: ['Cancel', 'Run Docker checks'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(fixture.showMessageBox.mock.calls[0]?.[1].detail).toContain(
      `Executable fingerprint (SHA-256): ${identity.sha256}`,
    );
    await fixture.service.dispose();
  });

  it('revalidates owner and executable immediately before an approved readiness command', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const operations = createOperations();
    const fixture = createFixture({ operations, nativeResponse: 1 });

    await expect(requiredHandler(IPC_CHANNELS.dockerCheck)(liveEvent(), input)).resolves.toEqual({
      ok: true,
      value: ready,
    });
    expect(operations.check.mock.calls[0]?.[0]).toEqual(canonicalInput);
    expect(typeof operations.check.mock.calls[0]?.[1].beforeCommand).toBe('function');
    expect(operations.check.mock.calls[0]?.[1].probeContainerName).toMatch(
      /^forgeboard-readiness-/u,
    );
    expect(operations.identify.mock.calls.length).toBeGreaterThanOrEqual(2);
    await fixture.service.dispose();
  });

  it('puts pull preflight, registry access, and postflight behind native approval', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const missing: DockerReadiness = {
      ...ready,
      imageAvailable: false,
      imageCompatible: false,
      containerExecutableAvailable: false,
      available: false,
      status: 'image-missing',
      reason: 'Image is not available locally.',
    };
    const operations = createOperations();
    operations.check.mockResolvedValueOnce(missing).mockResolvedValueOnce(ready);
    const fixture = createFixture({ operations, nativeResponse: 1 });

    await expect(requiredHandler(IPC_CHANNELS.dockerPull)(liveEvent(), input)).resolves.toEqual({
      ok: true,
      value: { outcome: 'pulled', readiness: ready },
    });
    expect(operations.check).toHaveBeenCalledTimes(2);
    expect(operations.pull).toHaveBeenCalledTimes(1);
    expect(fixture.showMessageBox).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({
        buttons: ['Cancel', 'Pull image'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(fixture.showMessageBox.mock.calls[0]?.[1].detail).toContain('Docker server check');
    await fixture.service.dispose();
  });

  it('cancels a pull with null readiness and zero Docker commands', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const operations = createOperations();
    const fixture = createFixture({ operations, nativeResponse: 0 });

    await expect(requiredHandler(IPC_CHANNELS.dockerPull)(liveEvent(), input)).resolves.toEqual({
      ok: true,
      value: { outcome: 'cancelled', readiness: null },
    });
    expect(operations.check).not.toHaveBeenCalled();
    expect(operations.pull).not.toHaveBeenCalled();
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'external-send',
      'docker-image-pull',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-cancelled' }),
    );
    await fixture.service.dispose();
  });

  it('lets executable drift after approval win before the first Docker command', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const operations = createOperations();
    operations.identify
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce({ ...identity, sha256: 'b'.repeat(64) });
    let processStarted = false;
    operations.check.mockImplementationOnce(async (_configuration, authorization) => {
      await authorization.beforeCommand();
      processStarted = true;
      return ready;
    });
    const fixture = createFixture({ operations, nativeResponse: 1 });

    await expect(
      requiredHandler(IPC_CHANNELS.dockerPull)(liveEvent(), input),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(processStarted).toBe(false);
    expect(operations.pull).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('rejects subframes and replaced parent windows before any Docker command', async () => {
    const operations = createOperations();
    const fixture = createFixture({ operations, nativeResponse: 1 });
    const subframe = liveEvent();
    Object.defineProperty(subframe, 'senderFrame', { value: {} });

    await expect(requiredHandler(IPC_CHANNELS.dockerCheck)(subframe, input)).resolves.toMatchObject(
      {
        ok: false,
      },
    );
    expect(operations.resolve).not.toHaveBeenCalled();

    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents
      .mockReturnValueOnce(parent)
      .mockReturnValue({ isDestroyed: () => false });
    await expect(
      requiredHandler(IPC_CHANNELS.dockerCheck)(liveEvent(), input),
    ).resolves.toMatchObject({
      ok: false,
    });
    expect(operations.check).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('acquires the pull single-flight guard before passive resolution completes', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const resolution = deferred<string>();
    const operations = createOperations();
    operations.resolve.mockImplementationOnce(() => resolution.promise);
    const fixture = createFixture({ operations, nativeResponse: 0 });
    const handler = requiredHandler(IPC_CHANNELS.dockerPull);

    const first = handler(liveEvent(), input);
    await vi.waitFor(() => expect(operations.resolve).toHaveBeenCalledTimes(1));
    await expect(handler(liveEvent(), input)).resolves.toMatchObject({
      ok: false,
      error: { message: 'A Docker image pull is already in progress.' },
    });
    resolution.resolve(canonicalInput.dockerExecutable);
    await expect(first).resolves.toEqual({
      ok: true,
      value: { outcome: 'cancelled', readiness: null },
    });
    expect(operations.check).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('removes handlers and drains an admitted readiness request during disposal', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const check = deferred<DockerReadiness>();
    const operations = createOperations();
    operations.check.mockImplementationOnce(async (_configuration, authorization) => {
      await authorization.beforeCommand();
      return await check.promise;
    });
    const fixture = createFixture({ operations, nativeResponse: 1 });
    const request = requiredHandler(IPC_CHANNELS.dockerCheck)(liveEvent(), input);
    await vi.waitFor(() => expect(operations.check).toHaveBeenCalledTimes(1));

    const disposal = fixture.service.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(electronMock.handlers.has(IPC_CHANNELS.dockerCheck)).toBe(false);
    check.resolve(ready);

    await expect(request).resolves.toEqual({ ok: true, value: ready });
    await disposal;
    expect(disposed).toBe(true);
  });

  it('authorizes Settings only after exact successful readiness evidence', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const operations = createOperations();
    const fixture = createFixture({ operations, nativeResponse: 1 });

    await expect(fixture.service.requireSettingsReadiness(input)).rejects.toThrow(
      'Run Check Docker successfully',
    );
    await expect(requiredHandler(IPC_CHANNELS.dockerCheck)(liveEvent(), input)).resolves.toEqual({
      ok: true,
      value: ready,
    });
    await expect(fixture.service.requireSettingsReadiness(input)).resolves.toBeUndefined();
    await expect(
      fixture.service.requireSettingsReadiness({ ...input, image: 'registry.example/agent:2' }),
    ).rejects.toThrow('Run Check Docker successfully');
    await fixture.service.dispose();
  });

  it('rejects expired readiness and executable identity drift', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const operations = createOperations();
    let current = new Date('2026-07-14T16:00:00.000Z');
    const fixture = createFixture({ operations, nativeResponse: 1, now: () => current });
    await requiredHandler(IPC_CHANNELS.dockerCheck)(liveEvent(), input);

    current = new Date('2026-07-14T16:05:00.001Z');
    await expect(fixture.service.requireSettingsReadiness(input)).rejects.toThrow(
      'Run Check Docker successfully',
    );
    current = new Date('2026-07-14T16:01:00.000Z');
    await requiredHandler(IPC_CHANNELS.dockerCheck)(liveEvent(), input);
    operations.identify.mockResolvedValueOnce({ ...identity, sha256: 'b'.repeat(64) });
    await expect(fixture.service.requireSettingsReadiness(input)).rejects.toThrow(
      'selected Docker executable changed',
    );
    await fixture.service.dispose();
  });

  it('lists local images and containers without opening a native dialog', async () => {
    const operations = createOperations();
    const fixture = createFixture({ operations });

    const result = await requiredHandler(IPC_CHANNELS.dockerListLocal)(liveEvent(), {
      dockerExecutable: '/selected/bin/docker',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        daemonAvailable: true,
        images: [{ reference: 'node:22-bookworm', imageId: 'sha256:aa' }],
        containers: [{ name: 'dev-box', image: 'acme/agents:1', state: 'running' }],
      },
    });
    expect(operations.list).toHaveBeenCalledWith('/selected/bin/docker');
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    expect(fixture.appendAudit).toHaveBeenCalledWith(
      'docker',
      'list-local',
      'allowed',
      expect.objectContaining({ imageCount: 1, containerCount: 1 }),
    );

    const invalid = await requiredHandler(IPC_CHANNELS.dockerListLocal)(liveEvent(), {
      dockerExecutable: '   ',
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    await fixture.service.dispose();
  });

  it('cannot authorize Settings after shutdown invalidates evidence during revalidation', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const operations = createOperations();
    const fixture = createFixture({ operations, nativeResponse: 1 });
    await requiredHandler(IPC_CHANNELS.dockerCheck)(liveEvent(), input);
    const resolution = deferred<string>();
    const previousResolutionCount = operations.resolve.mock.calls.length;
    operations.resolve.mockImplementationOnce(() => resolution.promise);

    const verification = fixture.service.requireSettingsReadiness(input);
    await vi.waitFor(() =>
      expect(operations.resolve).toHaveBeenCalledTimes(previousResolutionCount + 1),
    );
    await fixture.service.pauseForShutdown();
    resolution.resolve(canonicalInput.dockerExecutable);

    await expect(verification).rejects.toThrow('paused while Artemis quits');
    fixture.service.resumeAfterShutdownPause();
    await fixture.service.dispose();
  });

  it('does not restore Settings evidence when a check drains during shutdown pause', async () => {
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const operations = createOperations();
    const check = deferred<DockerReadiness>();
    operations.check.mockImplementationOnce(async (_configuration, authorization) => {
      await authorization.beforeCommand();
      return await check.promise;
    });
    const fixture = createFixture({ operations, nativeResponse: 1 });
    const request = requiredHandler(IPC_CHANNELS.dockerCheck)(liveEvent(), input);
    await vi.waitFor(() => expect(operations.check).toHaveBeenCalledTimes(1));

    const pause = fixture.service.pauseForShutdown();
    check.resolve(ready);
    await request;
    await pause;
    fixture.service.resumeAfterShutdownPause();

    await expect(fixture.service.requireSettingsReadiness(input)).rejects.toThrow(
      'Run Check Docker successfully',
    );
    await fixture.service.dispose();
  });
});

function createOperations() {
  return {
    resolve: vi
      .fn<DockerOperations['resolve']>()
      .mockResolvedValue(canonicalInput.dockerExecutable),
    identify: vi.fn<DockerOperations['identify']>().mockResolvedValue(identity),
    check: vi.fn<DockerOperations['check']>(async (_configuration, authorization) => {
      await authorization.beforeCommand();
      return ready;
    }),
    pull: vi.fn<DockerOperations['pull']>(async (_configuration, _permit, beforeCommand) => {
      await beforeCommand();
    }),
    list: vi.fn<DockerOperations['list']>().mockResolvedValue({
      daemonAvailable: true,
      images: [{ reference: 'node:22-bookworm', imageId: 'sha256:aa' }],
      containers: [{ name: 'dev-box', image: 'acme/agents:1', state: 'running' }],
    }),
  } satisfies DockerOperations;
}

function createFixture(options: {
  readonly operations: DockerOperations;
  readonly nativeResponse?: number;
  readonly now?: () => Date;
}) {
  const showMessageBox = vi.fn<
    (parent: BrowserWindow, messageBoxOptions: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  >(() => Promise.resolve({ response: options.nativeResponse ?? 0, checkboxChecked: false }));
  const appendAudit = vi.fn();
  const service = new DockerIpcService(
    { showMessageBox },
    { appendAudit },
    options.operations,
    undefined,
    options.now,
  );
  service.registerIpcHandlers();
  return { service, showMessageBox, appendAudit };
}

function liveEvent(): IpcMainInvokeEvent {
  const mainFrame = {};
  const sender = {
    id: 42,
    mainFrame,
    isDestroyed: () => false,
    once: vi.fn(),
  } as unknown as WebContents;
  return { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
}

function requiredHandler(channel: string) {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler ${channel}.`);
  return handler;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
