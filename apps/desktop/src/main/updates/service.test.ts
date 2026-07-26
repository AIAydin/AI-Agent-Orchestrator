import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
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

import { UPDATE_IPC_CHANNELS } from '../../shared/updates/contracts.js';
import { compareVersions, UpdateIpcService, type UpdateOperations } from './service.js';

const RELEASE = {
  id: 10,
  tag_name: 'v0.2.0',
  name: 'Artemis 0.2.0',
  html_url: 'https://github.com/AIAydin/AI-Agent-Orchestrator/releases/tag/v0.2.0',
  published_at: '2026-07-17T12:00:00.000Z',
  draft: false,
  prerelease: false,
};

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.removeHandler.mockClear();
  electronMock.fromWebContents.mockReset();
});

describe('UpdateIpcService', () => {
  it('does not request before an approved click and stable excludes prereleases', async () => {
    const fixture = createFixture();
    expect(fixture.operations.request).not.toHaveBeenCalled();
    const event = liveEvent();
    const result = await handler(UPDATE_IPC_CHANNELS.check)(event, { channel: 'stable' });
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'update-available', release: { version: '0.2.0' } },
    });
    expect(fixture.operations.request).toHaveBeenCalledTimes(1);
    expect(fixture.showMessageBox).toHaveBeenCalledWith(
      fixture.parent,
      expect.objectContaining({ defaultId: 0, cancelId: 0 }),
    );
    fixture.service.dispose();
  });

  it('accepts a workflow prerelease flag on a canonical release version', async () => {
    const fixture = createFixture({
      body: JSON.stringify([
        {
          ...RELEASE,
          tag_name: 'v0.1.0',
          html_url: RELEASE.html_url.replace('v0.2.0', 'v0.1.0'),
          prerelease: true,
        },
      ]),
    });
    const result = await handler(UPDATE_IPC_CHANNELS.check)(liveEvent(), { channel: 'prerelease' });
    expect(result).toMatchObject({
      ok: true,
      value: { release: { version: '0.1.0', prerelease: true }, status: 'up-to-date' },
    });
    fixture.service.dispose();
  });

  it('clears cached release authority before a denied refresh', async () => {
    const fixture = createFixture();
    const event = liveEvent();
    await handler(UPDATE_IPC_CHANNELS.check)(event, { channel: 'stable' });
    fixture.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(handler(UPDATE_IPC_CHANNELS.check)(event, { channel: 'stable' })).resolves.toEqual(
      { ok: true, value: null },
    );
    await expect(
      handler(UPDATE_IPC_CHANNELS.openRelease)(event, { releaseId: 10 }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(fixture.operations.openExternal).not.toHaveBeenCalled();
    fixture.service.dispose();
  });

  it('cancels an active bounded request for the same window', async () => {
    const operations = createOperations();
    operations.request.mockImplementation(
      async (_permit, signal) =>
        await new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('The update check was cancelled.');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const fixture = createFixture({ operations });
    const event = liveEvent();
    const checking = handler(UPDATE_IPC_CHANNELS.check)(event, { channel: 'stable' });
    await vi.waitFor(() => expect(operations.request).toHaveBeenCalled());
    await expect(handler(UPDATE_IPC_CHANNELS.cancel)(event)).resolves.toEqual({
      ok: true,
      value: { cancelled: true },
    });
    await expect(checking).resolves.toMatchObject({
      ok: false,
      error: { message: 'The update check was cancelled.' },
    });
    fixture.service.dispose();
  });

  it('opens only the fresh main-owned release after a second native review', async () => {
    const fixture = createFixture();
    const event = liveEvent();
    await handler(UPDATE_IPC_CHANNELS.check)(event, { channel: 'stable' });
    await expect(
      handler(UPDATE_IPC_CHANNELS.openRelease)(event, { releaseId: 10 }),
    ).resolves.toEqual({ ok: true, value: true });
    expect(fixture.operations.openExternal).toHaveBeenCalledWith(RELEASE.html_url);
    const auditCall = fixture.appendAudit.mock.calls.at(-1);
    expect(auditCall?.slice(0, 3)).toEqual([
      'external-navigation',
      'open-update-release',
      'allowed',
    ]);
    expect(auditCall?.[3]?.urlSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.appendAudit.mock.invocationCallOrder.at(-1)).toBeLessThan(
      fixture.operations.openExternal.mock.invocationCallOrder[0]!,
    );
    fixture.service.dispose();
  });

  it('fails closed before opening a release when the required allowed audit cannot persist', async () => {
    const fixture = createFixture();
    const event = liveEvent();
    fixture.appendAudit.mockImplementation((_category, action, outcome) => {
      if (action === 'open-update-release' && outcome === 'allowed') {
        throw new Error('audit unavailable');
      }
    });
    await handler(UPDATE_IPC_CHANNELS.check)(event, { channel: 'stable' });
    await expect(
      handler(UPDATE_IPC_CHANNELS.openRelease)(event, { releaseId: 10 }),
    ).resolves.toMatchObject({ ok: false, error: { message: 'audit unavailable' } });
    expect(fixture.operations.openExternal).not.toHaveBeenCalled();
    expect(fixture.appendAudit.mock.calls.at(-1)?.slice(0, 3)).toEqual([
      'external-navigation',
      'open-update-release',
      'failed',
    ]);
    fixture.service.dispose();
  });

  it('audits a window that closes after external-navigation confirmation', async () => {
    const fixture = createFixture();
    const event = liveEvent();
    await handler(UPDATE_IPC_CHANNELS.check)(event, { channel: 'stable' });
    fixture.showMessageBox.mockImplementationOnce(() => {
      fixture.isDestroyed.mockReturnValue(true);
      return Promise.resolve({ response: 1 });
    });
    await expect(
      handler(UPDATE_IPC_CHANNELS.openRelease)(event, { releaseId: 10 }),
    ).resolves.toMatchObject({ ok: false });
    expect(fixture.operations.openExternal).not.toHaveBeenCalled();
    expect(fixture.appendAudit.mock.calls.at(-1)?.slice(0, 3)).toEqual([
      'external-navigation',
      'open-update-release',
      'failed',
    ]);
    fixture.service.dispose();
  });
});

describe('strict update version ordering', () => {
  it('handles huge components and SemVer prerelease precedence without Number overflow', () => {
    expect(compareVersions('999999999999999999999.0.0', '2.0.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0-rc.2')).toBe(1);
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareVersions('1.0.0+build.9', '1.0.0+build.1')).toBe(0);
    expect(() => compareVersions('01.0.0', '1.0.0')).toThrow(/semantic versioning/u);
    expect(() => compareVersions('1.0.0-01', '1.0.0')).toThrow(/semantic versioning/u);
  });
});

function createOperations() {
  return {
    request: vi.fn<UpdateOperations['request']>(() =>
      Promise.resolve(
        JSON.stringify([
          {
            ...RELEASE,
            id: 11,
            tag_name: 'v0.3.0-rc.1',
            html_url: RELEASE.html_url.replace('v0.2.0', 'v0.3.0-rc.1'),
            prerelease: true,
          },
          RELEASE,
        ]),
      ),
    ),
    openExternal: vi.fn<UpdateOperations['openExternal']>(() => Promise.resolve()),
  } satisfies UpdateOperations;
}

function createFixture(
  options: { body?: string; operations?: ReturnType<typeof createOperations> } = {},
) {
  const isDestroyed = vi.fn(() => false);
  const parent = { isDestroyed } as unknown as BrowserWindow;
  electronMock.fromWebContents.mockReturnValue(parent);
  const operations = options.operations ?? createOperations();
  if (options.body !== undefined) operations.request.mockResolvedValue(options.body);
  const showMessageBox = vi.fn(() => Promise.resolve({ response: 1 }));
  const appendAudit =
    vi.fn<
      (
        category: string,
        action: string,
        outcome: 'allowed' | 'denied' | 'failed',
        metadata: Record<string, unknown>,
      ) => void
    >();
  const service = new UpdateIpcService(
    { showMessageBox },
    { openExternal: vi.fn() },
    { appendAudit },
    () => '0.1.0',
    undefined,
    operations,
    () => new Date('2026-07-17T12:01:00.000Z'),
  );
  service.registerIpcHandlers();
  return { service, parent, isDestroyed, operations, showMessageBox, appendAudit };
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

function handler(channel: string) {
  const found = electronMock.handlers.get(channel);
  if (found === undefined) throw new Error(`Missing IPC handler ${channel}.`);
  return found;
}
