# Webview Preview Faces (sub-plan 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web-preview and mobile-preview nodes render the running local app directly on the node face — a single port input plus an in-DOM Electron `<webview>` — with main-process security hardening landing first, the full-screen preview modal migrated to the same webview component, and the native WebContentsView overlay path deleted.

**Architecture:** Main gains a narrow webview policy layer (`webviewTag` enabled for the one workspace window; a `will-attach-webview` guard; an app-level `web-contents-created` enforcer that pins each guest to its loopback origin and hardens its non-persistent per-node session `preview:<projectId>:<nodeId>`). The renderer gains a shared `PreviewWebview` wrapper used by both the new port-only `PreviewNodeFace` (rendered from `CanvasNode`, following the shipped `AgentSessionNode` face pattern) and the migrated `PreviewSurface`/`ComparisonSurface` modals. The dev-server lifecycle IPC (`previews:*`) is untouched and stays in the inspector panel; it is not surfaced on the face.

**Tech Stack:** Electron 36 (main: plain TS + vitest node env with hand-rolled fakes), React 19 + @xyflow/react v12 (renderer: vitest jsdom + testing-library), zod contracts, plain CSS with design tokens.

**Spec:** `docs/superpowers/specs/2026-07-20-content-on-node-design.md` §2a (port-only face revision).

## Plan-time findings

- `apps/desktop/src/main/index.ts:242` currently `preventDefault`s **all** webview attaches and `webviewTag` is not set (`:201-209`) — the spec assumed only "enable webviewTag"; both must change. The workspace window's own `setWindowOpenHandler` deny (`:232`) stays untouched.
- The spec says "will-navigate filtered through the existing url-policy.ts allowlist". `url-policy.ts` is origin-pinned per surface and needs an `allowed` URL that main cannot know up front for a renderer-created `<webview>`. Design: reuse `validatedSurfaceUrl` + `isAllowedSurfaceRequest` from `src/main/previews/surface/url-policy.ts`, pinning each guest to the loopback origin of its last embedder-initiated load (re-pinned on `did-navigate`, which content-initiated `will-navigate` cannot reach cross-port). This implements the revised policy "allow localhost/127.0.0.1 on that node's port; deny everything else". `url-policy.ts` + its test therefore **survive** the retirement task; only `runtime.ts` and `security-policy.ts` are deleted.
- Webview guests run in their own partitions, so neither the default-session request filter (`index.ts:260-263`) nor the renderer CSP governs them; the new per-partition session hardening replicates every `security-policy.ts` enforcement (mapping table in Task 1). Manual smoke must confirm the webview attaches under the `sandbox: true` embedder.
- Screenshot, the open-in-browser button, and debugger-based touch emulation exist only in the WebContentsView runtime and are dropped in the migrated modal; `e2e/preview.spec.ts:129-130` (screenshot) and the `Touchscreen mode on` badge assertions are updated in Task 5. External opening still exists as the confirmed `openExternal` handoff when guest content calls `window.open`.
- `ComparisonSurface` also renders through `DeviceFrameHost`, so partitions accept an optional slot suffix: `preview:<projectId>:<nodeId>:<comparison-left|comparison-right>`.
- `CanvasDocument` node `data` is `z.record(z.unknown())` (`src/shared/application/contracts.ts:936`), so the new `previewPort` field persists with no schema change.
- The face needs only `updateNodeData`, `recordHistory`, `graphReadOnly`, and `project` — all already on `AgentSessionContextValue`. No context changes and **no new IPC** are needed (the port-only revision removed the face's start/stop/navigate/open-external controls).

## Global Constraints

- **Execute in the Phase 2 worktree:** use the checkout for branch `feature/content-on-node`. Do not touch another session's checkout. The worktree's tree is clean — plain `git add <exact paths>` is fine, but still stage only the files each task names; never `git add -A`.
- **Never weaken existing WebContents security tests.** The workspace-window policies in `main/index.ts` (window-open deny, will-navigate lock, frame-navigation filter) and their behavior are untouched. When the WebContentsView surface tests are deleted in Task 6, every enforcement they covered (navigation denial, window.open denial, permission denial, download denial, request filtering, nested-webview denial) must already have equivalent-or-stronger coverage in `webview-security.test.ts` (Task 1). Update test expectations only to reflect the removed surface — never to loosen an assertion.
- Security ordering: Task 1 (hardening) must be merged before Tasks 4-5 render any `<webview>`. Task 6 (removal of the old path) runs last, after the modal migration. The app must build, typecheck, and pass tests after every task.
- `webviewTag` is enabled only in the workspace window's `webPreferences` (the app's single `BrowserWindow`); attach requests are denied unless the partition matches the preview pattern. Guest preferences are force-hardened (no preload, no nodeIntegration, contextIsolation on, sandbox on).
- Run scoped tests from the worktree root: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit <path>`. Typecheck: `corepack pnpm --dir apps/desktop typecheck` (from the worktree root).
- Commit message suffix (every commit): `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- All paths below are relative to `apps/desktop/` unless they start with `docs/`.

---

### Task 1: Main-process webview security hardening

**Files:**

- Create: `src/shared/preview/webview-partition.ts`
- Create: `src/shared/preview/webview-partition.test.ts`
- Create: `src/main/previews/webview/webview-security.ts`
- Create: `src/main/previews/webview/webview-security.test.ts`
- Modify: `src/main/index.ts` (`:4` electron import adds `shell`; `:201-209` webPreferences; `:242` attach guard; after `:68` install app-level policy)

**Interfaces:**

- Consumes: `validatedSurfaceUrl`, `isAllowedSurfaceRequest` from `src/main/previews/surface/url-policy.ts` (kept permanently).
- Produces (used by Tasks 3-5 renderer code and this task's wiring; names must match exactly):

```ts
// src/shared/preview/webview-partition.ts
export function previewWebviewPartition(
  projectId: string,
  nodeId: string,
  slot?: 'comparison-left' | 'comparison-right',
): string;
export function isPreviewWebviewPartition(candidate: unknown): candidate is string;

// src/main/previews/webview/webview-security.ts
export interface PreviewWebviewSecurityOptions {
  confirmOpenExternal(url: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  audit(action: string, outcome: 'allowed' | 'denied', metadata: Record<string, unknown>): void;
}
export function shouldAttachPreviewWebview(params: Record<string, unknown>): boolean;
export function hardenAttachingWebviewPreferences(webPreferences: Record<string, unknown>): void;
export function allowedGuestNavigation(candidate: string, allowed: URL | null): boolean;
export function isAllowedGuestRequest(candidate: string): boolean;
export function installPreviewWebviewSecurity(
  app: {
    on(
      event: 'web-contents-created',
      listener: (event: unknown, contents: Electron.WebContents) => void,
    ): unknown;
  },
  options: PreviewWebviewSecurityOptions,
): void;
```

**Security-policy parity audit** (`security-policy.ts` → new home; all covered by tests below):

| `installPreviewSurfaceSecurity` (WebContentsView)     | `webview-security.ts`                                     |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `setWindowOpenHandler` → deny                         | deny + confirmed `openExternal` handoff (http/https only) |
| `will-navigate` / `will-frame-navigate` origin filter | `allowedGuestNavigation` with per-guest origin pin        |
| `will-attach-webview` → prevent (no nesting)          | same, on every guest                                      |
| permission check/request → false                      | `hardenGuestSession`                                      |
| `will-download` → prevent                             | `hardenGuestSession`                                      |
| `webRequest.onBeforeRequest` loopback/ws filter       | `isAllowedGuestRequest`                                   |

- [ ] **Step 1: Write the failing tests.**

`src/shared/preview/webview-partition.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { isPreviewWebviewPartition, previewWebviewPartition } from './webview-partition.js';

describe('previewWebviewPartition', () => {
  it('builds non-persistent per-node partitions, with optional comparison slots', () => {
    expect(previewWebviewPartition('p1', 'n1')).toBe('preview:p1:n1');
    expect(previewWebviewPartition('p1', 'n1', 'comparison-left')).toBe(
      'preview:p1:n1:comparison-left',
    );
  });

  it('escapes separator characters inside ids', () => {
    expect(previewWebviewPartition('a:b', 'c:d')).toBe('preview:a%3Ab:c%3Ad');
    expect(isPreviewWebviewPartition(previewWebviewPartition('a:b', 'c:d'))).toBe(true);
  });
});

describe('isPreviewWebviewPartition', () => {
  it('accepts only the preview partition shape', () => {
    expect(isPreviewWebviewPartition('preview:p1:n1')).toBe(true);
    expect(isPreviewWebviewPartition('preview:p1:n1:comparison-right')).toBe(true);
    expect(isPreviewWebviewPartition('persist:preview:p1:n1')).toBe(false);
    expect(isPreviewWebviewPartition('preview:p1')).toBe(false);
    expect(isPreviewWebviewPartition('other:p1:n1')).toBe(false);
    expect(isPreviewWebviewPartition(undefined)).toBe(false);
  });
});
```

`src/main/previews/webview/webview-security.test.ts`:

```ts
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
  permissionRequest:
    | ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void)
    | null = null;
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
    confirmOpenExternal: vi.fn(async () => true),
    openExternal: vi.fn(async () => undefined),
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
    await Promise.resolve();
    expect(options.confirmOpenExternal).not.toHaveBeenCalled();
    expect(options.openExternal).not.toHaveBeenCalled();
    expect(options.audit).toHaveBeenCalledWith(
      'webview-window-open',
      'denied',
      expect.objectContaining({ reason: 'unsupported-scheme' }),
    );
  });

  it('does not open the link when the native confirmation is cancelled', async () => {
    const { options, attach } = createHarness({ confirmOpenExternal: vi.fn(async () => false) });
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
    expect(shouldAttachPreviewWebview({ partition: 'persist:preview:p1:n1', src: ALLOWED })).toBe(
      false,
    );
    expect(shouldAttachPreviewWebview({ partition: 'other', src: ALLOWED })).toBe(false);
    expect(shouldAttachPreviewWebview({ src: ALLOWED })).toBe(false);
    expect(
      shouldAttachPreviewWebview({ partition: 'preview:p1:n1', src: 'https://example.com/' }),
    ).toBe(false);
    expect(
      shouldAttachPreviewWebview({
        partition: 'preview:p1:n1',
        src: ALLOWED,
        preload: '/tmp/x.js',
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

  it('isAllowedGuestRequest rejects credentials and non-loopback hosts', () => {
    expect(isAllowedGuestRequest('http://user:pass@127.0.0.1:5173/')).toBe(false);
    expect(isAllowedGuestRequest('http://10.0.0.5:5173/')).toBe(false);
    expect(isAllowedGuestRequest('wss://127.0.0.1:5173/socket')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/shared/preview/webview-partition.test.ts apps/desktop/src/main/previews/webview/webview-security.test.ts`
Expected: FAIL — both modules not found.

- [ ] **Step 3: Implement the modules.**

`src/shared/preview/webview-partition.ts`:

```ts
/**
 * Session partition for in-DOM preview webviews. No `persist:` prefix — the
 * session is in-memory and dies with the guest. Ids are URI-encoded so the
 * colon-delimited shape stays parseable.
 */
const PARTITION_PATTERN = /^preview:[^:]+:[^:]+(?::(?:comparison-left|comparison-right))?$/;

export function previewWebviewPartition(
  projectId: string,
  nodeId: string,
  slot?: 'comparison-left' | 'comparison-right',
): string {
  const scope = `preview:${encodeURIComponent(projectId)}:${encodeURIComponent(nodeId)}`;
  return slot === undefined ? scope : `${scope}:${slot}`;
}

export function isPreviewWebviewPartition(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && PARTITION_PATTERN.test(candidate);
}
```

`src/main/previews/webview/webview-security.ts`:

```ts
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
  if (typeof params['preload'] === 'string' || typeof params['preloadURL'] === 'string') {
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
```

- [ ] **Step 4: Wire `src/main/index.ts`.**
  - Line 4: `import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';`
  - Add imports:

```ts
import {
  hardenAttachingWebviewPreferences,
  installPreviewWebviewSecurity,
  shouldAttachPreviewWebview,
} from './previews/webview/webview-security.js';
```

- In `createWindow` webPreferences (`:201-209`) add `webviewTag: true,` after `sandbox: true,`.
- Replace line 242 (`window.webContents.on('will-attach-webview', (event) => event.preventDefault());`) with:

```ts
// Webviews are allowed only for sandboxed, partition-scoped local previews.
window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
  if (!shouldAttachPreviewWebview(params as unknown as Record<string, unknown>)) {
    event.preventDefault();
    return;
  }
  hardenAttachingWebviewPreferences(webPreferences as unknown as Record<string, unknown>);
});
```

- In `whenReady` immediately after `services = registerIpcHandlers(store);` (`:68`):

```ts
installPreviewWebviewSecurity(app, {
  confirmOpenExternal: async (url) => {
    const parent = mainWindow;
    if (!parent || parent.isDestroyed()) return false;
    const decision = await dialog.showMessageBox(parent, {
      type: 'warning',
      title: 'Open link in your browser?',
      message: 'The preview wants to open a page outside Artemis.',
      detail: url,
      buttons: ['Cancel', 'Open in browser'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return decision.response === 1;
  },
  openExternal: async (url) => {
    await shell.openExternal(url, { activate: true });
  },
  audit: (action, outcome, metadata) => {
    try {
      store?.appendAudit('preview-webview', action, outcome, metadata);
    } catch {
      // Audit storage failure must not change an enforcement decision.
    }
  },
});
```

- [ ] **Step 5: Run tests + typecheck.**

Run the two test files from Step 2 → PASS. Run `corepack pnpm --dir apps/desktop typecheck` → clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/shared/preview/webview-partition.ts apps/desktop/src/shared/preview/webview-partition.test.ts apps/desktop/src/main/previews/webview/webview-security.ts apps/desktop/src/main/previews/webview/webview-security.test.ts apps/desktop/src/main/index.ts
git commit -m "feat: harden and enable in-DOM webview previews in the main process

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Per-kind dimensions for preview nodes

**Files:**

- Modify: `src/shared/canvas/node-dimensions.ts` (append)
- Modify: `src/renderer/src/components/workspace/model/node-persistence.ts` (`:12-35`)
- Modify: `src/renderer/src/components/workspace/canvas/CanvasNode.tsx` (`:9-12` imports, `:192-196` minimum)
- Modify: `src/renderer/src/styles/workspace/canvas.css` (after the agent rule at `:145-148`)
- Test: `src/renderer/src/components/workspace/model/node-persistence.test.ts` (append)

**Interfaces:**

- Produces (Task 4's CSS/size expectations depend on these): `WEB_PREVIEW_NODE_DEFAULT_DIMENSIONS = { width: 640, height: 480 }`, `WEB_PREVIEW_NODE_MINIMUM_DIMENSIONS = { width: 400, height: 300 }`, `MOBILE_PREVIEW_NODE_DEFAULT_DIMENSIONS = { width: 420, height: 640 }`, `MOBILE_PREVIEW_NODE_MINIMUM_DIMENSIONS = { width: 320, height: 480 }`, and `defaultNodeDimensionsForKind(kind: string)` / `minimumNodeDimensionsForKind(kind: string)`, all exported from `src/shared/canvas/node-dimensions.ts`.

- [ ] **Step 1: Write the failing tests** — append to `node-persistence.test.ts` (matching its existing style):

```ts
it('gives preview nodes browser-window dimensions', () => {
  expect(initialWorkshopNodeDimensions('web-preview')).toEqual({ width: 640, height: 480 });
  expect(initialWorkshopNodeDimensions('mobile-preview')).toEqual({ width: 420, height: 640 });
});

it('floors persisted preview nodes at their per-kind minimums', () => {
  expect(
    persistedWorkshopNodeDimensions({
      data: { kind: 'web-preview' } as WorkshopNode['data'],
      width: 100,
      height: 100,
    }),
  ).toEqual({ width: 400, height: 300 });
  expect(
    persistedWorkshopNodeDimensions({
      data: { kind: 'mobile-preview' } as WorkshopNode['data'],
      width: 100,
      height: 100,
    }),
  ).toEqual({ width: 320, height: 480 });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/renderer/src/components/workspace/model/node-persistence.test.ts`
Expected: FAIL — previews get `{ width: 320, height: 180 }` / floor `{ width: 210, height: 92 }`.

- [ ] **Step 3: Implement.**

`src/shared/canvas/node-dimensions.ts` — append:

```ts
/** Initial dimensions for a web preview node (embedded browser). */
export const WEB_PREVIEW_NODE_DEFAULT_DIMENSIONS = {
  width: 640,
  height: 480,
} as const;

/** Smallest web preview that still shows a usable page. */
export const WEB_PREVIEW_NODE_MINIMUM_DIMENSIONS = {
  width: 400,
  height: 300,
} as const;

/** Initial dimensions for a mobile preview node (scaled device frame). */
export const MOBILE_PREVIEW_NODE_DEFAULT_DIMENSIONS = {
  width: 420,
  height: 640,
} as const;

/** Smallest mobile preview that still shows a readable device frame. */
export const MOBILE_PREVIEW_NODE_MINIMUM_DIMENSIONS = {
  width: 320,
  height: 480,
} as const;

/** Default dimensions for non-frame node kinds (frames are handled separately). */
export function defaultNodeDimensionsForKind(kind: string): {
  readonly width: number;
  readonly height: number;
} {
  if (kind === 'agent') return AGENT_NODE_DEFAULT_DIMENSIONS;
  if (kind === 'web-preview') return WEB_PREVIEW_NODE_DEFAULT_DIMENSIONS;
  if (kind === 'mobile-preview') return MOBILE_PREVIEW_NODE_DEFAULT_DIMENSIONS;
  return DEFAULT_CANVAS_NODE_DIMENSIONS;
}

/** Minimum dimensions for non-frame node kinds (frames are handled separately). */
export function minimumNodeDimensionsForKind(kind: string): {
  readonly width: number;
  readonly height: number;
} {
  if (kind === 'agent') return AGENT_NODE_MINIMUM_DIMENSIONS;
  if (kind === 'web-preview') return WEB_PREVIEW_NODE_MINIMUM_DIMENSIONS;
  if (kind === 'mobile-preview') return MOBILE_PREVIEW_NODE_MINIMUM_DIMENSIONS;
  return CANVAS_NODE_MINIMUM_DIMENSIONS;
}
```

`node-persistence.ts` — replace the body of `initialWorkshopNodeDimensions` and the `minimum` selection (imports become `DEFAULT_GROUP_FRAME_DIMENSIONS`, `GROUP_FRAME_MINIMUM_DIMENSIONS`, `defaultNodeDimensionsForKind`, `minimumNodeDimensionsForKind`):

```ts
export function initialWorkshopNodeDimensions(kind: NodeKind): {
  readonly width: number;
  readonly height: number;
} {
  if (kind === 'group-frame') return { ...DEFAULT_GROUP_FRAME_DIMENSIONS };
  return { ...defaultNodeDimensionsForKind(kind) };
}
```

```ts
const minimum =
  node.data.kind === 'group-frame'
    ? GROUP_FRAME_MINIMUM_DIMENSIONS
    : minimumNodeDimensionsForKind(node.data.kind);
```

`CanvasNode.tsx` — replace the import of `AGENT_NODE_MINIMUM_DIMENSIONS, CANVAS_NODE_MINIMUM_DIMENSIONS` (`:9-12`) with `minimumNodeDimensionsForKind`, and lines 192-196 with:

```ts
const minimum = groupFrame ? GROUP_FRAME_MINIMUM : minimumNodeDimensionsForKind(data.kind);
```

`canvas.css` — after the agent `:has()` rule at `:145-148`:

```css
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='web-preview']:not(.collapsed)) {
  min-width: 400px;
  min-height: 300px;
}
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='mobile-preview']:not(.collapsed)) {
  min-width: 320px;
  min-height: 480px;
}
```

- [ ] **Step 4: Run tests + typecheck** — node-persistence test → PASS; also run `apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.test.tsx` (agent minimum behavior unchanged) → PASS; typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/shared/canvas/node-dimensions.ts apps/desktop/src/renderer/src/components/workspace/model/node-persistence.ts apps/desktop/src/renderer/src/components/workspace/model/node-persistence.test.ts apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.tsx apps/desktop/src/renderer/src/styles/workspace/canvas.css
git commit -m "feat: per-kind canvas dimensions for web and mobile preview nodes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Shared PreviewWebview element wrapper

**Files:**

- Create: `src/shared/preview/console.ts`
- Create: `src/renderer/src/components/preview/webview/webview.d.ts`
- Create: `src/renderer/src/components/preview/webview/PreviewWebview.tsx`
- Test: `src/renderer/src/components/preview/webview/PreviewWebview.test.tsx`

**Interfaces:**

- Produces (used by Tasks 4-6; names must match exactly):

```ts
// src/shared/preview/console.ts
export type PreviewConsoleLevel = 'debug' | 'info' | 'warning' | 'error';
export interface PreviewConsoleMessage {
  readonly level: PreviewConsoleLevel;
  readonly message: string;
  readonly source: string | null;
  readonly line: number | null;
}
export interface PreviewConsoleEntry extends PreviewConsoleMessage {
  readonly sequence: number;
  readonly capturedAt: string;
}
export interface PreviewConsoleView {
  readonly entries: readonly PreviewConsoleEntry[];
  readonly truncated: boolean;
  readonly retainedBytes: number;
  readonly disclosure: typeof PREVIEW_CONSOLE_DISCLOSURE;
}
export const PREVIEW_CONSOLE_DISCLOSURE: 'Console output is captured in memory only, bounded to 500 entries and 256 KiB, and may contain application data.';
export const MAX_PREVIEW_CONSOLE_ENTRIES = 500;
export const MAX_PREVIEW_CONSOLE_BYTES: number; // 256 * 1024
export const MAX_PREVIEW_CONSOLE_MESSAGE_CHARACTERS = 8192;

// src/renderer/src/components/preview/webview/PreviewWebview.tsx
export interface PreviewWebviewElement extends HTMLElement {
  src: string;
  loadURL?(url: string): Promise<void>;
  reload?(): void;
  canGoBack?(): boolean;
  canGoForward?(): boolean;
  goBack?(): void;
  goForward?(): void;
  getURL?(): string;
}
export interface PreviewWebviewStatus {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly failure: string | null;
}
export interface PreviewWebviewHandle {
  navigate(url: string): void;
  reload(): void;
  history(direction: 'back' | 'forward'): void;
}
// Props: { partition: string; src: string; ariaLabel: string; className?: string;
//          onStatus?: (status: PreviewWebviewStatus) => void;
//          onConsole?: (message: PreviewConsoleMessage) => void }
// NOTE: `partition` must never change after mount (Electron forbids it) — consumers key the component by partition.
```

- [ ] **Step 1: Write the failing test** (`PreviewWebview.test.tsx`):

```tsx
// @vitest-environment jsdom

import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import {
  PreviewWebview,
  type PreviewWebviewElement,
  type PreviewWebviewHandle,
} from './PreviewWebview.js';

afterEach(cleanup);

function renderWebview() {
  const handle = createRef<PreviewWebviewHandle>();
  const onStatus = vi.fn();
  const onConsole = vi.fn();
  const { container } = render(
    <PreviewWebview
      ref={handle}
      partition="preview:p1:n1"
      src="http://localhost:5173/"
      ariaLabel="Web preview"
      onStatus={onStatus}
      onConsole={onConsole}
    />,
  );
  const element = container.querySelector('webview') as PreviewWebviewElement;
  return { element, handle, onStatus, onConsole };
}

describe('PreviewWebview', () => {
  it('renders a partitioned webview pointing at the requested source', () => {
    const { element } = renderWebview();
    expect(element).not.toBeNull();
    expect(element.getAttribute('partition')).toBe('preview:p1:n1');
    expect(element.getAttribute('src')).toBe('http://localhost:5173/');
    expect(element.getAttribute('aria-label')).toBe('Web preview');
  });

  it('reports loading, ready, and failure transitions', () => {
    const { element, onStatus } = renderWebview();
    fireEvent(element, new Event('did-start-loading'));
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'loading' }));
    fireEvent(element, new Event('did-stop-loading'));
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'ready', failure: null }),
    );
    fireEvent(
      element,
      Object.assign(new Event('did-fail-load'), {
        errorCode: -102,
        errorDescription: 'ERR_CONNECTION_REFUSED',
        isMainFrame: true,
      }),
    );
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        failure: expect.stringContaining('ERR_CONNECTION_REFUSED'),
      }),
    );
  });

  it('tracks committed navigation URLs and history availability', () => {
    const { element, onStatus } = renderWebview();
    element.canGoBack = () => true;
    fireEvent(
      element,
      Object.assign(new Event('did-navigate'), { url: 'http://localhost:5173/about' }),
    );
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'http://localhost:5173/about', canGoBack: true }),
    );
  });

  it('forwards mapped console messages', () => {
    const { element, onConsole } = renderWebview();
    fireEvent(
      element,
      Object.assign(new Event('console-message'), {
        level: 3,
        message: 'boom',
        line: 12,
        sourceId: 'http://localhost:5173/app.js',
      }),
    );
    expect(onConsole).toHaveBeenCalledWith({
      level: 'error',
      message: 'boom',
      source: 'http://localhost:5173/app.js',
      line: 12,
    });
  });

  it('drives the element through its imperative handle with jsdom-safe fallbacks', () => {
    const { element, handle } = renderWebview();
    handle.current?.navigate('http://localhost:5173/next');
    expect(element.getAttribute('src')).toBe('http://localhost:5173/next');
    const reload = vi.fn();
    element.reload = reload;
    handle.current?.reload();
    expect(reload).toHaveBeenCalled();
    const goBack = vi.fn();
    element.goBack = goBack;
    handle.current?.history('back');
    expect(goBack).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.**

`src/shared/preview/console.ts`:

```ts
/** In-renderer console capture types for in-DOM preview webviews. */
export type PreviewConsoleLevel = 'debug' | 'info' | 'warning' | 'error';

export interface PreviewConsoleMessage {
  readonly level: PreviewConsoleLevel;
  readonly message: string;
  readonly source: string | null;
  readonly line: number | null;
}

export interface PreviewConsoleEntry extends PreviewConsoleMessage {
  readonly sequence: number;
  readonly capturedAt: string;
}

export const PREVIEW_CONSOLE_DISCLOSURE =
  'Console output is captured in memory only, bounded to 500 entries and 256 KiB, and may contain application data.' as const;

export interface PreviewConsoleView {
  readonly entries: readonly PreviewConsoleEntry[];
  readonly truncated: boolean;
  readonly retainedBytes: number;
  readonly disclosure: typeof PREVIEW_CONSOLE_DISCLOSURE;
}

export const MAX_PREVIEW_CONSOLE_ENTRIES = 500;
export const MAX_PREVIEW_CONSOLE_BYTES = 256 * 1_024;
export const MAX_PREVIEW_CONSOLE_MESSAGE_CHARACTERS = 8_192;
```

`src/renderer/src/components/preview/webview/webview.d.ts`:

```ts
import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
        allowpopups?: string;
      };
    }
  }
}
```

`src/renderer/src/components/preview/webview/PreviewWebview.tsx`:

```tsx
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import type {
  PreviewConsoleLevel,
  PreviewConsoleMessage,
} from '../../../../../shared/preview/console.js';
import { MAX_PREVIEW_CONSOLE_MESSAGE_CHARACTERS } from '../../../../../shared/preview/console.js';

export interface PreviewWebviewElement extends HTMLElement {
  src: string;
  loadURL?(url: string): Promise<void>;
  reload?(): void;
  canGoBack?(): boolean;
  canGoForward?(): boolean;
  goBack?(): void;
  goForward?(): void;
  getURL?(): string;
}

export interface PreviewWebviewStatus {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly failure: string | null;
}

export interface PreviewWebviewHandle {
  navigate(url: string): void;
  reload(): void;
  history(direction: 'back' | 'forward'): void;
}

interface PreviewWebviewProps {
  /** Immutable after mount — Electron forbids changing a webview's partition. */
  partition: string;
  src: string;
  ariaLabel: string;
  className?: string | undefined;
  onStatus?: ((status: PreviewWebviewStatus) => void) | undefined;
  onConsole?: ((message: PreviewConsoleMessage) => void) | undefined;
}

/**
 * Thin wrapper around the Electron `<webview>` tag: renders the element with
 * its non-persistent preview partition, translates guest events into a status
 * object, and exposes navigate/reload/history imperatively. All Electron-only
 * methods are guarded so the component stays inert (and testable) under jsdom.
 */
export const PreviewWebview = forwardRef<PreviewWebviewHandle, PreviewWebviewProps>(
  function PreviewWebview({ partition, src, ariaLabel, className, onStatus, onConsole }, ref) {
    const elementRef = useRef<PreviewWebviewElement | null>(null);
    const onStatusRef = useRef(onStatus);
    onStatusRef.current = onStatus;
    const onConsoleRef = useRef(onConsole);
    onConsoleRef.current = onConsole;

    useEffect(() => {
      const element = elementRef.current;
      if (!element) return;
      let current: PreviewWebviewStatus = {
        status: 'loading',
        url: element.getAttribute('src') ?? '',
        canGoBack: false,
        canGoForward: false,
        failure: null,
      };
      const publish = (patch: Partial<PreviewWebviewStatus>): void => {
        current = {
          ...current,
          ...patch,
          canGoBack: element.canGoBack?.() ?? false,
          canGoForward: element.canGoForward?.() ?? false,
        };
        onStatusRef.current?.(current);
      };
      const listeners: ReadonlyArray<readonly [string, EventListener]> = [
        ['did-start-loading', () => publish({ status: 'loading', failure: null })],
        [
          'did-stop-loading',
          () => publish({ status: current.failure === null ? 'ready' : 'failed' }),
        ],
        [
          'did-fail-load',
          ((
            event: Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean },
          ) => {
            if (event.isMainFrame === false || event.errorCode === -3) return;
            publish({
              status: 'failed',
              failure: `${event.errorDescription ?? 'The page could not load.'} (${String(event.errorCode ?? 0)})`,
            });
          }) as EventListener,
        ],
        [
          'did-navigate',
          ((event: Event & { url?: string }) =>
            publish({ url: event.url ?? current.url, failure: null })) as EventListener,
        ],
        [
          'did-navigate-in-page',
          ((event: Event & { url?: string }) =>
            publish({ url: event.url ?? current.url })) as EventListener,
        ],
        [
          'console-message',
          ((
            event: Event & {
              level?: unknown;
              message?: unknown;
              line?: unknown;
              sourceId?: unknown;
            },
          ) => {
            onConsoleRef.current?.({
              level: consoleLevel(event.level),
              message:
                typeof event.message === 'string'
                  ? event.message.slice(0, MAX_PREVIEW_CONSOLE_MESSAGE_CHARACTERS)
                  : '',
              source:
                typeof event.sourceId === 'string' && event.sourceId !== ''
                  ? event.sourceId.slice(0, 2_048)
                  : null,
              line:
                typeof event.line === 'number' && Number.isInteger(event.line) && event.line >= 0
                  ? event.line
                  : null,
            });
          }) as EventListener,
        ],
      ];
      for (const [name, listener] of listeners) element.addEventListener(name, listener);
      publish({});
      return () => {
        for (const [name, listener] of listeners) element.removeEventListener(name, listener);
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        navigate(url: string) {
          const element = elementRef.current;
          if (!element) return;
          if (typeof element.loadURL === 'function') {
            void element.loadURL(url).catch(() => undefined);
          } else {
            element.setAttribute('src', url);
          }
        },
        reload() {
          elementRef.current?.reload?.();
        },
        history(direction: 'back' | 'forward') {
          const element = elementRef.current;
          if (!element) return;
          if (direction === 'back') element.goBack?.();
          else element.goForward?.();
        },
      }),
      [],
    );

    return (
      <webview
        ref={(node) => {
          elementRef.current = node as PreviewWebviewElement | null;
        }}
        className={className}
        partition={partition}
        src={src}
        aria-label={ariaLabel}
      />
    );
  },
);

function consoleLevel(level: unknown): PreviewConsoleLevel {
  if (level === 'debug' || level === 'info' || level === 'warning' || level === 'error')
    return level;
  if (typeof level === 'number') {
    if (level >= 3) return 'error';
    if (level === 2) return 'warning';
    if (level === 0) return 'debug';
  }
  return 'info';
}
```

- [ ] **Step 4: Run the test** → PASS. Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/shared/preview/console.ts apps/desktop/src/renderer/src/components/preview/webview/webview.d.ts apps/desktop/src/renderer/src/components/preview/webview/PreviewWebview.tsx apps/desktop/src/renderer/src/components/preview/webview/PreviewWebview.test.tsx
git commit -m "feat: shared PreviewWebview element wrapper for in-DOM previews

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Port-only preview node faces

**Files:**

- Create: `src/renderer/src/components/workspace/previews/PreviewNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/previews/preview-node-face.css`
- Modify: `src/renderer/src/components/workspace/canvas/CanvasNode.tsx` (`WorkshopNodeData` around `:151`; render branch at `:303-335`)
- Test: `src/renderer/src/components/workspace/previews/PreviewNodeFace.test.tsx`

**Interfaces:**

- Consumes: `useAgentSession()` (existing `AgentSessionContextValue`: `project`, `graphReadOnly`, `updateNodeData`, `recordHistory`), `useCanvasNodeInteractions()`, `previewWebviewPartition` (Task 1), `PreviewWebview`/`PreviewWebviewHandle`/`PreviewWebviewStatus` (Task 3), `previewPreset`/`orientedViewport` from `../../preview/devices/presets.js`.
- Produces: `export function PreviewNodeFace({ id, kind, data }: { id: string; kind: 'web-preview' | 'mobile-preview'; data: WorkshopNodeData }): JSX.Element` and the `previewPort?: number | undefined;` field on `WorkshopNodeData`.

- [ ] **Step 1: Write the failing tests** (`PreviewNodeFace.test.tsx`):

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';
import { PreviewNodeFace } from './PreviewNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
});

function sessionValue(graphReadOnly = false): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly,
    updateNodeData,
    recordHistory,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'web-preview',
    title: 'Preview',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#6099c5',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(
  kind: 'web-preview' | 'mobile-preview',
  overrides: Partial<WorkshopNodeData> = {},
  graphReadOnly = false,
) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue(graphReadOnly)}>
        <PreviewNodeFace id="n1" kind={kind} data={nodeData({ kind, ...overrides })} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('PreviewNodeFace', () => {
  it('shows only a port input and hint while no port is set', () => {
    const { container } = renderFace('web-preview');
    expect(screen.getByLabelText('Preview port')).toHaveProperty('value', '');
    expect(screen.getByText(/enter the port/i)).toBeTruthy();
    expect(container.querySelector('webview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload preview' })).toHaveProperty('disabled', true);
  });

  it('persists the typed port on Enter', () => {
    renderFace('web-preview');
    const input = screen.getByLabelText('Preview port');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5173' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', { previewPort: 5173 });
  });

  it('clears the port when the input is emptied', () => {
    renderFace('web-preview', { previewPort: 5173 });
    const input = screen.getByLabelText('Preview port');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { previewPort: undefined });
  });

  it('renders a partitioned localhost webview once a port is set', () => {
    const { container } = renderFace('web-preview', { previewPort: 5173 });
    const webview = container.querySelector('webview');
    expect(webview?.getAttribute('src')).toBe('http://localhost:5173/');
    expect(webview?.getAttribute('partition')).toBe('preview:p1:n1');
    expect(webview?.closest('.preview-face-body')?.className).toContain('nowheel');
    expect(webview?.closest('.preview-face-body')?.className).toContain('nodrag');
  });

  it('wraps the mobile face in a device frame at the stored preset size', () => {
    const { container } = renderFace('mobile-preview', { previewPort: 5173 });
    const frame = container.querySelector('.preview-face-device-frame') as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.style.width).toBe('390px');
    expect(frame.style.height).toBe('844px');
    expect(container.querySelector('webview')).not.toBeNull();
  });

  it('disables the port input for locked nodes and read-only collaborators', () => {
    renderFace('web-preview', { locked: true });
    expect(screen.getByLabelText('Preview port')).toHaveProperty('disabled', true);
    cleanup();
    renderFace('web-preview', {}, true);
    expect(screen.getByLabelText('Preview port')).toHaveProperty('disabled', true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.**

`CanvasNode.tsx` — inside `WorkshopNodeData` (near `:151`, next to the other `preview*` fields) add:

```ts
  previewPort?: number | undefined;
```

`src/renderer/src/components/workspace/previews/PreviewNodeFace.tsx`:

```tsx
import { useEffect, useRef, useState, type JSX } from 'react';
import { RotateCw } from 'lucide-react';

import { previewWebviewPartition } from '../../../../../shared/preview/webview-partition.js';
import {
  orientedViewport,
  previewPreset,
  type PreviewOrientation,
} from '../../preview/devices/presets.js';
import {
  PreviewWebview,
  type PreviewWebviewHandle,
  type PreviewWebviewStatus,
} from '../../preview/webview/PreviewWebview.js';
import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { useCanvasNodeInteractions } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../runs/agent-session/AgentSessionContext.js';
import './preview-node-face.css';

/**
 * Port-only preview face: one compact port input plus an in-DOM webview that
 * fills the node body ("literally just inputting a port and it showing up").
 * The mobile variant renders the same webview inside a CSS-scaled device frame
 * at the node's stored preset. Dev-server lifecycle stays in the inspector.
 */
export function PreviewNodeFace({
  id,
  kind,
  data,
}: {
  id: string;
  kind: 'web-preview' | 'mobile-preview';
  data: WorkshopNodeData;
}): JSX.Element {
  const { project, graphReadOnly, updateNodeData, recordHistory } = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const webviewRef = useRef<PreviewWebviewHandle | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const readOnly = graphReadOnly || data.locked || interactions.readOnly;

  const port = normalizedPort(data.previewPort);
  const [draft, setDraft] = useState(port === null ? '' : String(port));
  const [status, setStatus] = useState<PreviewWebviewStatus | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    setDraft(port === null ? '' : String(port));
  }, [port]);

  const orientation: PreviewOrientation =
    data.previewOrientation === 'landscape' ? 'landscape' : 'portrait';
  const viewport = orientedViewport(previewPreset(data.previewPreset, 'iphone'), orientation);

  useEffect(() => {
    if (kind !== 'mobile-preview' || typeof ResizeObserver === 'undefined') return;
    const body = bodyRef.current;
    if (!body) return;
    const update = (): void => {
      const rect = body.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      setScale(
        Math.min((rect.width - 16) / viewport.width, (rect.height - 16) / viewport.height, 1),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(body);
    return () => observer.disconnect();
  }, [kind, viewport.height, viewport.width]);

  const commit = (): void => {
    const next = draft.trim() === '' ? null : normalizedPort(Number(draft));
    if (next === port) return;
    updateNodeData(id, { previewPort: next ?? undefined });
  };

  const src = port === null ? null : `http://localhost:${String(port)}/`;
  const partition = previewWebviewPartition(project.id, id);

  return (
    <section
      className="preview-node-face"
      aria-label={kind === 'web-preview' ? 'Web preview' : 'Mobile preview'}
    >
      <div className="preview-face-strip nodrag">
        <label className="preview-face-port">
          Port
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            placeholder="5173"
            aria-label="Preview port"
            name={`node-${id}-preview-port`}
            value={draft}
            disabled={readOnly}
            onFocus={recordHistory}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
          />
        </label>
        <button
          type="button"
          className="preview-face-reload"
          aria-label="Reload preview"
          disabled={src === null}
          onClick={() => webviewRef.current?.reload()}
        >
          <RotateCw size={12} aria-hidden="true" />
        </button>
        <span className={`preview-face-status ${status?.status ?? 'idle'}`} role="status">
          {src === null ? 'no port' : (status?.status ?? 'loading')}
        </span>
      </div>
      <div className="preview-face-body nowheel nodrag" ref={bodyRef}>
        {src === null ? (
          <p className="preview-face-hint">Enter the port your local dev server is running on.</p>
        ) : kind === 'mobile-preview' ? (
          <div
            className="preview-face-device"
            style={{ width: viewport.width * scale, height: viewport.height * scale }}
          >
            <div
              className="preview-face-device-frame"
              style={{
                width: viewport.width,
                height: viewport.height,
                transform: `scale(${String(scale)})`,
              }}
            >
              <PreviewWebview
                ref={webviewRef}
                partition={partition}
                src={src}
                ariaLabel="Mobile preview page"
                className="preview-face-webview"
                onStatus={setStatus}
              />
            </div>
          </div>
        ) : (
          <PreviewWebview
            ref={webviewRef}
            partition={partition}
            src={src}
            ariaLabel="Web preview page"
            className="preview-face-webview"
            onStatus={setStatus}
          />
        )}
        {status?.status === 'failed' && status.failure !== null && src !== null ? (
          <p className="preview-face-failure" role="alert">
            {status.failure}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function normalizedPort(candidate: unknown): number | null {
  return typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 1 &&
    candidate <= 65_535
    ? candidate
    : null;
}
```

`src/renderer/src/components/workspace/previews/preview-node-face.css`:

```css
.canvas-node[data-node-kind='web-preview']:not(.collapsed),
.canvas-node[data-node-kind='mobile-preview']:not(.collapsed) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.canvas-node[data-node-kind='web-preview']:not(.collapsed) > header,
.canvas-node[data-node-kind='mobile-preview']:not(.collapsed) > header {
  flex: 0 0 auto;
}
.preview-node-face {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.preview-face-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-raised);
  font-size: var(--text-xs);
}
.preview-face-port {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-soft);
}
.preview-face-port input {
  width: 64px;
  font-size: var(--text-xs);
}
.preview-face-reload {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: transparent;
  color: var(--text-soft);
  cursor: pointer;
}
.preview-face-reload:disabled {
  opacity: 0.5;
  cursor: default;
}
.preview-face-status {
  margin-left: auto;
  color: var(--text-faint);
  text-transform: lowercase;
}
.preview-face-status.failed {
  color: #d06870;
}
.preview-face-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  justify-content: center;
  overflow: hidden;
  background: #0d0f12;
}
.preview-face-body > .preview-face-webview {
  flex: 1;
}
webview.preview-face-webview {
  display: flex;
  width: 100%;
  height: 100%;
}
.preview-face-hint {
  margin: auto;
  max-width: 26ch;
  text-align: center;
  color: var(--text-faint);
  font-size: var(--text-xs);
}
.preview-face-device {
  margin: 8px auto auto;
  overflow: hidden;
}
.preview-face-device-frame {
  transform-origin: top left;
  border: 1px solid var(--line-strong);
  border-radius: 18px;
  overflow: hidden;
  background: #000;
}
.preview-face-failure {
  position: absolute;
  inset: auto 8px 8px;
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, #d06870 18%, var(--surface));
  color: var(--text);
  font-size: var(--text-2xs);
}
```

- [ ] **Step 4: Integrate into `CanvasNode.tsx`.**
  - Import: `import { PreviewNodeFace } from '../previews/PreviewNodeFace.js';`
  - After `const agentWindow = isAgent && !data.collapsed;` (`:200`) add:

```ts
const previewFace =
  (data.kind === 'web-preview' || data.kind === 'mobile-preview') && !data.collapsed;
```

- Replace the body block at `:303-304`:

```tsx
      {agentWindow && <AgentSessionNode id={id} data={data} />}
      {previewFace && (
        <PreviewNodeFace id={id} kind={data.kind as 'web-preview' | 'mobile-preview'} data={data} />
      )}
      {!agentWindow && !previewFace && definition.behaviors.collapsible && !data.collapsed && (
```

(The generic `<header>` with the collapse pill, lock icon, and status dot stays for preview kinds — collapse/lock/resize behaviors are unchanged.)

- [ ] **Step 5: Run tests + typecheck.**

Run: the new `PreviewNodeFace.test.tsx` → PASS.
Run: `apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.test.tsx` and `apps/desktop/src/renderer/src/components/workspace/canvas/WorkspaceCanvas.test.tsx` — if any test renders an expanded `web-preview`/`mobile-preview` node it will now need the `AgentSessionProvider` wrapper (copy the provider usage from `PreviewNodeFace.test.tsx`); update wrappers only, never weaken assertions.
Typecheck → clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/workspace/previews/PreviewNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/previews/preview-node-face.css apps/desktop/src/renderer/src/components/workspace/previews/PreviewNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.tsx
git commit -m "feat: port-only preview faces render the app inside canvas nodes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Include `CanvasNode.test.tsx` / `WorkspaceCanvas.test.tsx` in the `git add` only if Step 5 required wrapper updates.)

---

### Task 5: Migrate the PreviewSurface modal and comparison view to the webview

**Files:**

- Create: `src/renderer/src/components/preview/webview/usePreviewConsoleBuffer.ts`
- Rewrite: `src/renderer/src/components/preview/surface/DeviceFrameHost.tsx`
- Modify: `src/renderer/src/components/preview/surface/PreviewSurface.tsx` (drop `operations`, screenshot, open-external; console from webview)
- Modify: `src/renderer/src/components/preview/surface/PreviewSurface.css` (webview sizing rule)
- Modify: `src/renderer/src/components/preview/comparison/ComparisonSurface.tsx` and `src/renderer/src/components/preview/comparison/PreviewComparisonPanel.tsx` (drop `operations` pass-through to frames)
- Modify: `src/renderer/src/components/preview/PreviewNodePanel.tsx` (`:337` Open-preview gating; `:382-397` PreviewSurface props)
- Modify: `src/renderer/src/components/preview/console/PreviewConsole.tsx` (`:3-5` import from `shared/preview/console.js`)
- Test: rewrite `src/renderer/src/components/preview/surface/DeviceFrameHost.test.tsx`; update `src/renderer/src/components/preview/PreviewNodePanel.test.tsx` and `src/renderer/src/components/preview/comparison/PreviewComparisonPanel.test.tsx` as needed
- Modify: `e2e/preview.spec.ts` (remove the screenshot step at `:129-130` and any `Touchscreen mode on` / open-in-browser assertions — verify with `grep -n "screenshot\|Touchscreen\|Open in browser" apps/desktop/e2e/preview.spec.ts`)

**Interfaces:**

- Produces:

```ts
// usePreviewConsoleBuffer.ts
export function usePreviewConsoleBuffer(): {
  view: PreviewConsoleView;
  append(message: PreviewConsoleMessage): void;
};

// DeviceFrameHost.tsx (new shape; ComparisonSurface/PreviewSurface consume this)
interface DeviceFrameHostProps {
  projectId: string;
  nodeId: string;
  slot?: 'comparison-left' | 'comparison-right';
  url: string;
  presetId: PreviewPresetId;
  orientation: PreviewOrientation;
  readOnly: boolean;
  onView?: (view: PreviewWebviewStatus | null) => void;
  onConsole?: (message: PreviewConsoleMessage) => void;
}
export interface DeviceFrameHandle {
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  history(direction: 'back' | 'forward'): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test** — replace `DeviceFrameHost.test.tsx` with:

```tsx
// @vitest-environment jsdom

import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { DeviceFrameHost, type DeviceFrameHandle } from './DeviceFrameHost.js';

const navigate = vi.fn(async () => ({ ok: true as const, value: 'http://127.0.0.1:41000/app' }));

afterEach(cleanup);
beforeEach(() => {
  navigate.mockClear();
  (window as { forgeboard?: unknown }).forgeboard = { previews: { navigate } };
});

function renderHost(slot?: 'comparison-left' | 'comparison-right') {
  const handle = createRef<DeviceFrameHandle>();
  const { container } = render(
    <DeviceFrameHost
      ref={handle}
      projectId="p1"
      nodeId="n1"
      {...(slot === undefined ? {} : { slot })}
      url="http://127.0.0.1:41000/"
      presetId="desktop"
      orientation="portrait"
      readOnly={false}
    />,
  );
  return { handle, container };
}

describe('DeviceFrameHost', () => {
  it('renders a per-node partitioned webview at the preset viewport', () => {
    const { container } = renderHost();
    const webview = container.querySelector('webview');
    expect(webview?.getAttribute('partition')).toBe('preview:p1:n1');
    expect(webview?.getAttribute('src')).toBe('http://127.0.0.1:41000/');
  });

  it('uses slot-scoped partitions for comparison frames', () => {
    const { container } = renderHost('comparison-left');
    expect(container.querySelector('webview')?.getAttribute('partition')).toBe(
      'preview:p1:n1:comparison-left',
    );
  });

  it('validates address navigation through the previews IPC before loading it', async () => {
    const { handle, container } = renderHost();
    await handle.current?.navigate('http://127.0.0.1:41000/app');
    expect(navigate).toHaveBeenCalledWith({
      projectId: 'p1',
      nodeId: 'n1',
      url: 'http://127.0.0.1:41000/app',
    });
    expect(container.querySelector('webview')?.getAttribute('src')).toBe(
      'http://127.0.0.1:41000/app',
    );
  });
});
```

- [ ] **Step 2: Run to verify failure** — the current WebContentsView-based host has no webview and different props.

- [ ] **Step 3: Implement.**

`src/renderer/src/components/preview/webview/usePreviewConsoleBuffer.ts`:

```ts
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  MAX_PREVIEW_CONSOLE_BYTES,
  MAX_PREVIEW_CONSOLE_ENTRIES,
  PREVIEW_CONSOLE_DISCLOSURE,
  type PreviewConsoleEntry,
  type PreviewConsoleMessage,
  type PreviewConsoleView,
} from '../../../../../shared/preview/console.js';

interface BufferState {
  entries: PreviewConsoleEntry[];
  truncated: boolean;
  retainedBytes: number;
}

/** Renderer-side bounded console buffer fed by webview console-message events. */
export function usePreviewConsoleBuffer(): {
  view: PreviewConsoleView;
  append(message: PreviewConsoleMessage): void;
} {
  const sequenceRef = useRef(0);
  const [state, setState] = useState<BufferState>({
    entries: [],
    truncated: false,
    retainedBytes: 0,
  });

  const append = useCallback((message: PreviewConsoleMessage) => {
    const entry: PreviewConsoleEntry = {
      ...message,
      sequence: sequenceRef.current++,
      capturedAt: new Date().toISOString(),
    };
    setState((current) => {
      const entries = [...current.entries, entry];
      let retainedBytes = current.retainedBytes + utf8Length(entry.message);
      let truncated = current.truncated;
      while (
        entries.length > MAX_PREVIEW_CONSOLE_ENTRIES ||
        retainedBytes > MAX_PREVIEW_CONSOLE_BYTES
      ) {
        const removed = entries.shift();
        if (!removed) break;
        retainedBytes -= utf8Length(removed.message);
        truncated = true;
      }
      return { entries, truncated, retainedBytes };
    });
  }, []);

  const view = useMemo<PreviewConsoleView>(
    () => ({
      entries: state.entries,
      truncated: state.truncated,
      retainedBytes: state.retainedBytes,
      disclosure: PREVIEW_CONSOLE_DISCLOSURE,
    }),
    [state],
  );

  return { view, append };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
```

`DeviceFrameHost.tsx` — full replacement:

```tsx
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';

import type { PreviewConsoleMessage } from '../../../../../shared/preview/console.js';
import { previewWebviewPartition } from '../../../../../shared/preview/webview-partition.js';
import { unwrap } from '../../../lib/ipc.js';
import {
  orientedViewport,
  PREVIEW_DEVICE_PRESETS,
  type PreviewOrientation,
  type PreviewPresetId,
} from '../devices/presets.js';
import {
  PreviewWebview,
  type PreviewWebviewHandle,
  type PreviewWebviewStatus,
} from '../webview/PreviewWebview.js';

interface DeviceFrameHostProps {
  projectId: string;
  nodeId: string;
  slot?: 'comparison-left' | 'comparison-right';
  url: string;
  presetId: PreviewPresetId;
  orientation: PreviewOrientation;
  readOnly: boolean;
  onView?: (view: PreviewWebviewStatus | null) => void;
  onConsole?: (message: PreviewConsoleMessage) => void;
}

export interface DeviceFrameHandle {
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  history(direction: 'back' | 'forward'): Promise<void>;
}

export const DeviceFrameHost = forwardRef<DeviceFrameHandle, DeviceFrameHostProps>(
  function DeviceFrameHost(
    { projectId, nodeId, slot, url, presetId, orientation, readOnly, onView, onConsole },
    ref,
  ) {
    const webviewRef = useRef<PreviewWebviewHandle | null>(null);
    const [view, setView] = useState<PreviewWebviewStatus | null>(null);
    const preset = PREVIEW_DEVICE_PRESETS[presetId];
    const viewport = orientedViewport(presetId, orientation);

    useImperativeHandle(
      ref,
      () => ({
        async navigate(candidate: string) {
          const validated = unwrap(
            await window.forgeboard.previews.navigate({
              projectId,
              nodeId,
              ...(slot === undefined ? {} : { slot }),
              url: candidate,
            }),
          );
          webviewRef.current?.navigate(validated);
        },
        async reload() {
          webviewRef.current?.reload();
        },
        async history(direction: 'back' | 'forward') {
          webviewRef.current?.history(direction);
        },
      }),
      [nodeId, projectId, slot],
    );

    return (
      <figure className={`preview-device preview-device-${preset.family}`}>
        <figcaption>
          {preset.label} · {viewport.width} × {viewport.height}
        </figcaption>
        <div className="preview-device-shell">
          <div
            className="preview-device-host"
            data-status={view?.status ?? 'connecting'}
            style={{ width: viewport.width, height: viewport.height }}
            aria-label={`${preset.label} preview`}
          >
            <PreviewWebview
              ref={webviewRef}
              partition={previewWebviewPartition(projectId, nodeId, slot)}
              src={url}
              ariaLabel={`${preset.label} preview page`}
              className="preview-device-webview"
              onStatus={(next) => {
                setView(next);
                onView?.(next);
              }}
              {...(onConsole === undefined ? {} : { onConsole })}
            />
            {view?.status === 'failed' ? (
              <div className="preview-surface-fallback">
                <strong>Preview unavailable</strong>
                <span>{view.failure ?? 'The page could not load.'}</span>
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => webviewRef.current?.reload()}
                >
                  Try again
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </figure>
    );
  },
);
```

`PreviewSurface.css` — append:

```css
.preview-device-webview {
  width: 100%;
  height: 100%;
}
webview.preview-device-webview {
  display: flex;
}
```

`PreviewSurface.tsx` edits (concrete):

- Remove the `Camera` import, the `operations` prop (and its type import), the screenshot button (`:166-179`), the open-external button (`:180-194`), and the `actionStatus` state + status paragraph (`:55`, `:200-204`).
- Change `primaryView` state type to `PreviewWebviewStatus | null` (import from `../webview/PreviewWebview.js`); `DeviceFrameHost` props at `:207-230` lose `operations` and gain nothing else.
- Add `const consoleBuffer = usePreviewConsoleBuffer();`, pass `onConsole={consoleBuffer.append}` to the primary `DeviceFrameHost`, replace `browserConsole={browserConsole}` state with `browserConsole={consoleBuffer.view}` and delete the old `browserConsole` state/`onConsole` wiring.
- `PreviewConsole.tsx:3-5`: import `PreviewConsoleEntry`, `PreviewConsoleView` from `'../../../../../shared/preview/console.js'` instead of the surface contracts.

`ComparisonSurface.tsx` / `PreviewComparisonPanel.tsx`: remove the `operations` prop from `ComparisonSurface` and its two `DeviceFrameHost` usages (add `readOnly` pass-through as before); `PreviewComparisonPanel` keeps `operations` only for `listTargets`.

`PreviewNodePanel.tsx`: at `:337` change the Open-preview button `disabled` to `readOnly || !ready`; at `:382-397` drop the `operations={operations}` prop from `<PreviewSurface>` and the `&& operations` condition.

- [ ] **Step 4: Run tests + typecheck.**

Run: `DeviceFrameHost.test.tsx` → PASS. Then run the preview slice: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/renderer/src/components/preview` — update `PreviewNodePanel.test.tsx` / `PreviewComparisonPanel.test.tsx` expectations that referenced `operations`-gated behavior (never weaken navigation/security assertions). Typecheck → clean.

- [ ] **Step 5: Update `e2e/preview.spec.ts`** — remove the "Save screenshot" step (`:129-130`) and any `Touchscreen mode on` badge assertion; keep the address-bar navigation-denied assertion intact.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/preview/webview/usePreviewConsoleBuffer.ts apps/desktop/src/renderer/src/components/preview/surface/DeviceFrameHost.tsx apps/desktop/src/renderer/src/components/preview/surface/DeviceFrameHost.test.tsx apps/desktop/src/renderer/src/components/preview/surface/PreviewSurface.tsx apps/desktop/src/renderer/src/components/preview/surface/PreviewSurface.css apps/desktop/src/renderer/src/components/preview/comparison/ComparisonSurface.tsx apps/desktop/src/renderer/src/components/preview/comparison/PreviewComparisonPanel.tsx apps/desktop/src/renderer/src/components/preview/PreviewNodePanel.tsx apps/desktop/src/renderer/src/components/preview/console/PreviewConsole.tsx apps/desktop/e2e/preview.spec.ts
git commit -m "feat: preview modal and comparison ride the in-DOM webview

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Also stage `PreviewNodePanel.test.tsx` / `PreviewComparisonPanel.test.tsx` if updated.)

---

### Task 6: Retire the WebContentsView surface runtime

**Files:**

- Delete: `src/main/previews/surface/runtime.ts`, `src/main/previews/surface/runtime.test.ts`, `src/main/previews/surface/security-policy.ts`
- Keep: `src/main/previews/surface/url-policy.ts` + `url-policy.test.ts` (now consumed by `webview-security.ts`)
- Modify: `src/main/previews/preview-ipc.ts` — remove the `PreviewSurfaceRuntime` field and construction (`:87`, `:103-110`), the surface schema imports (`:34-43`), all `PREVIEW_SURFACE_IPC_CHANNELS.*` handler registrations (`:153-215`), the `closeNode` finally-block in `previewsStop` (`:140-143`), `#surfaces.reset()` (`:226`), `#surfaces.dispose()` (`:257`), `#surfaces.closeOwner(ownerId)` (`:342`), and the now-unused `#sendSurface` (`:322-329`)
- Delete: `src/preload/preview/` (bridge.ts, bridge.test.ts, index.ts); Modify `src/preload/index.ts` (`:95`, `:268`)
- Delete: `src/shared/preview/surface/` (contracts.ts, contracts.test.ts, api.ts, index.ts); Modify `src/shared/api.ts` (remove `previewSurfaces: PreviewSurfaceApi;` at `:455` and its import)
- Delete: `src/renderer/src/components/preview/controller/usePreviewSurface.ts` + `usePreviewSurface.test.ts`
- Modify: `src/renderer/src/components/preview/controller/operations.ts` — shrink to `{ listTargets }`
- Test: update `src/main/previews/preview-ipc.test.ts` (remove surface-channel tests; add the absence assertion below); `grep -rn "preview-surface\|PreviewSurface\b|previewSurfaces\|usePreviewSurface" apps/desktop/src apps/desktop/e2e` must return only the renderer `PreviewSurface.tsx` modal component and its consumers

- [ ] **Step 1: Write the failing test** — add to `preview-ipc.test.ts`:

```ts
it('registers no native preview-surface channels after the webview migration', () => {
  const fixture = createFixture();
  const surfaceChannels = [...electronMock.handlers.keys()].filter((channel) =>
    channel.startsWith('preview-surface:'),
  );
  expect(surfaceChannels).toEqual([]);
  return fixture.service.dispose();
});
```

- [ ] **Step 2: Run to verify failure** — the surface channels are still registered.

- [ ] **Step 3: Implement the removals** listed under **Files**, in this order: preview-ipc.ts → preload → shared/api.ts + shared/preview/surface deletion → renderer operations.ts (`PreviewRendererOperations` becomes `{ listTargets(projectId: string): Promise<PreviewTargetView[]> }` and `browserPreviewOperations(): PreviewRendererOperations` always returns an object) → delete `usePreviewSurface` → delete main surface files. Then delete the surface-runtime tests and every `preview-ipc.test.ts` case that exercised `PREVIEW_SURFACE_IPC_CHANNELS` (their enforcement lives in `webview-security.test.ts` since Task 1). Remove the `PreviewNodePanel.tsx` `!operations` guidance block (`:345-350`) and any remaining `operations === null` branches; drop the now-unused `previewSurfaces` member from any window stubs in renderer tests (grep `previewSurfaces` under `src/renderer`).

- [ ] **Step 4: Run the full affected slices + typecheck.**

Run: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/main/previews apps/desktop/src/renderer/src/components/preview apps/desktop/src/preload` → PASS (no test may still reference the deleted modules).
Typecheck → clean.
Verify: `grep -rn "WebContentsView" apps/desktop/src --include='*.ts' --include='*.tsx'` returns nothing outside comments/tests that no longer exist.

- [ ] **Step 5: Commit.**

```bash
git add -u apps/desktop/src/main/previews apps/desktop/src/preload apps/desktop/src/shared apps/desktop/src/renderer/src/components/preview
git commit -m "feat: retire the WebContentsView preview surface runtime

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(`git add -u` is scoped; check `git status --short` for those directories and stage individually if anything unexpected appears.)

---

### Task 7: Full verification

- [ ] **Step 1:** `corepack pnpm --dir apps/desktop typecheck` → clean.
- [ ] **Step 2:** From the worktree root: `corepack pnpm test:unit` → green (record any pre-existing failures and confirm they fail identically on the pre-task baseline commit before ignoring).
- [ ] **Step 3:** Manual smoke via `corepack pnpm --dir apps/desktop dev` with a throwaway server (`python3 -m http.server 5173`) — NOTE: launching Electron from this worktree requires the electron-dist clone fix (copy `dist/` + `path.txt` from the main checkout's electron package into this worktree's; see the project memory "Worktree Electron fix"):
  - Web preview node: type `5173` → page renders on the face; reload glyph works; wheel scrolls the page without zooming/panning the canvas; node resize/collapse/expand keeps the page; delete the port → hint returns.
  - Mobile preview node: same port → device frame renders and scales with the node.
  - Security: in the previewed page, `window.open('https://example.com')` from DevTools → denied in-webview, native confirm appears, accepting opens the system browser; a link to another port/host does not navigate; DevTools on the app shows `document.querySelector('webview').partition === 'preview:<projectId>:<nodeId>'`.
  - Confirm the webview attaches at all under the sandboxed embedder — if it does not, stop and investigate `will-attach-webview`/`webviewTag`; do NOT weaken the window's `webPreferences`.
  - Inspector panel: Start preview (dev-server confirm dialog) → Open preview modal shows the webview, address bar rejects a non-loopback URL, console panel captures page logs; side-by-side comparison still renders two frames.
- [ ] **Step 4:** Optional (requires a build): `corepack pnpm --dir apps/desktop exec playwright test e2e/preview.spec.ts`.
- [ ] **Step 5:** Check off this plan's boxes and commit the plan file: `git add docs/superpowers/plans/2026-07-20-webview-preview-faces.md && git commit -m "docs: webview preview faces plan executed"` (with the co-author trailer).
