import type { WebContents } from "electron";

import { parsePreviewWebviewPartition } from "../../../shared/preview/webview-partition.js";

const MAX_TEXT_CHARACTERS = 64 * 1_024;
const MAX_DOM_CHARACTERS = 128 * 1_024;
const MAX_CONSOLE_ENTRIES = 100;
const MAX_CONSOLE_MESSAGE_CHARACTERS = 4 * 1_024;
const MAX_SCREENSHOT_BYTES = 8 * 1_024 * 1_024;

export interface AgentPreviewInspection {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly dom: string;
  readonly console: readonly string[];
}

export interface AgentPreviewScreenshot {
  readonly mimeType: "image/png";
  readonly data: string;
}

export interface AgentPreviewSource {
  isLive(): boolean;
  inspect(): Promise<AgentPreviewInspection>;
  screenshot(): Promise<AgentPreviewScreenshot>;
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
    const console: string[] = [];
    const source: AgentPreviewSource = {
      isLive: () => !contents.isDestroyed(),
      inspect: async () => {
        const result = (await contents.executeJavaScript(
          DOM_INSPECTION_EXPRESSION,
          true,
        )) as {
          url?: unknown;
          title?: unknown;
          text?: unknown;
          dom?: unknown;
        };
        return boundedInspection(result, console);
      },
      screenshot: async () => {
        const data = (await contents.capturePage()).toPNG();
        if (data.byteLength > MAX_SCREENSHOT_BYTES)
          throw new Error("preview-screenshot-too-large");
        return { mimeType: "image/png", data: data.toString("base64") };
      },
    };
    this.#sources.set(key, source);
    contents.on("console-message", (_event, _level, message) => {
      if (typeof message !== "string" || message === "") return;
      console.push(message.slice(0, MAX_CONSOLE_MESSAGE_CHARACTERS));
      if (console.length > MAX_CONSOLE_ENTRIES) console.shift();
    });
    contents.once("destroyed", () => {
      if (this.#sources.get(key) === source) this.#sources.delete(key);
    });
  }

  registerSource(
    projectId: string,
    nodeId: string,
    source: AgentPreviewSource,
  ): () => void {
    const key = previewKey(projectId, nodeId);
    this.#sources.set(key, source);
    return () => {
      if (this.#sources.get(key) === source) this.#sources.delete(key);
    };
  }

  isLive(projectId: string, nodeId: string): boolean {
    return this.#liveSource(projectId, nodeId) !== null;
  }

  async inspect(
    projectId: string,
    nodeId: string,
  ): Promise<AgentPreviewInspection> {
    const source = this.#liveSource(projectId, nodeId);
    if (source === null) throw new Error("preview-not-live");
    return await source.inspect();
  }

  async screenshot(
    projectId: string,
    nodeId: string,
  ): Promise<AgentPreviewScreenshot> {
    const source = this.#liveSource(projectId, nodeId);
    if (source === null) throw new Error("preview-not-live");
    return await source.screenshot();
  }

  #liveSource(projectId: string, nodeId: string): AgentPreviewSource | null {
    const source = this.#sources.get(previewKey(projectId, nodeId));
    if (source === undefined || !source.isLive()) return null;
    return source;
  }
}

function boundedInspection(
  result: { url?: unknown; title?: unknown; text?: unknown; dom?: unknown },
  console: readonly string[],
): AgentPreviewInspection {
  return {
    url: typeof result.url === "string" ? result.url.slice(0, 2_048) : "",
    title: typeof result.title === "string" ? result.title.slice(0, 1_024) : "",
    text:
      typeof result.text === "string"
        ? result.text.slice(0, MAX_TEXT_CHARACTERS)
        : "",
    dom:
      typeof result.dom === "string"
        ? result.dom.slice(0, MAX_DOM_CHARACTERS)
        : "",
    console: [...console],
  };
}

function previewKey(projectId: string, nodeId: string): string {
  return `${projectId}\u0000${nodeId}`;
}

const DOM_INSPECTION_EXPRESSION = String.raw`(() => {
  const clone = document.documentElement.cloneNode(true);
  for (const element of clone.querySelectorAll('script, style, noscript')) element.remove();
  for (const element of clone.querySelectorAll('input, textarea, select')) {
    element.removeAttribute('value');
    element.removeAttribute('checked');
    element.removeAttribute('selected');
  }
  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText ?? '').slice(0, ${String(MAX_TEXT_CHARACTERS)}),
    dom: clone.outerHTML.slice(0, ${String(MAX_DOM_CHARACTERS)})
  };
})()`;
