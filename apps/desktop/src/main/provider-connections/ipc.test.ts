import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  return {
    handlers: new Map<string, Handler>(),
    handle: vi.fn((channel: string, handler: Handler) =>
      electronMock.handlers.set(channel, handler),
    ),
    removeHandler: vi.fn((channel: string) => electronMock.handlers.delete(channel)),
    fromWebContents: vi.fn(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMock.fromWebContents },
  ipcMain: { handle: electronMock.handle, removeHandler: electronMock.removeHandler },
}));

import {
  PROVIDER_CONNECTION_IPC_CHANNELS,
  type ProviderConnectionStatus,
} from '../../shared/provider-connections/index.js';
import { ProviderConnectionIpcService } from './ipc.js';
import type { ProviderConnectionAuthorizer, ProviderConnectionNativeReview } from './service.js';

const PLAN_ID = '10000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T12:00:00.000Z';
const STATUS: ProviderConnectionStatus = {
  schemaVersion: 1,
  providerId: 'codex',
  state: 'connected',
  checkedAt: NOW,
  reason: null,
};

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
  electronMock.fromWebContents.mockReset();
});

describe('ProviderConnectionIpcService', () => {
  it('requires native confirmation and forwards no renderer-supplied command details', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandlers();
    const result = await handler(PROVIDER_CONNECTION_IPC_CHANNELS.confirm)(liveEvent(), {
      planId: PLAN_ID,
    });
    expect(result).toEqual({ ok: true, value: STATUS });
    expect(fixture.confirm).toHaveBeenCalledWith(
      expect.any(String),
      PLAN_ID,
      expect.any(Function),
      expect.any(Function),
    );
    expect(fixture.showMessageBox).toHaveBeenCalledWith(fixture.parent, expect.any(Object));
    await fixture.service.dispose();
  });

  it('rejects a subframe before prepare, confirm, status, or cancel reaches authority', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandlers();
    const event = liveEvent();
    Object.defineProperty(event, 'senderFrame', { value: {} });
    for (const [channel, input] of [
      [PROVIDER_CONNECTION_IPC_CHANNELS.get, { providerId: 'codex' }],
      [PROVIDER_CONNECTION_IPC_CHANNELS.prepare, { providerId: 'codex', action: 'connect' }],
      [PROVIDER_CONNECTION_IPC_CHANNELS.confirm, { planId: PLAN_ID }],
      [PROVIDER_CONNECTION_IPC_CHANNELS.cancel, { planId: PLAN_ID }],
    ] as const) {
      await expect(handler(channel)(event, input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'OPERATION_FAILED' },
      });
    }
    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(fixture.cancel).not.toHaveBeenCalled();
    await fixture.service.dispose();
  });

  it('cancels only an owner-bound pending or active plan', async () => {
    const fixture = createFixture();
    fixture.service.registerIpcHandlers();
    await expect(
      handler(PROVIDER_CONNECTION_IPC_CHANNELS.cancel)(liveEvent(), { planId: PLAN_ID }),
    ).resolves.toEqual({ ok: true, value: { acknowledged: true } });
    expect(fixture.cancel).toHaveBeenCalledWith(expect.any(String), PLAN_ID);
    fixture.cancel.mockReturnValueOnce(false);
    await expect(
      handler(PROVIDER_CONNECTION_IPC_CHANNELS.cancel)(liveEvent(), { planId: PLAN_ID }),
    ).resolves.toMatchObject({ ok: false });
    await fixture.service.dispose();
  });
});

function createFixture() {
  const parent = { isDestroyed: () => false };
  electronMock.fromWebContents.mockReturnValue(parent);
  const showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));
  const get = vi.fn(() => Promise.resolve(STATUS));
  const prepare = vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1 as const,
      planId: PLAN_ID,
      providerId: 'codex' as const,
      action: 'connect' as const,
      expiresAt: '2026-07-17T12:05:00.000Z',
    }),
  );
  const confirm = vi.fn(
    (_owner: string, _planId: string, authorize: ProviderConnectionAuthorizer) =>
      authorize(REVIEW).then((decision) => (decision === 'approved' ? STATUS : null)),
  );
  const cancel = vi.fn(() => true);
  const connections = {
    get,
    prepare,
    confirm,
    cancel,
    discardOwner: vi.fn(),
    pauseForShutdown: vi.fn(() => Promise.resolve()),
    resumeAfterPause: vi.fn(),
    resetForPrivacy: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
  };
  const service = new ProviderConnectionIpcService(
    { showMessageBox } as never,
    connections as never,
    () => parent as never,
  );
  return { service, parent, showMessageBox, get, prepare, confirm, cancel };
}

const REVIEW: ProviderConnectionNativeReview = {
  view: {
    schemaVersion: 1,
    planId: PLAN_ID,
    providerId: 'codex',
    action: 'connect',
    expiresAt: '2026-07-17T12:05:00.000Z',
  },
  providerName: 'OpenAI Codex',
  providerDisclosure: 'Codex may contact OpenAI and Artemis stores no OAuth token.',
  executable: '/usr/local/bin/codex',
  executableSha256: 'a'.repeat(64),
  validationArguments: [['--version']],
  commandArguments: ['login'],
  followUpArguments: ['login', 'status'],
  cwd: '/Users/example',
  environmentVariableNames: ['HOME', 'PATH'],
};

function liveEvent() {
  const mainFrame = {};
  const listeners = new Map<string, () => void>();
  const sender = {
    mainFrame,
    isDestroyed: () => false,
    once: (name: string, listener: () => void) => listeners.set(name, listener),
    removeListener: (name: string) => listeners.delete(name),
  };
  return { sender, senderFrame: mainFrame };
}

function handler(channel: string) {
  const registered = electronMock.handlers.get(channel);
  if (registered === undefined) throw new Error(`Missing handler: ${channel}`);
  return registered;
}
