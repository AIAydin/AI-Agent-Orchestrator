import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserWindow, WebContentsView } from 'electron';

import { PreviewSurfaceRuntime, secureWritePng } from './runtime.js';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const URL = 'http://127.0.0.1:41000/app';
const BOUNDS = { x: 10, y: 20, width: 640, height: 480, visible: true };

describe('PreviewSurfaceRuntime', () => {
  let views: FakeView[];
  let parent: BrowserWindow;
  let dialog: {
    showSaveDialog: ReturnType<typeof vi.fn>;
    showMessageBox: ReturnType<typeof vi.fn>;
  };
  let shell: { openExternal: ReturnType<typeof vi.fn> };
  let savePng: ReturnType<typeof vi.fn>;
  let audit: ReturnType<typeof vi.fn>;
  let emit: ReturnType<typeof vi.fn>;
  let runtime: PreviewSurfaceRuntime;

  beforeEach(() => {
    views = [];
    parent = fakeParent();
    dialog = {
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
      showMessageBox: vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false }),
    };
    shell = { openExternal: vi.fn().mockResolvedValue(undefined) };
    savePng = vi.fn().mockResolvedValue(undefined);
    audit = vi.fn();
    emit = vi.fn();
    runtime = new PreviewSurfaceRuntime({
      dialog: dialog as never,
      shell: shell as never,
      emit,
      audit,
      createView: () => {
        const view = new FakeView();
        views.push(view);
        return view as unknown as WebContentsView;
      },
      savePng,
      now: () => new Date('2026-07-17T12:00:00.000Z'),
    });
  });

  it('creates two owner-bound surfaces per node and rejects a third', async () => {
    const first = await runtime.create('owner-a', parent, createInput(), URL);
    const second = await runtime.create('owner-a', parent, createInput(), URL);
    expect(first.surfaceId).not.toBe(second.surfaceId);
    expect(first.status).toBe('ready');
    await expect(runtime.create('owner-a', parent, createInput(), URL)).rejects.toThrow(
      'two live surfaces',
    );
    expect(() => runtime.console('owner-b', first.surfaceId)).toThrow('another renderer');
    expect(runtime.close('owner-a', first.surfaceId)).toBe(true);
    await expect(runtime.create('owner-a', parent, createInput(), URL)).resolves.toMatchObject({
      status: 'ready',
    });
  });

  it('reserves mobile surface slots before asynchronous touch setup can race the cap', async () => {
    const first = runtime.create(
      'owner-a',
      parent,
      { ...createInput(), touchEmulation: true },
      URL,
    );
    const second = runtime.create(
      'owner-a',
      parent,
      { ...createInput(), touchEmulation: true },
      URL,
    );
    await expect(
      runtime.create('owner-a', parent, { ...createInput(), touchEmulation: true }, URL),
    ).rejects.toThrow('two live surfaces');
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    runtime.closeNode('owner-a', PROJECT_ID, 'preview-node');
    expect(views.slice(0, 2).every((view) => view.webContents.destroyed)).toBe(true);
  });

  it('hides fully clipped native views and restores only renderer-approved visible bounds', async () => {
    const surface = await runtime.create('owner', parent, createInput(), URL);
    const view = views[0];
    const hidden = { x: 900, y: 900, width: 64, height: 64, visible: false } as const;
    expect(runtime.setBounds('owner', surface.surfaceId, hidden).bounds).toEqual(hidden);
    expect(view?.visible).toBe(false);
    expect(view?.bounds).toEqual(BOUNDS);

    const restored = { x: 40, y: 50, width: 320, height: 240, visible: true } as const;
    runtime.setBounds('owner', surface.surfaceId, restored);
    expect(view?.visible).toBe(true);
    expect(view?.bounds).toEqual(restored);
  });

  it('enforces the global cap and destroys every owner surface on cleanup', async () => {
    const created: Array<{ surfaceId: string }> = [];
    for (let index = 0; index < 8; index += 1) {
      created.push(
        await runtime.create(
          'owner-a',
          parent,
          { ...createInput(), nodeId: `preview-${String(index)}` },
          URL,
        ),
      );
    }
    await expect(
      runtime.create('owner-b', parent, { ...createInput(), nodeId: 'ninth' }, URL),
    ).rejects.toThrow('at most 8');
    runtime.closeOwner('owner-a');
    expect(views.every((view) => view.webContents.destroyed)).toBe(true);
    expect(() => runtime.console('owner-a', created[0]?.surfaceId ?? '')).toThrow(
      'another renderer',
    );
  });

  it('requires the exact runtime-authorized local URL before creating a view', async () => {
    await expect(
      runtime.create('owner', parent, createInput(), `${URL}?changed=1`),
    ).rejects.toThrow('not authorized');
    await expect(
      runtime.create(
        'owner',
        parent,
        { ...createInput(), url: 'https://example.com:41000/' },
        'https://example.com:41000/',
      ),
    ).rejects.toThrow('loopback');
    expect(views).toHaveLength(0);
  });

  it('enables real Chromium touch emulation and detaches it on close', async () => {
    const surface = await runtime.create(
      'owner',
      parent,
      { ...createInput(), touchEmulation: true },
      URL,
    );
    const browserDebugger = views[0]?.webContents.debugger;
    expect(surface.touchEmulation).toBe(true);
    expect(browserDebugger?.attach).toHaveBeenCalledWith('1.3');
    expect(browserDebugger?.sendCommand.mock.calls).toEqual([
      ['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }],
      ['Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }],
    ]);
    runtime.close('owner', surface.surfaceId);
    expect(browserDebugger?.detach).toHaveBeenCalledTimes(1);
  });

  it('fails mobile surface creation when Chromium touch emulation is unavailable', async () => {
    const failedView = new FakeView();
    failedView.webContents.debugger.failCommands = true;
    const failedRuntime = new PreviewSurfaceRuntime({
      dialog: dialog as never,
      shell: shell as never,
      emit: vi.fn(),
      createView: () => failedView as unknown as WebContentsView,
    });
    await expect(
      failedRuntime.create('owner', parent, { ...createInput(), touchEmulation: true }, URL),
    ).rejects.toThrow('touch emulation is unavailable');
    expect(failedView.webContents.debugger.detach).toHaveBeenCalledTimes(1);
    expect(failedView.webContents.destroyed).toBe(true);
  });

  it('cleans up when the owner closes during asynchronous touch setup', async () => {
    const closingView = new FakeView();
    let parentDestroyed = false;
    closingView.webContents.debugger.sendCommand.mockImplementationOnce(() => {
      parentDestroyed = true;
      return Promise.resolve({});
    });
    const addChildView = vi.fn();
    const removeChildView = vi.fn();
    const closingParent = {
      isDestroyed: () => parentDestroyed,
      contentView: { addChildView, removeChildView },
    } as unknown as BrowserWindow;
    const closingRuntime = new PreviewSurfaceRuntime({
      dialog: dialog as never,
      shell: shell as never,
      emit: vi.fn(),
      audit,
      createView: () => closingView as unknown as WebContentsView,
    });

    await expect(
      closingRuntime.create(
        'owner',
        closingParent,
        { ...createInput(), touchEmulation: true },
        URL,
      ),
    ).rejects.toThrow('owner closed while touch setup was pending');
    expect(addChildView).toHaveBeenCalledTimes(1);
    expect(removeChildView).not.toHaveBeenCalled();
    expect(closingView.webContents.debugger.isAttached()).toBe(false);
    expect(closingView.webContents.destroyed).toBe(true);
  });

  it('cleans up when attaching the native view to its owner fails', async () => {
    const rejectedView = new FakeView();
    const removeChildView = vi.fn();
    const rejectedParent = {
      isDestroyed: () => false,
      contentView: {
        addChildView: vi.fn(() => {
          throw new Error('native view rejected');
        }),
        removeChildView,
      },
    } as unknown as BrowserWindow;
    const rejectedRuntime = new PreviewSurfaceRuntime({
      dialog: dialog as never,
      shell: shell as never,
      emit: vi.fn(),
      audit,
      createView: () => rejectedView as unknown as WebContentsView,
    });

    await expect(
      rejectedRuntime.create('owner', rejectedParent, createInput(), URL),
    ).rejects.toThrow('native view rejected');
    expect(removeChildView).not.toHaveBeenCalled();
    expect(rejectedView.webContents.destroyed).toBe(true);
    expect(rejectedView.webContents.session.requestPolicy).toBeUndefined();
  });

  it('captures bounded in-memory console output with redacted sources', async () => {
    const surface = await runtime.create('owner', parent, createInput(), URL);
    for (let index = 0; index < 510; index += 1) {
      views[0]?.webContents.emit(
        'console-message',
        {},
        index === 509 ? 3 : 1,
        `message-${String(index)}`,
        7,
        'http://127.0.0.1:41000/app.js?token=secret#private',
      );
    }
    const captured = runtime.console('owner', surface.surfaceId);
    expect(captured.entries).toHaveLength(500);
    expect(captured.truncated).toBe(true);
    expect(captured.entries.at(-1)).toMatchObject({
      level: 'error',
      source: 'http://127.0.0.1:41000/app.js',
    });
    expect(JSON.stringify(captured)).not.toContain('secret');
  });

  it('coalesces a console burst into one bounded renderer notification', async () => {
    vi.useFakeTimers();
    try {
      const surface = await runtime.create('owner', parent, createInput(), URL);
      const view = views[0];
      for (let index = 0; index < 1_000; index += 1) {
        view?.webContents.emit('console-message', {}, 1, `burst-${String(index)}`, 1, URL);
      }
      expect(
        emit.mock.calls.filter((call) => (call[1] as { type?: string }).type === 'console'),
      ).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(
        emit.mock.calls.filter((call) => (call[1] as { type?: string }).type === 'console'),
      ).toHaveLength(1);
      expect(runtime.console('owner', surface.surfaceId).entries).toHaveLength(500);
      runtime.close('owner', surface.surfaceId);
      view?.webContents.emit('console-message', {}, 1, 'after-close', 1, URL);
      await vi.advanceTimersByTimeAsync(100);
      expect(
        emit.mock.calls.filter((call) => (call[1] as { type?: string }).type === 'console'),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('audits allowed and denied browser history navigation without URL disclosure', async () => {
    const surface = await runtime.create('owner', parent, createInput(), URL);
    const history = views[0]?.webContents.navigationHistory;
    expect(() =>
      runtime.history('owner', { surfaceId: surface.surfaceId, direction: 'back' }),
    ).toThrow('no earlier page');
    if (history) history.canGoBack = () => true;
    expect(
      runtime.history('owner', { surfaceId: surface.surfaceId, direction: 'back' }),
    ).toMatchObject({ surfaceId: surface.surfaceId });
    expect(history?.goBack).toHaveBeenCalledTimes(1);
    const historyAudits = audit.mock.calls.filter((call) => call[0] === 'history');
    expect(historyAudits.map((call) => String(call[1]))).toEqual(['denied', 'allowed']);
    expect(JSON.stringify(historyAudits)).not.toContain(URL);
  });

  it('uses cancel-default native review for screenshots and external opening', async () => {
    const surface = await runtime.create('owner', parent, createInput(), URL);
    await expect(runtime.screenshot('owner', surface.surfaceId)).resolves.toEqual({
      saved: false,
      width: 0,
      height: 0,
    });
    expect(savePng).not.toHaveBeenCalled();

    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/preview.png' });
    await expect(runtime.screenshot('owner', surface.surfaceId)).resolves.toEqual({
      saved: true,
      width: 640,
      height: 480,
    });
    expect(savePng).toHaveBeenCalledWith('/tmp/preview.png', Buffer.from('png'));

    await expect(runtime.openExternal('owner', surface.surfaceId)).resolves.toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();
    dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    await expect(runtime.openExternal('owner', surface.surfaceId)).resolves.toBe(true);
    expect(shell.openExternal).toHaveBeenCalledWith(URL, { activate: true });
    expect(dialog.showMessageBox.mock.calls.at(-1)?.[1]).toMatchObject({
      buttons: ['Cancel', 'Open in browser'],
      defaultId: 0,
      cancelId: 0,
      detail: URL,
    });
    const auditText = JSON.stringify(audit.mock.calls);
    expect(auditText).not.toContain('/tmp/preview.png');
    expect(auditText).not.toContain(URL);
    expect(auditText).toContain('open-external');
  });

  it.runIf(process.platform !== 'win32')(
    'refuses to follow a screenshot destination symlink without O_NOFOLLOW support',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'forgeboard-preview-screenshot-'));
      try {
        const target = join(directory, 'target.txt');
        const link = join(directory, 'selected.png');
        await writeFile(target, 'preserve-me', 'utf8');
        await symlink(target, link);
        dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: link });
        const secureRuntime = new PreviewSurfaceRuntime({
          dialog: dialog as never,
          shell: shell as never,
          emit: vi.fn(),
          audit,
          createView: () => new FakeView() as unknown as WebContentsView,
          savePng: async (path, data) => await secureWritePng(path, data, 'win32'),
        });
        const surface = await secureRuntime.create('owner', parent, createInput(), URL);
        await expect(secureRuntime.screenshot('owner', surface.surfaceId)).rejects.toThrow();
        await expect(readFile(target, 'utf8')).resolves.toBe('preserve-me');
        expect(JSON.stringify(audit.mock.calls)).not.toContain(link);
        secureRuntime.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('denies permissions, popups, downloads, and cross-origin requests', async () => {
    await runtime.create('owner', parent, createInput(), URL);
    const view = views[0];
    expect(view?.webContents.windowOpenHandler?.({ url: 'https://example.com' })).toEqual({
      action: 'deny',
    });
    expect(view?.webContents.session.permissionCheck?.()).toBe(false);
    let permission = true;
    view?.webContents.session.permissionRequest?.({}, 'camera', (allowed: boolean) => {
      permission = allowed;
    });
    expect(permission).toBe(false);
    expect(view?.webContents.session.requestPolicy?.('https://example.com/private')).toEqual({
      cancel: true,
    });
    expect(view?.webContents.session.requestPolicy?.('ws://127.0.0.1:41000/socket')).toEqual({
      cancel: false,
    });
  });
});

function createInput() {
  return {
    projectId: PROJECT_ID,
    nodeId: 'preview-node',
    url: URL,
    bounds: BOUNDS,
    touchEmulation: false,
  };
}

class FakeView {
  readonly webContents = new FakeWebContents();
  bounds = BOUNDS;
  visible = true;
  setBounds(bounds: Omit<typeof BOUNDS, 'visible'>): void {
    this.bounds = { ...bounds, visible: this.visible };
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
  }
}

class FakeWebContents extends EventEmitter {
  readonly session = new FakeSession();
  readonly debugger = new FakeDebugger();
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  url = 'about:blank';
  destroyed = false;
  windowOpenHandler?: (details: { url: string }) => { action: 'deny' };
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void {
    this.windowOpenHandler = handler;
  }
  loadURL(url: string): Promise<void> {
    this.url = url;
    this.emit('did-start-loading');
    this.emit('did-finish-load');
    return Promise.resolve();
  }
  getURL(): string {
    return this.url;
  }
  reload(): void {
    this.emit('did-start-loading');
    this.emit('did-finish-load');
  }
  capturePage() {
    return Promise.resolve({
      isEmpty: () => false,
      getSize: () => ({ width: 640, height: 480 }),
      toPNG: () => Buffer.from('png'),
    });
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  close(): void {
    this.destroyed = true;
  }
}

class FakeDebugger extends EventEmitter {
  attached = false;
  failCommands = false;
  readonly attach = vi.fn(() => {
    this.attached = true;
  });
  readonly detach = vi.fn(() => {
    this.attached = false;
    this.emit('detach', {}, 'target closed');
  });
  readonly sendCommand = vi.fn(() => {
    if (this.failCommands) return Promise.reject(new Error('CDP unavailable'));
    return Promise.resolve({});
  });
  isAttached(): boolean {
    return this.attached;
  }
}

class FakeSession extends EventEmitter {
  permissionCheck?: () => boolean;
  permissionRequest?: (
    contents: unknown,
    permission: string,
    callback: (allowed: boolean) => void,
  ) => void;
  requestPolicy?: (url: string) => { cancel: boolean };
  readonly webRequest = {
    onBeforeRequest: (
      filterOrListener: unknown,
      maybeListener?: (
        details: { url: string },
        callback: (result: { cancel: boolean }) => void,
      ) => void,
    ) => {
      if (!maybeListener) {
        delete this.requestPolicy;
        return;
      }
      this.requestPolicy = (url) => {
        let result = { cancel: false };
        maybeListener({ url }, (next) => {
          result = next;
        });
        return result;
      };
    },
  };
  setPermissionCheckHandler(handler: (() => boolean) | null): void {
    if (handler === null) delete this.permissionCheck;
    else this.permissionCheck = handler;
  }
  setPermissionRequestHandler(
    handler:
      | ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void)
      | null,
  ): void {
    if (handler === null) delete this.permissionRequest;
    else this.permissionRequest = handler;
  }
}

function fakeParent(): BrowserWindow {
  return {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  } as unknown as BrowserWindow;
}
