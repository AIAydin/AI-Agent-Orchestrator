import type { WebContents } from 'electron';

import { parsePreviewWebviewPartition } from '../../../shared/preview/webview-partition.js';

const MAX_TEXT_CHARACTERS = 64 * 1_024;
const MAX_DOM_CHARACTERS = 128 * 1_024;
const MAX_SCREENSHOT_BYTES = 8 * 1_024 * 1_024;

export interface AgentPreviewInspection {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly dom: string;
  readonly console: readonly string[];
}

export interface AgentPreviewScreenshot {
  readonly mimeType: 'image/png';
  readonly data: string;
}

export type AgentPreviewElementKind = 'button' | 'link' | 'text-input' | 'toggle' | 'control';

export interface AgentPreviewElement {
  readonly handle: string;
  readonly kind: AgentPreviewElementKind;
  readonly name: string;
  readonly disabled: boolean;
  readonly editable: boolean;
  readonly sensitive: boolean;
  readonly consequential: boolean;
  readonly userOnly: boolean;
  readonly destination: string | null;
}

export interface AgentPreviewElements {
  readonly pageVersion: string;
  readonly url: string;
  readonly title: string;
  readonly elements: readonly AgentPreviewElement[];
}

export type AgentPreviewAction =
  | { readonly kind: 'click'; readonly elementHandle: string }
  | {
      readonly kind: 'type';
      readonly elementHandle: string;
      readonly text: string;
      readonly replace: boolean;
    };

export interface AgentPreviewActionIntent {
  readonly pageVersion: string;
  readonly url: string;
  readonly origin: string;
  readonly action: AgentPreviewAction['kind'];
  readonly element: AgentPreviewElement;
  readonly textPreview: string | null;
  readonly textLength: number | null;
  readonly consequential: boolean;
}

export interface AgentPreviewActionResult {
  readonly performed: true;
  readonly pageVersion: string;
  readonly url: string;
}

export interface AgentPreviewSource {
  isLive(): boolean;
  inspect(): Promise<AgentPreviewInspection>;
  screenshot(): Promise<AgentPreviewScreenshot>;
  elements?(): Promise<AgentPreviewElements>;
  scroll?(deltaY: number): Promise<{ pageVersion: string; url: string }>;
  describeAction?(action: AgentPreviewAction): Promise<AgentPreviewActionIntent>;
  performAction?(
    action: AgentPreviewAction,
    expectedPageVersion: string,
  ): Promise<AgentPreviewActionResult>;
}

/**
 * Main-process registry for bounded, read-only inspection of live preview
 * guests. Authorization deliberately does not live here: AgentPeersService
 * re-checks the live canvas edge and the preview node's explicit opt-in before
 * every call, then invokes this bridge only with an authorized project/node.
 */
export class PreviewAgentBrowser {
  readonly #sources = new Map<string, AgentPreviewSource>();

  registerGuest(partition: string, contents: WebContents): void {
    const identity = parsePreviewWebviewPartition(partition);
    if (identity === null) return;
    const key = previewKey(identity.projectId, identity.nodeId);
    const existing = this.#sources.get(key);
    // Prefer the primary guest over a comparison slot for deterministic reads.
    if (existing !== undefined && identity.slot !== null) return;
    const source: AgentPreviewSource = {
      isLive: () => !contents.isDestroyed(),
      inspect: async () => {
        const result = (await contents.executeJavaScript(DOM_INSPECTION_EXPRESSION, true)) as {
          url?: unknown;
          title?: unknown;
          text?: unknown;
          dom?: unknown;
        };
        return boundedInspection(result);
      },
      screenshot: async () => {
        const data = (await contents.capturePage()).toPNG();
        if (data.byteLength > MAX_SCREENSHOT_BYTES) throw new Error('preview-screenshot-too-large');
        return { mimeType: 'image/png', data: data.toString('base64') };
      },
    };
    this.#sources.set(key, source);
    contents.once('destroyed', () => {
      if (this.#sources.get(key) === source) this.#sources.delete(key);
    });
  }

  registerSource(projectId: string, nodeId: string, source: AgentPreviewSource): () => void {
    const key = previewKey(projectId, nodeId);
    this.#sources.set(key, source);
    return () => {
      if (this.#sources.get(key) === source) this.#sources.delete(key);
    };
  }

  isLive(projectId: string, nodeId: string): boolean {
    return this.#liveSource(projectId, nodeId) !== null;
  }

  async inspect(projectId: string, nodeId: string): Promise<AgentPreviewInspection> {
    const source = this.#liveSource(projectId, nodeId);
    if (source === null) throw new Error('preview-not-live');
    return await source.inspect();
  }

  async screenshot(projectId: string, nodeId: string): Promise<AgentPreviewScreenshot> {
    const source = this.#liveSource(projectId, nodeId);
    if (source === null) throw new Error('preview-not-live');
    return await source.screenshot();
  }

  async elements(projectId: string, nodeId: string): Promise<AgentPreviewElements> {
    const source = this.#liveSource(projectId, nodeId);
    if (source === null) throw new Error('preview-not-live');
    if (source.elements === undefined) throw new Error('preview-interaction-unavailable');
    return await source.elements();
  }

  async scroll(
    projectId: string,
    nodeId: string,
    deltaY: number,
  ): Promise<{ pageVersion: string; url: string }> {
    const source = this.#liveSource(projectId, nodeId);
    if (source === null) throw new Error('preview-not-live');
    if (source.scroll === undefined) throw new Error('preview-interaction-unavailable');
    return await source.scroll(deltaY);
  }

  async describeAction(
    projectId: string,
    nodeId: string,
    action: AgentPreviewAction,
  ): Promise<AgentPreviewActionIntent> {
    const source = this.#liveSource(projectId, nodeId);
    if (source === null) throw new Error('preview-not-live');
    if (source.describeAction === undefined) throw new Error('preview-interaction-unavailable');
    return await source.describeAction(action);
  }

  async performAction(
    projectId: string,
    nodeId: string,
    action: AgentPreviewAction,
    expectedPageVersion: string,
  ): Promise<AgentPreviewActionResult> {
    const source = this.#liveSource(projectId, nodeId);
    if (source === null) throw new Error('preview-not-live');
    if (source.performAction === undefined) throw new Error('preview-interaction-unavailable');
    return await source.performAction(action, expectedPageVersion);
  }

  #liveSource(projectId: string, nodeId: string): AgentPreviewSource | null {
    const source = this.#sources.get(previewKey(projectId, nodeId));
    if (source === undefined || !source.isLive()) return null;
    return source;
  }
}

function boundedInspection(result: {
  url?: unknown;
  title?: unknown;
  text?: unknown;
  dom?: unknown;
}): AgentPreviewInspection {
  const text = typeof result.text === 'string' ? result.text.slice(0, MAX_TEXT_CHARACTERS) : '';
  return {
    url: sanitizedPageUrl(result.url),
    title: typeof result.title === 'string' ? result.title.slice(0, 1_024) : '',
    text,
    // Preserve the legacy response shape without exposing hidden elements,
    // attributes, form values, or embedded application state. Agents only
    // receive an escaped representation of the same visible text field.
    dom: visibleTextDom(text),
    // Browser console messages commonly contain access tokens, request
    // payloads, and application internals. They never cross the agent bridge.
    console: [],
  };
}

function sanitizedPageUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return `${parsed.origin}${parsed.pathname}`.slice(0, 2_048);
  } catch {
    return '';
  }
}

function visibleTextDom(text: string): string {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<body>${escaped}</body>`.slice(0, MAX_DOM_CHARACTERS);
}

function previewKey(projectId: string, nodeId: string): string {
  return `${projectId}\u0000${nodeId}`;
}

const DOM_INSPECTION_EXPRESSION = String.raw`(() => {
  const text = (document.body?.innerText ?? '').slice(0, ${String(MAX_TEXT_CHARACTERS)});
  return {
    url: (location.origin + location.pathname).slice(0, 2048),
    title: document.title,
    text,
    dom: ''
  };
})()`;
