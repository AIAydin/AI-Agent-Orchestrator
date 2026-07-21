import { createHash } from 'node:crypto';

import type { Session, WebContents } from 'electron';

import { isPreviewWebviewPartition } from '../../../shared/preview/webview-partition.js';
import { isAllowedSurfaceRequest, validatedSurfaceUrl } from '../surface/url-policy.js';

export interface PreviewWebviewSecurityOptions {
  confirmOpenExternal(url: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  audit(action: string, outcome: 'allowed' | 'denied', metadata: Record<string, unknown>): void;
}

interface WebContentsCreatedApp {
  on(
    event: 'web-contents-created',
    listener: (event: unknown, contents: WebContents) => void,
  ): unknown;
}

/** Embedder-side attach guard: preview partitions only, no preload, loopback (or blank) src. */
export function shouldAttachPreviewWebview(params: Record<string, unknown>): boolean {
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
  return allowedGuestNavigation(src, null);
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
 * Content-initiated navigation policy. Before a loopback origin is pinned any
 * validated loopback URL (plus about:blank/data:) is allowed; once pinned,
 * navigation must stay on that exact origin ("that node's port").
 */
export function allowedGuestNavigation(candidate: string, allowed: URL | null): boolean {
  if (allowed !== null) return isAllowedSurfaceRequest(candidate, allowed);
  if (candidate === 'about:blank' || candidate.startsWith('data:')) return true;
  try {
    validatedSurfaceUrl(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Session-level request filter: loopback-only, with ws/wss mapped onto http/https validation. */
export function isAllowedGuestRequest(candidate: string): boolean {
  if (candidate === 'about:blank' || candidate.startsWith('data:') || candidate.startsWith('blob:')) {
    return true;
  }
  const normalized = candidate.startsWith('wss:')
    ? `https:${candidate.slice(4)}`
    : candidate.startsWith('ws:')
      ? `http:${candidate.slice(3)}`
      : candidate;
  try {
    validatedSurfaceUrl(normalized);
    return true;
  } catch {
    return false;
  }
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
    contents.setWindowOpenHandler(({ url }) => {
      void handoffWindowOpen(url, options);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!allowedGuestNavigation(url, allowed)) {
        event.preventDefault();
        options.audit('webview-navigate', 'denied', { urlSha256: sha256(url) });
      }
    });
    contents.on('will-frame-navigate', (event) => {
      if (!allowedGuestNavigation(event.url, allowed)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!allowedGuestNavigation(url, allowed)) event.preventDefault();
    });
    contents.on('did-navigate', (_event, url) => {
      try {
        allowed = validatedSurfaceUrl(url);
      } catch {
        allowed = null;
      }
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    hardenGuestSession(contents.session, hardenedSessions);
  });
}

function hardenGuestSession(guestSession: Session, hardened: WeakSet<Session>): void {
  if (hardened.has(guestSession)) return;
  hardened.add(guestSession);
  guestSession.setPermissionCheckHandler(() => false);
  guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  guestSession.on('will-download', (event) => event.preventDefault());
  guestSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => callback({ cancel: !isAllowedGuestRequest(details.url) }),
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
