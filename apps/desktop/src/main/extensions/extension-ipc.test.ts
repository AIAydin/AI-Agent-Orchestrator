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

import { IPC_CHANNELS } from '../../shared/application/contracts.js';
import { ExtensionIpcService } from './extension-ipc.js';
import { ExtensionManager } from './extension-manager.js';
import { LocalStore } from '../storage.js';

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
      {
        getPath: () => '/tmp/forgeboard-extension-ipc-test',
      } as unknown as ConstructorParameters<typeof ExtensionIpcService>[0],
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

    const pendingResult = handler!(liveEvent(sender), 'folder');
    expect(showOpenDialog).toHaveBeenCalledWith(
      parentWindow,
      expect.objectContaining({ properties: ['openDirectory'] }),
    );

    destroyed = true;
    listeners.get('destroyed')?.();
    resolveSelection({
      canceled: false,
      filePaths: ['/tmp/untrusted-after-close'],
    });

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
    await service.dispose();
  });

  it('drains a deferred chooser before privacy purge completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-extension-ipc-'));
    roots.push(root);
    let resolveSelection!: (selection: { canceled: boolean; filePaths: string[] }) => void;
    const showOpenDialog = vi.fn(
      () =>
        new Promise<{ canceled: boolean; filePaths: string[] }>((resolve) => {
          resolveSelection = resolve;
        }),
    );
    const appendAudit = vi.fn();
    electronMock.fromWebContents.mockReturnValue({ isDestroyed: () => false });
    const service = new ExtensionIpcService(
      { getPath: () => root } as unknown as ConstructorParameters<typeof ExtensionIpcService>[0],
      { showOpenDialog } as unknown as ConstructorParameters<typeof ExtensionIpcService>[1],
      {
        appendAudit,
        listTrustedExtensions: () => [],
      } as unknown as ConstructorParameters<typeof ExtensionIpcService>[2],
    );
    service.registerIpcHandlers();
    const event = liveEvent({
      id: 81,
      isDestroyed: () => false,
      once: vi.fn(),
    });
    const handler = electronMock.handlers.get(IPC_CHANNELS.extensionsChoose);
    if (handler === undefined) throw new Error('Extension chooser handler was not registered.');
    const choosing = handler(event, 'folder');
    await vi.waitFor(() => {
      expect(resolveSelection).toBeTypeOf('function');
    });
    let resetFinished = false;
    const resetting = service.resetForPrivacy().then(() => {
      resetFinished = true;
    });
    await Promise.resolve();
    expect(resetFinished).toBe(false);

    resolveSelection({ canceled: true, filePaths: [] });
    await choosing;
    await resetting;
    expect(appendAudit).toHaveBeenCalledWith('extension', 'privacy-purge', 'allowed', {
      ledgerCount: 0,
    });
    await service.dispose();
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
    const event = liveEvent(sender);
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
    await service.pauseForShutdown();
    service.resumeAfterPrivacyReset();
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
    expect(messageBoxOptions.detail).toMatch(/Manifest fingerprint \(SHA-256\): [a-f0-9]{64}/u);
    expect(
      (await new LocalExtensionService(join(root, 'extensions')).discover()).installed,
    ).toEqual([]);
    await service.dispose();
  });

  it('requires a live cancel-default native review for an exact owner-bound removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-extension-ipc-remove-'));
    roots.push(root);
    const source = join(root, 'source');
    await writeExtension(source);
    const store = new LocalStore(join(root, 'forgeboard.sqlite3'));
    const registry = new LocalExtensionService(join(root, 'extensions'));
    const bootstrap = new ExtensionManager(registry, store);
    const installPlan = await bootstrap.plan(source, 1);
    await bootstrap.approve(installPlan.planId, 1);
    const parentWindow = { isDestroyed: vi.fn(() => false) };
    electronMock.fromWebContents.mockReturnValue(parentWindow);
    const showMessageBox = vi
      .fn()
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const service = new ExtensionIpcService(
      { getPath: () => root } as unknown as ConstructorParameters<typeof ExtensionIpcService>[0],
      {
        showOpenDialog: vi.fn(),
        showMessageBox,
      } as unknown as ConstructorParameters<typeof ExtensionIpcService>[1],
      store,
    );
    service.registerIpcHandlers();
    const event = liveEvent({
      id: 92,
      isDestroyed: () => false,
      once: vi.fn(),
    });
    const removeHandler = electronMock.handlers.get(IPC_CHANNELS.extensionsRemove);
    if (removeHandler === undefined)
      throw new Error('Extension removal handler was not registered.');

    await expect(
      removeHandler(event, {
        extensionId: 'example.confirmation',
        confirmation: 'wrong',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'APPROVAL_MISMATCH' },
    });
    expect(showMessageBox).not.toHaveBeenCalled();

    await expect(
      removeHandler(event, {
        extensionId: 'example.confirmation',
        confirmation: 'example.confirmation',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'APPROVAL_MISMATCH' },
    });
    expect((await registry.discover()).installed).toHaveLength(1);
    expect(showMessageBox.mock.calls[0]?.[0]).toBe(parentWindow);
    expect(showMessageBox.mock.calls[0]?.[1]).toMatchObject({
      buttons: ['Cancel', 'Remove extension'],
      defaultId: 0,
      cancelId: 0,
    });
    expect(JSON.stringify(showMessageBox.mock.calls[0]?.[1])).not.toContain(source);

    await expect(
      removeHandler(event, {
        extensionId: 'example.confirmation',
        confirmation: 'example.confirmation',
      }),
    ).resolves.toMatchObject({ ok: true, value: { installed: [] } });
    expect((await registry.discover()).installed).toEqual([]);
    const removalAudits = store
      .listAuditEvents(50)
      .filter((event) => event.category === 'extension' && event.action === 'remove');
    expect(removalAudits.map((event) => event.outcome)).toEqual(
      expect.arrayContaining(['allowed', 'denied']),
    );
    await service.dispose();
    store.close();
  });

  it('rejects subframe extension requests before opening a native chooser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-extension-ipc-'));
    roots.push(root);
    const showOpenDialog = vi.fn();
    const service = new ExtensionIpcService(
      { getPath: () => root } as unknown as ConstructorParameters<typeof ExtensionIpcService>[0],
      { showOpenDialog } as unknown as ConstructorParameters<typeof ExtensionIpcService>[1],
      { appendAudit: vi.fn() } as unknown as ConstructorParameters<typeof ExtensionIpcService>[2],
    );
    service.registerIpcHandlers();
    const event = liveEvent({
      id: 101,
      isDestroyed: () => false,
      once: vi.fn(),
    });
    Object.defineProperty(event, 'senderFrame', { value: {} });

    const result = await electronMock.handlers.get(IPC_CHANNELS.extensionsChoose)?.(
      event,
      'folder',
    );

    expect(result).toMatchObject({ ok: false });
    expect(showOpenDialog).not.toHaveBeenCalled();
    await service.dispose();
  });
});

function liveEvent(sender: { id: number; isDestroyed(): boolean; once: ReturnType<typeof vi.fn> }) {
  const mainFrame = {};
  return {
    sender: { ...sender, mainFrame },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
}

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
      publisher: 'Artemis tests',
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
