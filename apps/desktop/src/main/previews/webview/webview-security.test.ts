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
  userAgent = 'Mozilla/5.0 Electron/38.0.0 Artemis/1.0.0 Chrome/140.0.0.0';
  permissionCheck: (() => boolean) | null = null;
  permissionRequest:
    | ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void)
    | null = null;
  setPermissionCheckHandler(handler: FakeSession['permissionCheck']): void {
    this.permissionCheck = handler;
  }
  setPermissionRequestHandler(handler: FakeSession['permissionRequest']): void {
    this.permissionRequest = handler;
  }
  getUserAgent(): string {
    return this.userAgent;
  }
  setUserAgent(userAgent: string): void {
    this.userAgent = userAgent;
  }
}

class FakeGuestContents extends EventEmitter {
  windowOpenHandler:
    | ((details: { url: string }) => {
        action: string;
        overrideBrowserWindowOptions?: {
          webPreferences?: Record<string, unknown>;
        };
      })
    | null = null;
  private destroyed = false;
  loadURL = vi.fn((url: string) => {
    void url;
    return Promise.resolve();
  });
  constructor(
    private readonly guestSession: FakeSession,
    private readonly type: string = 'webview',
  ) {
    super();
  }
  get session(): FakeSession {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    return this.guestSession;
  }
  destroy(): void {
    this.destroyed = true;
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
    allowedOriginForGuestSession: () => null,
    authenticationEnabledForGuestSession: () => false,
    partitionForGuestSession: () => null,
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
    await vi.waitFor(() =>
      expect(options.audit).toHaveBeenCalledWith(
        'webview-window-open',
        'denied',
        expect.objectContaining({ reason: 'unsupported-scheme' }),
      ),
    );
    expect(options.confirmOpenExternal).not.toHaveBeenCalled();
    expect(options.openExternal).not.toHaveBeenCalled();
  });

  it('does not open the link when the native confirmation is cancelled', async () => {
    const { options, attach } = createHarness({
      confirmOpenExternal: vi.fn(() => Promise.resolve(false)),
    });
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

  it('URL mode opens popup-style HTTP links in the same hardened preview tab', async () => {
    const browserSession = new FakeSession();
    const { options, attach } = createHarness({
      allowedOriginForGuestSession: (session) =>
        (session as unknown) === (browserSession as unknown) ? 'https://www.google.com' : null,
    });
    const contents = attach(browserSession);
    expect(contents.windowOpenHandler?.({ url: 'https://www.granola.ai/' })).toEqual({
      action: 'deny',
    });
    await vi.waitFor(() =>
      expect(contents.loadURL).toHaveBeenCalledWith('https://www.granola.ai/'),
    );
    expect(options.confirmOpenExternal).not.toHaveBeenCalled();
    expect(options.openExternal).not.toHaveBeenCalled();
  });

  it('authentication mode allows a hardened OAuth window in the same persistent session', () => {
    const browserSession = new FakeSession();
    const onGuestCreated = vi.fn();
    const { options, attach } = createHarness({
      allowedOriginForGuestSession: (session) =>
        (session as unknown) === (browserSession as unknown) ? 'https://miro.com' : null,
      authenticationEnabledForGuestSession: (session) =>
        (session as unknown) === (browserSession as unknown),
      partitionForGuestSession: (session) =>
        (session as unknown) === (browserSession as unknown) ? 'persist:preview:p1:n1' : null,
      onGuestCreated,
    });
    const contents = attach(browserSession);

    const windowDecision = contents.windowOpenHandler?.({
      url: 'https://accounts.google.com/signin',
    });
    expect(windowDecision).toMatchObject({
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
        },
      },
    });
    expect(browserSession.userAgent).not.toContain('Electron/');
    expect(browserSession.userAgent).not.toContain('Artemis/');
    expect(contents.loadURL).not.toHaveBeenCalled();
    expect(options.openExternal).not.toHaveBeenCalled();
    expect(onGuestCreated).toHaveBeenCalledWith('persist:preview:p1:n1', contents);
  });

  it('registers a guest whose partition resolves only after attach, exactly once', () => {
    const guestSession = new FakeSession();
    const onGuestCreated = vi.fn();
    let attached = false;
    const { attach } = createHarness({
      partitionForGuestSession: (session) =>
        attached && (session as unknown) === (guestSession as unknown) ? 'preview:p1:n1' : null,
      onGuestCreated,
    });
    const contents = attach(guestSession);
    expect(onGuestCreated).not.toHaveBeenCalled();
    // The embedder's will-attach-webview guard records the partition after
    // guest creation; the first committed navigation then registers the guest.
    attached = true;
    contents.emit('did-navigate', {}, ALLOWED);
    contents.emit('did-navigate', {}, ALLOWED);
    expect(onGuestCreated).toHaveBeenCalledTimes(1);
    expect(onGuestCreated).toHaveBeenCalledWith('preview:p1:n1', contents);
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

  it('uses the captured session when a late request arrives after the guest is destroyed', () => {
    const browserSession = new FakeSession();
    const { attach } = createHarness({
      allowedOriginForGuestSession: (session) =>
        (session as unknown) === (browserSession as unknown) ? 'https://miro.com' : null,
    });
    const contents = attach(browserSession);
    contents.destroy();

    expect(() => browserSession.webRequest.allows('https://miro.com/app')).not.toThrow();
    expect(browserSession.webRequest.allows('https://miro.com/app')).toBe(true);
  });

  it('URL mode: permits safe cross-origin navigation before and after the first page commits', () => {
    const targetSession = new FakeSession();
    const { attach } = createHarness({
      allowedOriginForGuestSession: (session) =>
        (session as unknown) === (targetSession as unknown) ? 'https://app.staging.com' : null,
    });
    const contents = attach(targetSession);
    const prePin = { preventDefault: vi.fn() };
    contents.emit('will-navigate', prePin, 'https://app.staging.com/dashboard');
    expect(prePin.preventDefault).not.toHaveBeenCalled();
    contents.emit('did-navigate', {}, 'https://app.staging.com/dashboard');
    const samePage = { preventDefault: vi.fn() };
    contents.emit('will-navigate', samePage, 'https://app.staging.com/other-page');
    expect(samePage.preventDefault).not.toHaveBeenCalled();
    const otherOrigin = { preventDefault: vi.fn() };
    contents.emit('will-navigate', otherOrigin, 'https://evil.example.com/');
    expect(otherOrigin.preventDefault).not.toHaveBeenCalled();
    const crossOriginFrame = {
      url: 'https://accounts.example.com/sign-in',
      preventDefault: vi.fn(),
    };
    contents.emit('will-frame-navigate', crossOriginFrame);
    expect(crossOriginFrame.preventDefault).not.toHaveBeenCalled();
    const crossOriginRedirect = { preventDefault: vi.fn() };
    contents.emit('will-redirect', crossOriginRedirect, 'https://www.example.com/');
    expect(crossOriginRedirect.preventDefault).not.toHaveBeenCalled();
    const unsafeScheme = { preventDefault: vi.fn() };
    contents.emit('will-navigate', unsafeScheme, 'file:///etc/passwd');
    expect(unsafeScheme.preventDefault).toHaveBeenCalled();
  });

  it('URL mode: the guest session request filter allows a cross-origin subresource that loopback mode would cancel', () => {
    const externalSession = new FakeSession();
    const { attach } = createHarness({
      allowedOriginForGuestSession: (session) =>
        (session as unknown) === (externalSession as unknown) ? 'https://app.staging.com' : null,
    });
    const { session: loopbackSession } = attach(new FakeSession());
    attach(externalSession);
    expect(loopbackSession.webRequest.allows('https://cdn.example.com/font.woff2')).toBe(false);
    expect(externalSession.webRequest.allows('https://cdn.example.com/font.woff2')).toBe(true);
    // Credentialed URLs are still rejected in URL mode.
    expect(externalSession.webRequest.allows('https://user:pass@cdn.example.com/x')).toBe(false);
  });

  it('guest hardening (no preload, contextIsolation, sandbox) is unaffected by the configured origin', () => {
    const { attach } = createHarness({
      allowedOriginForGuestSession: () => 'https://app.staging.com',
    });
    const { session } = attach();
    expect(session.permissionCheck?.()).toBe(false);
    const download = { preventDefault: vi.fn() };
    session.emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalled();
    const preferences: Record<string, unknown> = {
      contextIsolation: false,
      sandbox: false,
    };
    hardenAttachingWebviewPreferences(preferences);
    expect(preferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    });
  });
});

describe('shouldAttachPreviewWebview', () => {
  it('requires a preview partition, no preload, and a loopback (or blank) src', () => {
    expect(shouldAttachPreviewWebview({ partition: 'preview:p1:n1', src: ALLOWED })).toBe(true);
    expect(shouldAttachPreviewWebview({ partition: 'preview:p1:n1' })).toBe(true);
    expect(
      shouldAttachPreviewWebview({
        partition: 'persist:preview:p1:n1',
        src: ALLOWED,
      }),
    ).toBe(true);
    expect(shouldAttachPreviewWebview({ partition: 'other', src: ALLOWED })).toBe(false);
    expect(shouldAttachPreviewWebview({ src: ALLOWED })).toBe(false);
    expect(
      shouldAttachPreviewWebview({
        partition: 'preview:p1:n1',
        src: 'https://example.com/',
      }),
    ).toBe(false);
    expect(
      shouldAttachPreviewWebview({
        partition: 'preview:p1:n1',
        src: ALLOWED,
        preload: '/tmp/x.js',
      }),
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

  it('rejects every external origin because internet pages belong in the Chrome companion', () => {
    expect(
      shouldAttachPreviewWebview({
        partition: 'preview:p1:n1',
        src: 'https://app.staging.com/dashboard',
      }),
    ).toBe(false);
    expect(
      shouldAttachPreviewWebview({
        partition: 'preview:p1:n1',
        src: 'https://evil.example.com/',
      }),
    ).toBe(false);
    expect(
      shouldAttachPreviewWebview({
        partition: 'preview:p1:n2',
        src: 'https://app.staging.com/dashboard',
      }),
    ).toBe(false);
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

  it('allowedGuestNavigation uses the configured origin as browser-mode authority', () => {
    expect(
      allowedGuestNavigation('https://app.staging.com/', null, 'https://app.staging.com'),
    ).toBe(true);
    expect(
      allowedGuestNavigation('https://evil.example.com/', null, 'https://app.staging.com'),
    ).toBe(true);
    expect(
      allowedGuestNavigation('https://user:secret@example.com/', null, 'https://app.staging.com'),
    ).toBe(false);
    expect(allowedGuestNavigation('file:///etc/passwd', null, 'https://app.staging.com')).toBe(
      false,
    );
    expect(
      allowedGuestNavigation(
        'data:text/html,<script>location="https://example.com"</script>',
        null,
        'https://app.staging.com',
      ),
    ).toBe(false);
    // Loopback stays allowed regardless of a configured external origin.
    expect(allowedGuestNavigation(ALLOWED, null, 'https://app.staging.com')).toBe(true);
  });

  it('isAllowedGuestRequest rejects credentials and non-loopback hosts', () => {
    expect(isAllowedGuestRequest('http://user:pass@127.0.0.1:5173/')).toBe(false);
    expect(isAllowedGuestRequest('http://10.0.0.5:5173/')).toBe(false);
    expect(isAllowedGuestRequest('wss://127.0.0.1:5173/socket')).toBe(true);
  });

  it('isAllowedGuestRequest: URL mode allows any http(s)/ws(s) subresource (no credentials) that loopback mode rejects', () => {
    expect(
      isAllowedGuestRequest('https://cdn.example.com/font.woff2', 'https://app.staging.com'),
    ).toBe(true);
    expect(isAllowedGuestRequest('wss://api.example.com/socket', 'https://app.staging.com')).toBe(
      true,
    );
    expect(
      isAllowedGuestRequest('https://user:pass@cdn.example.com/x', 'https://app.staging.com'),
    ).toBe(false);
    expect(isAllowedGuestRequest('file:///etc/passwd', 'https://app.staging.com')).toBe(false);
    // Loopback mode (no configured origin) is unaffected — byte-for-byte unchanged.
    expect(isAllowedGuestRequest('https://cdn.example.com/font.woff2')).toBe(false);
  });
});
