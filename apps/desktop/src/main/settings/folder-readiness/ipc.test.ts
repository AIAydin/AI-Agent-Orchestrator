import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  return {
    handlers: new Map<string, Handler>(),
    handle: vi.fn((channel: string, handler: Handler) =>
      electronMock.handlers.set(channel, handler),
    ),
    removeHandler: vi.fn((channel: string) => electronMock.handlers.delete(channel)),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronMock.handle,
    removeHandler: electronMock.removeHandler,
  },
}));

import { IPC_CHANNELS } from '../../../shared/application/contracts.js';
import { FolderReadinessIpcService } from './ipc.js';

const request = {
  purpose: 'managed-worktrees' as const,
  path: '/tmp/forgeboard-worktrees',
};
const value = {
  schemaVersion: 1 as const,
  request,
  state: 'ready-existing' as const,
  ready: true,
  checkedAt: '2026-07-15T18:00:00.000Z',
  reason: null,
  warning: null,
};

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

describe('FolderReadinessIpcService', () => {
  it('keeps passive inspection inside the live main-frame data gate', async () => {
    const order: string[] = [];
    const check = vi.fn(() => {
      order.push('check');
      return Promise.resolve(value);
    });
    const service = new FolderReadinessIpcService({ check }, async (operation) => {
      order.push('gate-start');
      const result = await operation();
      order.push('gate-end');
      return result;
    });
    service.registerIpcHandler();

    await expect(handler()(liveEvent(), request)).resolves.toEqual({
      ok: true,
      value,
    });
    expect(check).toHaveBeenCalledWith(request);
    expect(order).toEqual(['gate-start', 'check', 'gate-end']);
    service.dispose();
    expect(electronMock.removeHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.settingsCheckFolderReadiness,
    );
  });

  it('rejects malformed input and non-main-frame callers before inspection', async () => {
    const check = vi.fn();
    const service = new FolderReadinessIpcService({ check });
    service.registerIpcHandler();

    await expect(handler()(liveEvent(), { ...request, path: '/tmp/a\nb' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    await expect(handler()(subframeEvent(), request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(check).not.toHaveBeenCalled();
  });
});

function handler() {
  const registered = electronMock.handlers.get(IPC_CHANNELS.settingsCheckFolderReadiness);
  if (registered === undefined) throw new Error('Folder readiness IPC handler was not registered.');
  return registered;
}

function liveEvent() {
  const mainFrame = {};
  return {
    sender: { mainFrame, isDestroyed: () => false },
    senderFrame: mainFrame,
  };
}

function subframeEvent() {
  return {
    sender: { mainFrame: {}, isDestroyed: () => false },
    senderFrame: { detached: false },
  };
}
