/* eslint-disable @typescript-eslint/unbound-method */
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  allowedGuestNavigation,
  hardenAttachingWebviewPreferences,
  installPreviewWebviewSecurity,
  isAllowedGuestRequest,
  shouldAttachPreviewWebview,
  type PreviewWebviewSecurityOptions,
} from './webview-security.js';

const ALLOWED = 'http://localhost:5173/';

class FakeWebRequest {
  listener:
    | ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void)
    | null = null;
  onBeforeRequest(_filter: { urls: string[] }, listener: FakeWebRequest['listener']): void {
    this.listener = listener;
  }
  allows(url: string): boolean {
    let cancelled = false;
    this.listener?.({ url }, (response) => {
      cancelled = response.cancel;
    });
    return !cancelled;
  }
}

class FakeSession extends EventEmitter {
  webRequest = new FakeWebRequest();
  permissionCheck: (() => boolean) | null = null;
  permissionRequest: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null =
    null;
  setPermissionCheckHandler(handler: FakeSession['permissionCheck']): void {
    this.permissionCheck = handler;
  }
  setPermissionRequestHandler(handler: FakeSession['permissionRequest']): void {
    this.permissionRequest = handler;
  }
}

class FakeGuestContents extends EventEmitter {
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
  constructor(
    public readonly session: FakeSession,
    private readonly type: string = 'webview',
  ) {
    super();
  }
  getType(): string {
    return this.type;
  }
  setWindowOpenHandler(handler: FakeGuestContents['windowOpenHandler']): void {
    this.windowOpenHandler = handler;
  }
}

function createHarness(overrides: Partial<PreviewWebviewSecurityOptions> = {}) {
  const app = new EventEmitter();
  const options: PreviewWebviewSecurityOptions = {
    confirmOpenExternal: vi.fn(() => Promise.resolve(true)),
    openExternal: vi.fn(() => Promise.resolve(undefined)),
    audit: vi.fn(),
    ...overrides,
  };
  installPreviewWebviewSecurity(app as never, options);
  const attach = (session = new FakeSession(), type = 'webview'): FakeGuestContents => {
    const contents = new FakeGuestContents(session, type);
    app.emit('web-contents-created', {}, contents);
    return contents;
  };
  return { options, attach };
}

describe('installPreviewWebviewSecurity', () => {
  it('leaves non-webview contents alone', () => {
    const { attach } = createHarness();
    const contents = attach(new FakeSession(), 'window');
    expect(contents.windowOpenHandler).toBeNull();
    expect(contents.session.webRequest.listener).toBeNull();
  });

  it('denies window.open and hands confirmed http(s) links to the system browser', async () => {
    const { options, attach } = createHarness();
    const contents = attach();
    expect(contents.windowOpenHandler?.({ url: 'https://example.com/docs' })).toEqual({
      action: 'deny',
    });
    await vi.waitFor(() =>
      expect(options.openExternal).toHaveBeenCalledWith('https://example.com/docs'),
    );
    expect(options.confirmOpenExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('never hands off non-http window.open targets', async () => {
    const { options, attach } = createHarness();
    const contents = attach();
    contents.windowOpenHandler?.({ url: 'file:///etc/passwd' });
    await vi.waitFor(() => expect(options.audit).toHaveBeenCalledWith('webview-window-open', 'denied', expect.objectContaining({ reason: 'unsupported-scheme' })));
    expect(options.confirmOpenExternal).not.toHaveBeenCalled();
    expect(options.openExternal).not.toHaveBeenCalled();
  });

  it('does not open the link when the native confirmation is cancelled', async () => {
    const { options, attach } = createHarness({ confirmOpenExternal: vi.fn(() => Promise.resolve(false)) });
    const contents = attach();
    contents.windowOpenHandler?.({ url: 'https://example.com/' });
    await vi.waitFor(() =>
      expect(options.audit).toHaveBeenCalledWith(
        'webview-window-open',
        'denied',
        expect.objectContaining({ reason: 'confirmation-cancelled' }),
      ),
    );
    expect(options.openExternal).not.toHaveBeenCalled();
  });

  it('never calls openExternal when the allowed-audit call itself throws (fail-closed)', async () => {
    const audit = vi.fn((action: string, outcome: 'allowed' | 'denied') => {
      if (action === 'webview-window-open' && outcome === 'allowed') {
        throw new Error('audit sink unavailable');
      }
    });
    const { options, attach } = createHarness({ audit });
    const contents = attach();
    contents.windowOpenHandler?.({ url: 'https://example.com/docs' });
    await vi.waitFor(() =>
      expect(options.audit).toHaveBeenCalledWith(
        'webview-window-open',
        'denied',
        expect.objectContaining({ reason: 'handoff-failed' }),
      ),
    );
    expect(options.openExternal).not.toHaveBeenCalled();
  });

  it('pins content navigation to the committed loopback origin', () => {
    const { attach } = createHarness();
    const contents = attach();
    contents.emit('did-navigate', {}, ALLOWED);
    const samePort = { preventDefault: vi.fn() };
    contents.emit('will-navigate', samePort, 'http://localhost:5173/deep/link');
    expect(samePort.preventDefault).not.toHaveBeenCalled();
    const otherPort = { preventDefault: vi.fn() };
    contents.emit('will-navigate', otherPort, 'http://localhost:9999/');
    expect(otherPort.preventDefault).toHaveBeenCalled();
    const external = { preventDefault: vi.fn() };
    contents.emit('will-navigate', external, 'https://example.com/');
    expect(external.preventDefault).toHaveBeenCalled();
  });

  it('allows only loopback before any origin is pinned', () => {
    const { attach } = createHarness();
    const contents = attach();
    const loopback = { preventDefault: vi.fn() };
    contents.emit('will-navigate', loopback, ALLOWED);
    expect(loopback.preventDefault).not.toHaveBeenCalled();
    const external = { preventDefault: vi.fn() };
    contents.emit('will-navigate', external, 'https://example.com/');
    expect(external.preventDefault).toHaveBeenCalled();
  });

  it('blocks disallowed frame navigations and redirects', () => {
    const { attach } = createHarness();
    const contents = attach();
    contents.emit('did-navigate', {}, ALLOWED);
    const frame = { url: 'https://example.com/frame', preventDefault: vi.fn() };
    contents.emit('will-frame-navigate', frame);
    expect(frame.preventDefault).toHaveBeenCalled();
    const redirect = { preventDefault: vi.fn() };
    contents.emit('will-redirect', redirect, 'https://example.com/');
    expect(redirect.preventDefault).toHaveBeenCalled();
  });

  it('prevents nested webviews inside guests', () => {
    const { attach } = createHarness();
    const contents = attach();
    const nested = { preventDefault: vi.fn() };
    contents.emit('will-attach-webview', nested);
    expect(nested.preventDefault).toHaveBeenCalled();
  });

  it('denies permissions and downloads on the guest session', () => {
    const { attach } = createHarness();
    const { session } = attach();
    expect(session.permissionCheck?.()).toBe(false);
    const callback = vi.fn();
    session.permissionRequest?.({}, 'media', callback);
    expect(callback).toHaveBeenCalledWith(false);
    const download = { preventDefault: vi.fn() };
    session.emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalled();
  });

  it('filters guest network requests to loopback, mapping websocket schemes', () => {
    const { attach } = createHarness();
    const { session } = attach();
    expect(session.webRequest.allows('http://127.0.0.1:5173/assets/app.js')).toBe(true);
    expect(session.webRequest.allows('ws://localhost:5173/hmr')).toBe(true);
    expect(session.webRequest.allows('https://example.com/analytics.js')).toBe(false);
  });

  it('hardens a shared guest session only once', () => {
    const { attach } = createHarness();
    const session = new FakeSession();
    const spy = vi.spyOn(session.webRequest, 'onBeforeRequest');
    attach(session);
    attach(session);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('shouldAttachPreviewWebview', () => {
  it('requires a preview partition, no preload, and a loopback (or blank) src', () => {
    expect(shouldAttachPreviewWebview({ partition: 'preview:p1:n1', src: ALLOWED })).toBe(true);
    expect(shouldAttachPreviewWebview({ partition: 'preview:p1:n1' })).toBe(true);
    expect(shouldAttachPreviewWebview({ partition: 'persist:preview:p1:n1', src: ALLOWED })).toBe(false);
    expect(shouldAttachPreviewWebview({ partition: 'other', src: ALLOWED })).toBe(false);
    expect(shouldAttachPreviewWebview({ src: ALLOWED })).toBe(false);
    expect(
      shouldAttachPreviewWebview({ partition: 'preview:p1:n1', src: 'https://example.com/' }),
    ).toBe(false);
    expect(
      shouldAttachPreviewWebview({ partition: 'preview:p1:n1', src: ALLOWED, preload: '/tmp/x.js' }),
    ).toBe(false);
    // Electron always sends preload/preloadURL, defaulting to '' when the
    // renderer requests none — the empty-string default must NOT block the attach.
    expect(
      shouldAttachPreviewWebview({
        partition: 'preview:p1:n1',
        src: ALLOWED,
        preload: '',
        preloadURL: '',
      }),
    ).toBe(true);
  });
});

describe('hardenAttachingWebviewPreferences', () => {
  it('strips preload and forces isolation flags', () => {
    const preferences: Record<string, unknown> = {
      preload: '/x.js',
      preloadURL: 'file:///x.js',
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    };
    hardenAttachingWebviewPreferences(preferences);
    expect(preferences['preload']).toBeUndefined();
    expect(preferences['preloadURL']).toBeUndefined();
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
  });
});

describe('url helpers', () => {
  it('allowedGuestNavigation admits blank/data before pin and enforces the pin after', () => {
    expect(allowedGuestNavigation('about:blank', null)).toBe(true);
    expect(allowedGuestNavigation('data:text/plain,hi', null)).toBe(true);
    expect(allowedGuestNavigation('https://example.com/', null)).toBe(false);
    const pinned = new URL(ALLOWED);
    expect(allowedGuestNavigation('http://localhost:5173/x', pinned)).toBe(true);
    expect(allowedGuestNavigation('http://localhost:9999/', pinned)).toBe(false);
  });

  it('isAllowedGuestRequest rejects credentials and non-loopback hosts', () => {
    expect(isAllowedGuestRequest('http://user:pass@127.0.0.1:5173/')).toBe(false);
    expect(isAllowedGuestRequest('http://10.0.0.5:5173/')).toBe(false);
    expect(isAllowedGuestRequest('wss://127.0.0.1:5173/socket')).toBe(true);
  });
});
