import { randomUUID } from 'node:crypto';

import {
  ELEMENT_DESCRIPTOR_SOURCE,
  INTERACTIVE_ELEMENTS_EXPRESSION,
  parsePageElementDescriptor,
  sameElementDescriptor,
  type PageElementDescriptor,
} from '../../browser-companion/agent-control/page-scripts.js';
import { validatedSurfaceUrl } from '../surface/url-policy.js';
import type {
  AgentPreviewAction,
  AgentPreviewActionIntent,
  AgentPreviewActionResult,
  AgentPreviewElement,
  AgentPreviewElements,
  AgentPreviewInspection,
  AgentPreviewScreenshot,
  AgentPreviewSource,
} from './preview-agent-browser.js';

const MAX_TEXT_CHARACTERS = 64 * 1_024;
const MAX_DOM_CHARACTERS = 128 * 1_024;
const MAX_SCREENSHOT_BYTES = 8 * 1_024 * 1_024;
const MAX_ELEMENTS = 100;
const MAX_CONSOLE_MESSAGES = 200;
const MAX_CONSOLE_MESSAGE_CHARACTERS = 1_000;
/** Registry world: page scripts cannot reach or tamper with the handle map. */
const ISOLATED_WORLD_ID = 1_013;
const REGISTRY_NAME = '__forgeboardGuestAgent';

/**
 * The subset of Electron's guest `WebContents` surface the agent bridge
 * touches, extracted so the control flow is unit-testable without a live
 * webview.
 */
export interface PreviewGuestContents {
  isDestroyed(): boolean;
  getURL(): string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>): Promise<unknown>;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  loadURL(url: string): Promise<void>;
  sendInputEvent(event: {
    type: 'mouseDown' | 'mouseUp';
    x: number;
    y: number;
    button: 'left';
    clickCount: number;
  }): void;
  insertText(text: string): Promise<void>;
  on(event: 'console-message', listener: (...args: unknown[]) => void): unknown;
  removeListener(event: 'console-message', listener: (...args: unknown[]) => void): unknown;
}

/**
 * Builds the full observe/interact `AgentPreviewSource` for an in-DOM preview
 * webview guest. Guests are loopback-only by main-process policy (see
 * `webview-security.ts`); pages on a loopback origin — the user's own app —
 * share console output and a sanitized DOM outline, anything else falls back
 * to the visible-text-only projection external pages get. Authorization
 * (context edge + per-node opt-in + per-action approval) stays with
 * `AgentPeersService`; this module only executes already-authorized requests
 * and re-enforces the webview URL policy for navigation.
 */
export function createGuestAgentSource(contents: PreviewGuestContents): {
  source: AgentPreviewSource;
  dispose: () => void;
} {
  const consoleMessages: string[] = [];
  const onConsoleMessage = (...args: unknown[]): void => {
    const formatted = formattedConsoleMessage(args);
    if (formatted === null) return;
    consoleMessages.push(formatted);
    if (consoleMessages.length > MAX_CONSOLE_MESSAGES) consoleMessages.shift();
  };
  contents.on('console-message', onConsoleMessage);

  let pageVersion = randomUUID();
  let registry: {
    nonce: string;
    descriptors: Map<string, PageElementDescriptor>;
  } | null = null;

  const resetRegistry = (): void => {
    registry = null;
    pageVersion = randomUUID();
  };

  const runInRegistryWorld = async (code: string): Promise<unknown> => {
    const result = await contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }]);
    if (typeof result !== 'string') throw new Error('preview-elements-unavailable');
    try {
      return JSON.parse(result) as unknown;
    } catch {
      throw new Error('preview-elements-unavailable');
    }
  };

  const currentDescriptor = async (handle: string): Promise<PageElementDescriptor> => {
    if (registry === null || !registry.descriptors.has(handle)) {
      throw new Error('preview-element-handle-invalid');
    }
    const reply = unknownRecord(await runInRegistryWorld(describeScript(registry.nonce, handle)));
    if (reply?.['state'] === 'page-changed') {
      resetRegistry();
      throw new Error('preview-page-changed');
    }
    if (reply?.['state'] !== 'ok') {
      registry.descriptors.delete(handle);
      throw new Error('preview-element-handle-invalid');
    }
    const descriptor = parsePageElementDescriptor(reply['descriptor']);
    if (descriptor === null) throw new Error('preview-element-handle-invalid');
    const stored = registry.descriptors.get(handle);
    if (stored === undefined || !descriptor.connected || !sameElementDescriptor(stored, descriptor)) {
      registry.descriptors.delete(handle);
      throw new Error('preview-element-changed');
    }
    return descriptor;
  };

  const describeAction = async (action: AgentPreviewAction): Promise<AgentPreviewActionIntent> => {
    const pageUrl = loopbackPageUrl(contents.getURL());
    const descriptor = await currentDescriptor(action.elementHandle);
    if (descriptor.disabled) throw new Error('preview-element-disabled');
    if (descriptor.userOnly) throw new Error('preview-action-requires-user');
    if (descriptor.opensNewWindow) throw new Error('preview-popup-actions-are-user-only');
    if (action.kind === 'type') {
      if (!descriptor.editable || descriptor.sensitive) {
        throw new Error('preview-sensitive-entry-blocked');
      }
      if (action.text.length < 1 || action.text.length > 4_000) {
        throw new Error('preview-text-length-invalid');
      }
    }
    const crossOriginDestination =
      descriptor.destination !== null && new URL(descriptor.destination).origin !== pageUrl.origin;
    return {
      pageVersion,
      url: sanitizedPageUrl(pageUrl.href),
      origin: pageUrl.origin,
      action: action.kind,
      element: publicElement(action.elementHandle, descriptor),
      textPreview: action.kind === 'type' ? action.text : null,
      textLength: action.kind === 'type' ? action.text.length : null,
      consequential: action.kind === 'type' || descriptor.consequential || crossOriginDestination,
    };
  };

  const source: AgentPreviewSource = {
    isLive: () => !contents.isDestroyed(),

    inspect: async (): Promise<AgentPreviewInspection> => {
      const result = unknownRecord(
        await contents.executeJavaScript(GUEST_INSPECTION_EXPRESSION, true),
      );
      const text =
        typeof result?.['text'] === 'string' ? result['text'].slice(0, MAX_TEXT_CHARACTERS) : '';
      const url = sanitizedPageUrl(result?.['url']);
      const title = typeof result?.['title'] === 'string' ? result['title'].slice(0, 1_024) : '';
      if (!isLoopbackPage(result?.['url'])) {
        // Not the user's own app: visible text only, no console, no DOM.
        return { url, title, text, dom: visibleTextDom(text), console: [] };
      }
      const dom =
        typeof result?.['dom'] === 'string' && result['dom'] !== ''
          ? result['dom'].slice(0, MAX_DOM_CHARACTERS)
          : visibleTextDom(text);
      return { url, title, text, dom, console: [...consoleMessages] };
    },

    screenshot: async (): Promise<AgentPreviewScreenshot> => {
      const data = (await contents.capturePage()).toPNG();
      if (data.byteLength > MAX_SCREENSHOT_BYTES) throw new Error('preview-screenshot-too-large');
      return { mimeType: 'image/png', data: data.toString('base64') };
    },

    elements: async (): Promise<AgentPreviewElements> => {
      const pageUrl = loopbackPageUrl(contents.getURL(), 'preview-elements-unavailable');
      const nonce = randomUUID();
      const handles = Array.from({ length: MAX_ELEMENTS }, () => randomUUID());
      const reply = unknownRecord(await runInRegistryWorld(scanScript(nonce, handles)));
      const rawDescriptors = Array.isArray(reply?.['descriptors']) ? reply['descriptors'] : [];
      const descriptors = new Map<string, PageElementDescriptor>();
      const elements: AgentPreviewElement[] = [];
      // Positional pairing against the main-minted handle list: the page can
      // describe its own elements but never chooses or forges a handle.
      for (const [index, entry] of rawDescriptors.entries()) {
        if (index >= handles.length) break;
        const descriptor = parsePageElementDescriptor(entry);
        if (descriptor === null || !descriptor.connected) continue;
        const handle = handles[index]!;
        descriptors.set(handle, descriptor);
        elements.push(publicElement(handle, descriptor));
      }
      pageVersion = randomUUID();
      registry = { nonce, descriptors };
      return {
        pageVersion,
        url: sanitizedPageUrl(pageUrl.href),
        title: typeof reply?.['title'] === 'string' ? reply['title'].slice(0, 1_024) : '',
        elements,
      };
    },

    scroll: async (deltaY: number): Promise<{ pageVersion: string; url: string }> => {
      const bounded = Math.max(-1_200, Math.min(1_200, Math.round(deltaY)));
      if (bounded === 0) throw new Error('preview-scroll-delta-required');
      await contents.executeJavaScript(
        `window.scrollBy({ top: ${String(bounded)}, left: 0, behavior: 'auto' })`,
        true,
      );
      return { pageVersion, url: sanitizedPageUrl(contents.getURL()) };
    },

    describeAction,

    performAction: async (
      action: AgentPreviewAction,
      expectedPageVersion: string,
    ): Promise<AgentPreviewActionResult> => {
      if (pageVersion !== expectedPageVersion) throw new Error('preview-page-changed');
      const intent = await describeAction(action);
      if (intent.pageVersion !== expectedPageVersion) throw new Error('preview-page-changed');
      if (registry === null) throw new Error('preview-page-changed');
      if (action.kind === 'type') {
        const reply = unknownRecord(
          await runInRegistryWorld(focusScript(registry.nonce, action.elementHandle, action.replace)),
        );
        if (reply?.['focused'] !== true) throw new Error('preview-element-not-editable');
        await contents.insertText(action.text);
      } else {
        const reply = unknownRecord(
          await runInRegistryWorld(boundsScript(registry.nonce, action.elementHandle)),
        );
        const x = reply?.['x'];
        const y = reply?.['y'];
        if (
          reply?.['connected'] !== true ||
          reply['hitMatches'] !== true ||
          typeof x !== 'number' ||
          typeof y !== 'number' ||
          !Number.isFinite(x) ||
          !Number.isFinite(y)
        ) {
          throw new Error('preview-element-not-visible');
        }
        const at = { x: Math.round(x), y: Math.round(y) };
        contents.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 });
        contents.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
      }
      return { performed: true, pageVersion: expectedPageVersion, url: intent.url };
    },

    navigate: async (rawUrl: string): Promise<{ url: string }> => {
      // Same policy module the preview security layer enforces, plus a pin to
      // the committed origin: agents move within the app the user is
      // previewing, never to another local service or the open web.
      const current = loopbackPageUrl(contents.getURL(), 'preview-navigation-blocked');
      let candidate: URL;
      try {
        candidate = validatedSurfaceUrl(rawUrl);
      } catch {
        throw new Error('preview-navigation-blocked');
      }
      if (candidate.origin !== current.origin) throw new Error('preview-navigation-blocked');
      try {
        await contents.loadURL(candidate.href);
      } catch {
        throw new Error('preview-navigation-failed');
      }
      resetRegistry();
      return { url: sanitizedPageUrl(candidate.href) };
    },
  };

  return {
    source,
    dispose: () => {
      contents.removeListener('console-message', onConsoleMessage);
    },
  };
}

/** Normalizes both console-message signatures (positional legacy, event object). */
export function formattedConsoleMessage(args: readonly unknown[]): string | null {
  const first = unknownRecord(args[0]);
  if (typeof first?.['message'] === 'string') {
    return formatConsoleEntry(first['level'], first['message']);
  }
  if (typeof args[2] === 'string') return formatConsoleEntry(args[1], args[2]);
  return null;
}

function formatConsoleEntry(level: unknown, message: string): string {
  return `[${consoleLevel(level)}] ${message.slice(0, MAX_CONSOLE_MESSAGE_CHARACTERS)}`;
}

function consoleLevel(value: unknown): 'debug' | 'info' | 'warning' | 'error' {
  if (value === 0 || value === 'debug') return 'debug';
  if (value === 2 || value === 'warning') return 'warning';
  if (value === 3 || value === 'error') return 'error';
  return 'info';
}

function publicElement(handle: string, descriptor: PageElementDescriptor): AgentPreviewElement {
  return {
    handle,
    kind: descriptor.kind,
    name: descriptor.name,
    disabled: descriptor.disabled,
    editable: descriptor.editable,
    sensitive: descriptor.sensitive,
    consequential: descriptor.consequential,
    userOnly: descriptor.userOnly,
    destination: descriptor.destination,
  };
}

function isLoopbackPage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    validatedSurfaceUrl(value);
    return true;
  } catch {
    return false;
  }
}

function loopbackPageUrl(value: string, failure = 'preview-origin-changed'): URL {
  try {
    return validatedSurfaceUrl(value);
  } catch {
    throw new Error(failure);
  }
}

export function sanitizedPageUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return `${parsed.origin}${parsed.pathname}`.slice(0, 2_048);
  } catch {
    return '';
  }
}

export function visibleTextDom(text: string): string {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<body>${escaped}</body>`.slice(0, MAX_DOM_CHARACTERS);
}

/**
 * Read-only page snapshot. The DOM outline is rebuilt from scratch with an
 * attribute allowlist — no input values, no inline handlers, no script/style
 * bodies — so the page's application state stays in the page.
 */
export const GUEST_INSPECTION_EXPRESSION = String.raw`(() => {
  const text = (document.body?.innerText ?? '').slice(0, ${String(MAX_TEXT_CHARACTERS)});
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED']);
  const allowedAttributes = ['id', 'role', 'type', 'name', 'placeholder', 'href', 'src', 'alt', 'aria-label', 'data-testid', 'class'];
  const escape = (value) => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let out = '';
  const walk = (node, depth) => {
    if (out.length >= ${String(MAX_DOM_CHARACTERS)} || depth > 60) return;
    if (node.nodeType === 3) {
      const value = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (value !== '') out += escape(value.slice(0, 2000));
      return;
    }
    if (node.nodeType !== 1 || skip.has(node.tagName)) return;
    const tag = node.tagName.toLowerCase();
    let attributes = '';
    for (const name of allowedAttributes) {
      const value = node.getAttribute(name);
      if (value === null || value === '') continue;
      attributes += ' ' + name + '="' + escape(String(value).slice(0, 200)) + '"';
    }
    out += '<' + tag + attributes + '>';
    for (const child of node.childNodes) {
      if (out.length >= ${String(MAX_DOM_CHARACTERS)}) break;
      walk(child, depth + 1);
    }
    out += '</' + tag + '>';
  };
  if (document.body) walk(document.body, 0);
  return {
    url: (location.origin + location.pathname).slice(0, 2048),
    title: document.title.slice(0, 1024),
    text,
    dom: out.slice(0, ${String(MAX_DOM_CHARACTERS)})
  };
})()`;

function scanScript(nonce: string, handles: readonly string[]): string {
  return String.raw`(() => {
  const handles = ${JSON.stringify(handles)};
  const describe = ${ELEMENT_DESCRIPTOR_SOURCE};
  const found = ${INTERACTIVE_ELEMENTS_EXPRESSION};
  const registry = { nonce: ${JSON.stringify(nonce)}, elements: new Map() };
  globalThis.${REGISTRY_NAME} = registry;
  const described = [];
  for (let index = 0; index < found.length && index < handles.length; index += 1) {
    registry.elements.set(handles[index], found[index]);
    described.push(describe(found[index]));
  }
  return JSON.stringify({ title: document.title.slice(0, 1024), descriptors: described });
})()`;
}

function describeScript(nonce: string, handle: string): string {
  return String.raw`(() => {
  const registry = globalThis.${REGISTRY_NAME};
  if (!registry || registry.nonce !== ${JSON.stringify(nonce)}) {
    return JSON.stringify({ state: 'page-changed' });
  }
  const element = registry.elements.get(${JSON.stringify(handle)});
  if (!element) return JSON.stringify({ state: 'unknown-handle' });
  const describe = ${ELEMENT_DESCRIPTOR_SOURCE};
  return JSON.stringify({ state: 'ok', descriptor: describe(element) });
})()`;
}

function boundsScript(nonce: string, handle: string): string {
  return String.raw`(() => {
  const registry = globalThis.${REGISTRY_NAME};
  if (!registry || registry.nonce !== ${JSON.stringify(nonce)}) {
    return JSON.stringify({ connected: false, hitMatches: false });
  }
  const element = registry.elements.get(${JSON.stringify(handle)});
  if (!element || element.isConnected !== true) {
    return JSON.stringify({ connected: false, hitMatches: false });
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return JSON.stringify({ connected: true, hitMatches: false });
  }
  const x = Math.max(0, Math.min(window.innerWidth - 1, rect.x + rect.width / 2));
  const y = Math.max(0, Math.min(window.innerHeight - 1, rect.y + rect.height / 2));
  const hit = document.elementFromPoint(x, y);
  return JSON.stringify({
    connected: true,
    hitMatches: hit === element || (hit !== null && element.contains(hit)),
    x,
    y
  });
})()`;
}

function focusScript(nonce: string, handle: string, replace: boolean): string {
  return String.raw`(() => {
  const registry = globalThis.${REGISTRY_NAME};
  if (!registry || registry.nonce !== ${JSON.stringify(nonce)}) {
    return JSON.stringify({ focused: false });
  }
  const element = registry.elements.get(${JSON.stringify(handle)});
  if (!element || element.isConnected !== true) return JSON.stringify({ focused: false });
  element.focus({ preventScroll: true });
  if (document.activeElement !== element) return JSON.stringify({ focused: false });
  if (${JSON.stringify(replace)}) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.select();
    } else if (element.isContentEditable) {
      const selection = document.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  return JSON.stringify({ focused: document.activeElement === element });
})()`;
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
