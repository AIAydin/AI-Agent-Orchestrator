import { createHash } from 'node:crypto';

import type { Session, WebContents } from 'electron';

import { isPreviewWebviewPartition } from '../../../shared/preview/webview-partition.js';
import { isAllowedSurfaceRequest, validatedSurfaceUrl } from '../surface/url-policy.js';

export interface PreviewWebviewSecurityOptions {
  confirmOpenExternal(url: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  audit(action: string, outcome: 'allowed' | 'denied', metadata: Record<string, unknown>): void;
  /**
   * The externally configured origin for a guest's session (URL mode), or
   * `null` when the guest is in loopback/dev-server mode. Looked up fresh on
   * every navigation/request decision — the mode can change over the life of
   * a partition as the node's address field is edited.
   */
  allowedOriginForGuestSession(guestSession: Session): string | null;
}

interface WebContentsCreatedApp {
  on(
    event: 'web-contents-created',
    listener: (event: unknown, contents: WebContents) => void,
  ): unknown;
}

/** Embedder-side attach guard: preview partitions only, no preload, loopback (or configured origin) src. */
export function shouldAttachPreviewWebview(
  params: Record<string, unknown>,
  allowedOriginForPartition: (partition: string) => string | null = () => null,
): boolean {
  if (!isPreviewWebviewPartition(params['partition'])) return false;
  // Electron always includes preload/preloadURL in attach params, defaulting to
  // an empty string when the renderer sets none. Only a NON-empty value means an
  // actual preload was requested — reject those; the empty-string default is fine
  // (and is force-cleared by hardenAttachingWebviewPreferences anyway).
  const preload = params['preload'];
  const preloadURL = params['preloadURL'];
  if (
    (typeof preload === 'string' && preload !== '') ||
    (typeof preloadURL === 'string' && preloadURL !== '')
  ) {
    return false;
  }
  const src = typeof params['src'] === 'string' ? params['src'] : 'about:blank';
  const configuredOrigin = allowedOriginForPartition(params['partition']);
  return allowedGuestNavigation(src, null, configuredOrigin);
}

/** Force-harden the guest's webPreferences regardless of what the renderer requested. */
export function hardenAttachingWebviewPreferences(webPreferences: Record<string, unknown>): void {
  delete webPreferences['preload'];
  delete webPreferences['preloadURL'];
  webPreferences['nodeIntegration'] = false;
  webPreferences['nodeIntegrationInSubFrames'] = false;
  webPreferences['nodeIntegrationInWorker'] = false;
  webPreferences['contextIsolation'] = true;
  webPreferences['sandbox'] = true;
  webPreferences['webSecurity'] = true;
  webPreferences['allowRunningInsecureContent'] = false;
  webPreferences['experimentalFeatures'] = false;
  webPreferences['enableBlinkFeatures'] = '';
  webPreferences['webviewTag'] = false;
  webPreferences['spellcheck'] = false;
}

/**
 * Content-initiated navigation policy. Before an origin is pinned, any
 * validated loopback URL (plus about:blank/data:) is allowed, and — when the
 * node has a configured external origin (URL mode) — that origin too. Once
 * pinned, navigation must stay on that exact origin ("that node's port" or
 * "that node's configured site").
 */
export function allowedGuestNavigation(
  candidate: string,
  allowed: URL | null,
  configuredOrigin: string | null = null,
): boolean {
  if (allowed !== null) return isAllowedSurfaceRequest(candidate, allowed);
  if (candidate === 'about:blank' || candidate.startsWith('data:')) return true;
  try {
    validatedSurfaceUrl(candidate, { allowedOrigin: configuredOrigin ?? undefined });
    return true;
  } catch {
    return false;
  }
}

/**
 * Session-level request filter. In loopback mode (`configuredOrigin === null`,
 * the default) this is byte-for-byte the original strict loopback-only
 * cancel, with ws/wss mapped onto http/https validation. In URL mode (an
 * external origin is configured for this guest's partition) subresource
 * requests are far less restrictive — real sites load CDN/font/API resources
 * from many third-party origins — but still require http(s)/ws(s) and forbid
 * embedded credentials.
 */
export function isAllowedGuestRequest(
  candidate: string,
  configuredOrigin: string | null = null,
): boolean {
  if (
    candidate === 'about:blank' ||
    candidate.startsWith('data:') ||
    candidate.startsWith('blob:')
  ) {
    return true;
  }
  const normalized = candidate.startsWith('wss:')
    ? `https:${candidate.slice(4)}`
    : candidate.startsWith('ws:')
      ? `http:${candidate.slice(3)}`
      : candidate;
  if (configuredOrigin === null) {
    try {
      validatedSurfaceUrl(normalized);
      return true;
    } catch {
      return false;
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

export function installPreviewWebviewSecurity(
  app: WebContentsCreatedApp,
  options: PreviewWebviewSecurityOptions,
): void {
  const hardenedSessions = new WeakSet<Session>();
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    // Pinned loopback origin: null until the first committed load, refreshed on
    // every commit. Embedder-initiated loads (src/loadURL) do not fire
    // will-navigate, so they re-pin; content-initiated navigation must match.
    let allowed: URL | null = null;
    const configuredOrigin = (): string | null =>
      options.allowedOriginForGuestSession(contents.session);
    contents.setWindowOpenHandler(({ url }) => {
      void handoffWindowOpen(url, options);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!allowedGuestNavigation(url, allowed, configuredOrigin())) {
        event.preventDefault();
        options.audit('webview-navigate', 'denied', { urlSha256: sha256(url) });
      }
    });
    contents.on('will-frame-navigate', (event) => {
      if (!allowedGuestNavigation(event.url, allowed, configuredOrigin())) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!allowedGuestNavigation(url, allowed, configuredOrigin())) event.preventDefault();
    });
    contents.on('did-navigate', (_event, url) => {
      try {
        allowed = validatedSurfaceUrl(url, { allowedOrigin: configuredOrigin() ?? undefined });
      } catch {
        allowed = null;
      }
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    hardenGuestSession(contents.session, hardenedSessions, configuredOrigin);
  });
}

function hardenGuestSession(
  guestSession: Session,
  hardened: WeakSet<Session>,
  configuredOrigin: () => string | null,
): void {
  if (hardened.has(guestSession)) return;
  hardened.add(guestSession);
  guestSession.setPermissionCheckHandler(() => false);
  guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  guestSession.on('will-download', (event) => event.preventDefault());
  guestSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) =>
      callback({ cancel: !isAllowedGuestRequest(details.url, configuredOrigin()) }),
  );
}

async function handoffWindowOpen(
  url: string,
  options: PreviewWebviewSecurityOptions,
): Promise<void> {
  if (!url.startsWith('http:') && !url.startsWith('https:')) {
    options.audit('webview-window-open', 'denied', { reason: 'unsupported-scheme' });
    return;
  }
  try {
    const approved = await options.confirmOpenExternal(url);
    if (!approved) {
      options.audit('webview-window-open', 'denied', { reason: 'confirmation-cancelled' });
      return;
    }
    options.audit('webview-window-open', 'allowed', { urlSha256: sha256(url) });
    await options.openExternal(url);
  } catch {
    options.audit('webview-window-open', 'denied', { reason: 'handoff-failed' });
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
