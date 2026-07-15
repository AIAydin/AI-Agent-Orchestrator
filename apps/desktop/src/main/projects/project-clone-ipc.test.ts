import type { IpcMainInvokeEvent, WebContents } from 'electron';
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
import { OutboundActionGate } from '../outbound/outbound-action-gate.js';
import { ProjectCloneIpcService } from './project-clone-ipc.js';
import type { ProjectCloneAuthorization } from './project-service.js';

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
  electronMock.fromWebContents.mockReset();
});

describe('ProjectCloneIpcService', () => {
  it('passes a unique WebContents owner and parent-bound native boundary to project cloning', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const showMessageBox = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));
    const appendAudit = vi.fn();
    const projects = {
      clone: vi.fn(
        async (
          _remote: string,
          _destination: string,
          authorization?: ProjectCloneAuthorization,
        ) => {
          expect(authorization?.ownerId).toMatch(
            /^web-contents:42:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          );
          expect(authorization?.gate).toBe(gate);
          expect(await authorization?.confirmation.confirm(plan())).toBe('denied');
          authorization?.assertCurrent();
          return null;
        },
      ),
    };
    const gate = new OutboundActionGate({ appendAudit });
    const service = new ProjectCloneIpcService({ showMessageBox }, projects, gate);
    service.registerIpcHandler();

    const result = await requiredHandler()(liveEvent(), {
      remoteUrl: 'https://github.com/owner/repository.git',
      destinationPath: '/tmp/repository',
    });
    expect(result).toEqual({ ok: true, value: null });
    expect(showMessageBox).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({ defaultId: 0, cancelId: 0 }),
    );
    await service.dispose();
  });

  it('fails closed when the parent window changes during native confirmation', async () => {
    let parentDestroyed = false;
    const parent = { isDestroyed: () => parentDestroyed };
    electronMock.fromWebContents.mockReturnValue(parent);
    const showMessageBox = vi.fn(() => {
      parentDestroyed = true;
      return Promise.resolve({ response: 1, checkboxChecked: false });
    });
    const projects = {
      clone: vi.fn(
        async (
          _remote: string,
          _destination: string,
          authorization?: ProjectCloneAuthorization,
        ) => {
          if (authorization === undefined) throw new Error('Missing clone authorization.');
          await authorization.confirmation.confirm(plan());
          return null;
        },
      ),
    };
    const service = new ProjectCloneIpcService(
      { showMessageBox },
      projects,
      new OutboundActionGate({ appendAudit: vi.fn() }),
    );
    service.registerIpcHandler();

    const result = await requiredHandler()(liveEvent(), {
      remoteUrl: 'https://github.com/owner/repository.git',
      destinationPath: '/tmp/repository',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(JSON.stringify(result)).toContain('changed or closed');
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('fails closed when WebContents is rebound to a replacement parent', async () => {
    const parent = { isDestroyed: () => false };
    const replacement = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    const showMessageBox = vi.fn(() => {
      electronMock.fromWebContents.mockReturnValue(replacement);
      return Promise.resolve({ response: 1, checkboxChecked: false });
    });
    const projects = {
      clone: vi.fn(
        async (
          _remote: string,
          _destination: string,
          authorization?: ProjectCloneAuthorization,
        ) => {
          if (authorization === undefined) throw new Error('Missing clone authorization.');
          await authorization.confirmation.confirm(plan());
          return null;
        },
      ),
    };
    const service = new ProjectCloneIpcService(
      { showMessageBox },
      projects,
      new OutboundActionGate({ appendAudit: vi.fn() }),
    );
    service.registerIpcHandler();

    const result = await requiredHandler()(liveEvent(), {
      remoteUrl: 'https://github.com/owner/repository.git',
      destinationPath: '/tmp/repository',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(JSON.stringify(result)).toContain('changed or closed');
    expect(projects.clone).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('rejects subframes and never reaches project cloning', async () => {
    const projects = { clone: vi.fn() };
    const service = new ProjectCloneIpcService(
      { showMessageBox: vi.fn() },
      projects,
      new OutboundActionGate({ appendAudit: vi.fn() }),
    );
    service.registerIpcHandler();
    const event = liveEvent();
    Object.defineProperty(event, 'senderFrame', { value: {} });

    await expect(
      requiredHandler()(event, {
        remoteUrl: 'https://github.com/owner/repository.git',
        destinationPath: '/tmp/repository',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(projects.clone).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('removes the handler and drains an admitted clone before shutdown completes', async () => {
    const parent = { isDestroyed: () => false };
    electronMock.fromWebContents.mockReturnValue(parent);
    let finish!: () => void;
    const pending = new Promise<null>((resolve) => {
      finish = () => resolve(null);
    });
    const projects = { clone: vi.fn(() => pending) };
    const service = new ProjectCloneIpcService(
      { showMessageBox: vi.fn() },
      projects,
      new OutboundActionGate({ appendAudit: vi.fn() }),
    );
    service.registerIpcHandler();
    const request = requiredHandler()(liveEvent(), {
      remoteUrl: 'https://github.com/owner/repository.git',
      destinationPath: '/tmp/repository',
    });
    const disposal = service.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(electronMock.handlers.has(IPC_CHANNELS.projectsClone)).toBe(false);

    finish();
    await expect(request).resolves.toEqual({ ok: true, value: null });
    await disposal;
    expect(disposed).toBe(true);
  });
});

function liveEvent(): IpcMainInvokeEvent {
  const listeners = new Map<string, () => void>();
  const mainFrame = {};
  const sender = {
    id: 42,
    mainFrame,
    isDestroyed: () => false,
    once: (event: string, listener: () => void) => listeners.set(event, listener),
  } as unknown as WebContents;
  return { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
}

function requiredHandler() {
  const handler = electronMock.handlers.get(IPC_CHANNELS.projectsClone);
  if (handler === undefined) throw new Error('Missing project clone IPC handler.');
  return handler;
}

function plan() {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    expiresAt: '2026-07-15T16:05:00.000Z',
    disclosureSha256: 'a'.repeat(64),
    disclosure: {
      action: 'git-clone' as const,
      title: 'Clone Git repository',
      summary: 'Clone repository?',
      confirmLabel: 'Clone repository',
      destination: {
        kind: 'git-remote' as const,
        endpoint: 'github.com',
        resource: '/owner/repository.git',
        transport: 'HTTPS',
      },
      details: [{ label: 'Local destination', value: '/tmp/repository' }],
      warning: 'Network access occurs after approval.',
    },
  };
}
