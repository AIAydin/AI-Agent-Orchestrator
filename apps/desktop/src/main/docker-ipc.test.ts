import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  return {
    handlers: new Map<string, Handler>(),
    fromWebContents: vi.fn(),
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
}));

import { IPC_CHANNELS } from '../shared/contracts.js';
import type { DockerReadiness } from '../shared/docker-contracts.js';
import { DockerIpcService } from './docker-ipc.js';

const input = {
  dockerExecutable: '/usr/local/bin/docker',
  image: 'registry.example/agent:1',
  containerExecutable: '/usr/local/bin/codex',
};

const ready: DockerReadiness = {
  executable: '/usr/local/bin/docker',
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
  it('rejects hostile renderer input before any runtime operation', async () => {
    const operations = { check: vi.fn(), pull: vi.fn() };
    const service = new DockerIpcService(
      { showMessageBox: vi.fn() },
      { appendAudit: vi.fn() },
      operations,
    );
    service.registerIpcHandlers();
    const handler = requiredHandler(IPC_CHANNELS.dockerCheck);
    const result = await handler(liveEvent(), {
      ...input,
      image: 'safe;touch /tmp/escaped',
      unexpected: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(operations.check).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('requires a native main-process confirmation and keeps cancellation non-mutating', async () => {
    const parentWindow = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parentWindow);
    const showMessageBox = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));
    const appendAudit = vi.fn();
    const operations = {
      check: vi.fn(() => Promise.resolve(ready)),
      pull: vi.fn(() => Promise.resolve()),
    };
    const service = new DockerIpcService({ showMessageBox }, { appendAudit }, operations);
    service.registerIpcHandlers();

    const result = await requiredHandler(IPC_CHANNELS.dockerPull)(liveEvent(), input);
    expect(result).toMatchObject({
      ok: true,
      value: { outcome: 'cancelled', readiness: { status: 'ready' } },
    });
    expect(operations.pull).not.toHaveBeenCalled();
    expect(showMessageBox).toHaveBeenCalledWith(
      parentWindow,
      expect.objectContaining({
        buttons: ['Cancel', 'Pull image'],
        defaultId: 0,
        cancelId: 0,
        message: `Pull ${input.image}?`,
      }),
    );
    expect(appendAudit).toHaveBeenCalledWith(
      'docker',
      'image-pull',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-cancelled' }),
    );
    await service.dispose();
  });

  it('pulls only after confirmation, checks again, and returns bounded readiness state', async () => {
    const parentWindow = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parentWindow);
    const missing: DockerReadiness = {
      ...ready,
      imageAvailable: false,
      imageCompatible: false,
      containerExecutableAvailable: false,
      available: false,
      status: 'image-missing',
      reason: 'Image is not available locally.',
    };
    const operations = {
      check: vi
        .fn<(configuration: typeof input) => Promise<DockerReadiness>>()
        .mockResolvedValueOnce(missing)
        .mockResolvedValueOnce(ready),
      pull: vi.fn(() => Promise.resolve()),
    };
    const appendAudit = vi.fn();
    const service = new DockerIpcService(
      { showMessageBox: vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false })) },
      { appendAudit },
      operations,
    );
    service.registerIpcHandlers();

    const result = await requiredHandler(IPC_CHANNELS.dockerPull)(liveEvent(), input);
    expect(result).toMatchObject({
      ok: true,
      value: { outcome: 'pulled', readiness: { available: true, status: 'ready' } },
    });
    expect(operations.pull).toHaveBeenCalledTimes(1);
    expect(operations.pull).toHaveBeenCalledWith(input);
    expect(operations.check).toHaveBeenCalledTimes(2);
    expect(appendAudit).toHaveBeenLastCalledWith(
      'docker',
      'image-pull',
      'allowed',
      expect.objectContaining({ containerExecutableAvailable: true }),
    );
    await service.dispose();
  });

  it('acquires the pull single-flight guard before asynchronous readiness and confirmation', async () => {
    const parentWindow = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parentWindow);
    let resolveFirstCheck!: (readiness: DockerReadiness) => void;
    const firstCheck = new Promise<DockerReadiness>((resolve) => {
      resolveFirstCheck = resolve;
    });
    const operations = {
      check: vi
        .fn<(configuration: typeof input) => Promise<DockerReadiness>>()
        .mockImplementationOnce(() => firstCheck)
        .mockResolvedValueOnce(ready),
      pull: vi.fn(() => Promise.resolve()),
    };
    const showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));
    const service = new DockerIpcService({ showMessageBox }, { appendAudit: vi.fn() }, operations);
    service.registerIpcHandlers();
    const handler = requiredHandler(IPC_CHANNELS.dockerPull);

    const first = handler(liveEvent(), input);
    expect(operations.check).toHaveBeenCalledTimes(1);
    const second = await handler(liveEvent(), input);
    expect(second).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'A Docker image pull is already in progress.' },
    });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(operations.pull).not.toHaveBeenCalled();

    resolveFirstCheck(ready);
    await expect(first).resolves.toMatchObject({
      ok: true,
      value: { outcome: 'pulled', readiness: { status: 'ready' } },
    });
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(operations.pull).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('refuses a pull without a live originating window', async () => {
    electronMock.fromWebContents.mockReturnValue(null);
    const operations = {
      check: vi.fn(() => Promise.resolve(ready)),
      pull: vi.fn(() => Promise.resolve()),
    };
    const service = new DockerIpcService(
      { showMessageBox: vi.fn() },
      { appendAudit: vi.fn() },
      operations,
    );
    service.registerIpcHandlers();

    const result = await requiredHandler(IPC_CHANNELS.dockerPull)(liveEvent(), input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(ipcErrorMessage(result)).toContain('live Forgeboard');
    expect(operations.pull).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('removes handlers immediately and drains an in-flight request before disposal resolves', async () => {
    let resolveCheck!: (readiness: DockerReadiness) => void;
    const pendingCheck = new Promise<DockerReadiness>((resolve) => {
      resolveCheck = resolve;
    });
    let disposalFinished = false;
    const appendAudit = vi.fn(() => {
      expect(disposalFinished).toBe(false);
    });
    const service = new DockerIpcService(
      { showMessageBox: vi.fn() },
      { appendAudit },
      { check: vi.fn(() => pendingCheck), pull: vi.fn() },
    );
    service.registerIpcHandlers();
    const staleHandler = requiredHandler(IPC_CHANNELS.dockerCheck);
    const request = staleHandler(liveEvent(), input);

    const disposal = service.dispose();
    expect(service.dispose()).toBe(disposal);
    expect(electronMock.handlers.has(IPC_CHANNELS.dockerCheck)).toBe(false);
    expect(electronMock.handlers.has(IPC_CHANNELS.dockerPull)).toBe(false);
    void disposal.then(() => {
      disposalFinished = true;
    });
    await Promise.resolve();
    expect(disposalFinished).toBe(false);
    expect(appendAudit).not.toHaveBeenCalled();

    resolveCheck(ready);
    await expect(request).resolves.toMatchObject({
      ok: true,
      value: { available: true, status: 'ready' },
    });
    await disposal;
    expect(disposalFinished).toBe(true);
    expect(appendAudit).toHaveBeenCalledTimes(1);

    await expect(staleHandler(liveEvent(), input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'The Docker service has been disposed.' },
    });
    expect(appendAudit).toHaveBeenCalledTimes(1);
  });
});

function liveEvent(): IpcMainInvokeEvent {
  return {
    sender: { isDestroyed: () => false },
  } as unknown as IpcMainInvokeEvent;
}

function requiredHandler(channel: string) {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler ${channel}.`);
  return handler;
}

function ipcErrorMessage(result: unknown): string {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('error' in result) ||
    typeof result.error !== 'object' ||
    result.error === null ||
    !('message' in result.error) ||
    typeof result.error.message !== 'string'
  ) {
    throw new Error('Expected a structured IPC error.');
  }
  return result.error.message;
}
