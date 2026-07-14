import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalExtensionService } from '@forgeboard/extension-runtime';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { ExtensionIpcService } from './extension-ipc.js';

const roots: string[] = [];

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.fromWebContents.mockReset();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ExtensionIpcService', () => {
  it('parents the native chooser and rejects its result after the originating sender closes', async () => {
    let resolveSelection!: (selection: { canceled: boolean; filePaths: string[] }) => void;
    const showOpenDialog = vi.fn(
      () =>
        new Promise<{ canceled: boolean; filePaths: string[] }>((resolve) => {
          resolveSelection = resolve;
        }),
    );
    const parentWindow = { isDestroyed: vi.fn(() => false) };
    electronMock.fromWebContents.mockReturnValue(parentWindow);
    const service = new ExtensionIpcService(
      { getPath: () => '/tmp/forgeboard-extension-ipc-test' } as unknown as ConstructorParameters<
        typeof ExtensionIpcService
      >[0],
      { showOpenDialog } as unknown as ConstructorParameters<typeof ExtensionIpcService>[1],
      { appendAudit: () => undefined } as unknown as ConstructorParameters<
        typeof ExtensionIpcService
      >[2],
    );
    service.registerIpcHandlers();

    let destroyed = false;
    const listeners = new Map<string, () => void>();
    const sender = {
      id: 73,
      isDestroyed: () => destroyed,
      once: vi.fn((eventName: string, listener: () => void) => {
        listeners.set(eventName, listener);
      }),
    };
    const handler = electronMock.handlers.get(IPC_CHANNELS.extensionsChoose);
    expect(handler).toBeDefined();

    const pendingResult = handler!({ sender } as unknown as IpcMainInvokeEvent, 'folder');
    expect(showOpenDialog).toHaveBeenCalledWith(
      parentWindow,
      expect.objectContaining({ properties: ['openDirectory'] }),
    );

    destroyed = true;
    listeners.get('destroyed')?.();
    resolveSelection({ canceled: false, filePaths: ['/tmp/untrusted-after-close'] });

    const result = await pendingResult;
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_SELECTION',
      },
    });
    if (
      typeof result !== 'object' ||
      result === null ||
      !('error' in result) ||
      typeof result.error !== 'object' ||
      result.error === null ||
      !('message' in result.error) ||
      typeof result.error.message !== 'string'
    ) {
      throw new Error('Expected a structured extension IPC error.');
    }
    expect(result.error.message).toContain('closed');
    service.dispose();
  });

  it('treats renderer confirmation as intent and denies install when the main dialog is cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-extension-ipc-'));
    roots.push(root);
    const source = join(root, 'source');
    await writeExtension(source);
    const parentWindow = { isDestroyed: vi.fn(() => false) };
    electronMock.fromWebContents.mockReturnValue(parentWindow);
    const showOpenDialog = vi.fn((options: unknown) => {
      void options;
      return Promise.resolve({ canceled: false, filePaths: [source] });
    });
    const showMessageBox = vi.fn((parent: unknown, options: unknown) => {
      void parent;
      void options;
      return Promise.resolve({ response: 0, checkboxChecked: false });
    });
    const trustStore = {
      appendAudit: vi.fn(),
      getTrustedExtension: vi.fn(() => undefined),
      listTrustedExtensions: vi.fn(() => []),
    };
    const service = new ExtensionIpcService(
      { getPath: () => root } as unknown as ConstructorParameters<typeof ExtensionIpcService>[0],
      { showOpenDialog, showMessageBox } as unknown as ConstructorParameters<
        typeof ExtensionIpcService
      >[1],
      trustStore as unknown as ConstructorParameters<typeof ExtensionIpcService>[2],
    );
    service.registerIpcHandlers();
    const sender = {
      id: 91,
      isDestroyed: () => false,
      once: vi.fn(),
    };
    const event = { sender } as unknown as IpcMainInvokeEvent;
    const chooseHandler = electronMock.handlers.get(IPC_CHANNELS.extensionsChoose);
    const approveHandler = electronMock.handlers.get(IPC_CHANNELS.extensionsApprove);
    if (chooseHandler === undefined || approveHandler === undefined) {
      throw new Error('Extension IPC handlers were not registered.');
    }

    const chooseResult = await chooseHandler(event, 'folder');
    if (
      typeof chooseResult !== 'object' ||
      chooseResult === null ||
      !('ok' in chooseResult) ||
      chooseResult.ok !== true ||
      !('value' in chooseResult) ||
      typeof chooseResult.value !== 'object' ||
      chooseResult.value === null ||
      !('planId' in chooseResult.value) ||
      typeof chooseResult.value.planId !== 'string'
    ) {
      throw new Error('Expected a successful extension plan.');
    }
    const approvalResult = await approveHandler(event, {
      planId: chooseResult.value.planId,
      confirmed: true,
    });

    expect(approvalResult).toMatchObject({
      ok: false,
      error: { code: 'APPROVAL_MISMATCH' },
    });
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    const messageBoxCall = showMessageBox.mock.calls[0];
    const messageBoxOptions: unknown = messageBoxCall?.[1];
    if (
      typeof messageBoxOptions !== 'object' ||
      messageBoxOptions === null ||
      !('detail' in messageBoxOptions) ||
      typeof messageBoxOptions.detail !== 'string'
    ) {
      throw new Error('Expected exact main-process extension confirmation details.');
    }
    expect(messageBoxCall?.[0]).toBe(parentWindow);
    expect(messageBoxOptions).toMatchObject({ defaultId: 0, cancelId: 0 });
    expect(messageBoxOptions.detail).toMatch(/Manifest SHA-256: [a-f0-9]{64}/u);
    expect(
      (await new LocalExtensionService(join(root, 'extensions')).discover()).installed,
    ).toEqual([]);
    service.dispose();
  });
});

async function writeExtension(source: string): Promise<void> {
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, 'forgeboard-extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'example.confirmation',
      name: 'Confirmation test',
      version: '1.0.0',
      description: 'Tests the trusted confirmation boundary.',
      publisher: 'Forgeboard tests',
      requestedPermissions: ['canvas.node.register', 'canvas.data.persist'],
      contributes: {
        agentAdapters: [],
        canvasNodeTypes: [
          {
            id: 'note',
            displayName: 'Note',
            description: 'A data-only note.',
            category: 'Test',
            icon: 'note',
            color: '#4F46E5',
            capabilities: ['human-editable'],
            fields: [],
            ports: [],
          },
        ],
      },
    }),
  );
}
