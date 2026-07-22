import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type {
  BrowserCompanionFrame,
  BrowserCompanionFrameRequest,
  BrowserCompanionInput,
  BrowserCompanionNavigationInput,
  BrowserCompanionNodeKey,
  BrowserCompanionOpenInput,
  BrowserCompanionSnapshot,
  BrowserCompanionStatus,
  BrowserCompanionViewportInput,
} from "../../shared/browser-companion/contracts.js";
import type {
  AgentPreviewInspection,
  PreviewAgentBrowser,
} from "../previews/webview/preview-agent-browser.js";
import { CdpPipeClient, type CdpEvent } from "./cdp-pipe.js";
import { findGoogleChromeExecutable } from "./chrome-executable.js";

const MAX_SCREENSHOT_CHARACTERS = 12 * 1_024 * 1_024;
const MAX_FRAME_CHARACTERS = 6 * 1_024 * 1_024;
const MIN_FRAME_INTERVAL_MS = 33;
const TARGET_WAIT_MS = 8_000;

interface ChromeConnection {
  readonly key: string;
  readonly projectId: string;
  readonly nodeId: string;
  readonly profilePath: string;
  readonly child: ChildProcess;
  readonly client: CdpPipeClient;
  targetId: string;
  sessionId: string;
  readonly chromeVersion: string;
  requestedUrl: string;
  sharedOrigin: string;
  reattaching: Promise<void> | null;
  latestFrame: BrowserCompanionFrame | null;
  frameSequence: number;
  lastFrameAt: number;
  viewport: { width: number; height: number };
  unregisterAgentSource: () => void;
  closing: boolean;
}

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
}

export interface BrowserCompanionServiceOptions {
  readonly userDataPath: string;
  readonly previewBrowser: PreviewAgentBrowser;
  readonly findExecutable?: () => string | null;
  readonly spawnChrome?: typeof spawn;
  readonly audit?: (
    action: string,
    outcome: "allowed" | "denied" | "failed",
    metadata: Record<string, unknown>,
  ) => void;
}

/**
 * Launches one visible, node-scoped Google Chrome profile over fd-only CDP.
 * No TCP debugging port exists and the user's normal Chrome profile is never opened.
 */
export class BrowserCompanionService {
  readonly #profileRoot: string;
  readonly #previewBrowser: PreviewAgentBrowser;
  readonly #findExecutable: () => string | null;
  readonly #spawnChrome: typeof spawn;
  readonly #audit: NonNullable<BrowserCompanionServiceOptions["audit"]>;
  readonly #connections = new Map<string, ChromeConnection>();
  readonly #launches = new Map<string, Promise<BrowserCompanionStatus>>();

  constructor(options: BrowserCompanionServiceOptions) {
    this.#profileRoot = join(
      options.userDataPath,
      "browser-companion",
      "profiles",
    );
    this.#previewBrowser = options.previewBrowser;
    this.#findExecutable = options.findExecutable ?? findGoogleChromeExecutable;
    this.#spawnChrome = options.spawnChrome ?? spawn;
    this.#audit = options.audit ?? (() => undefined);
  }

  async open(
    input: BrowserCompanionOpenInput,
  ): Promise<BrowserCompanionStatus> {
    const url = validatedHttpsUrl(input.url);
    const key = connectionKey(input.projectId, input.nodeId);
    const existing = this.#connections.get(key);
    if (existing !== undefined && isChildLive(existing.child)) {
      existing.requestedUrl = url;
      existing.sharedOrigin = new URL(url).origin;
      await this.#sendToPage(existing, "Page.navigate", { url });
      await existing.client.send("Target.activateTarget", {
        targetId: existing.targetId,
      });
      this.#audit("open", "allowed", auditMetadata(input, url));
      return await this.status(input);
    }
    const pending = this.#launches.get(key);
    if (pending !== undefined) return await pending;
    const launch = this.#launch(input, url).finally(() =>
      this.#launches.delete(key),
    );
    this.#launches.set(key, launch);
    return await launch;
  }

  async status(
    input: BrowserCompanionNodeKey,
  ): Promise<BrowserCompanionStatus> {
    const connection = this.#connections.get(
      connectionKey(input.projectId, input.nodeId),
    );
    if (connection === undefined || !isChildLive(connection.child)) {
      return this.#findExecutable() === null
        ? statusView(
            "unavailable",
            null,
            "",
            null,
            "Google Chrome is not installed.",
          )
        : statusView("closed");
    }
    try {
      const page = await this.#pageMetadata(connection);
      return statusView(
        "connected",
        page.url,
        page.title,
        connection.chromeVersion,
        null,
      );
    } catch (error) {
      return statusView(
        "failed",
        null,
        "",
        connection.chromeVersion,
        errorMessage(error),
      );
    }
  }

  async focus(input: BrowserCompanionNodeKey): Promise<BrowserCompanionStatus> {
    const connection = this.#requireConnection(input);
    try {
      await connection.client.send("Target.activateTarget", {
        targetId: connection.targetId,
      });
    } catch (error) {
      if (!isRecoverableSessionError(error)) throw error;
      await this.#reattach(connection);
      await connection.client.send("Target.activateTarget", {
        targetId: connection.targetId,
      });
    }
    return await this.status(input);
  }

  async snapshot(
    input: BrowserCompanionNodeKey,
  ): Promise<BrowserCompanionSnapshot | null> {
    const connection = this.#connections.get(
      connectionKey(input.projectId, input.nodeId),
    );
    if (connection === undefined || !isChildLive(connection.child)) return null;
    const result = await this.#sendToPage<{ data?: unknown }>(
      connection,
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      },
    );
    if (
      typeof result.data !== "string" ||
      result.data.length > MAX_SCREENSHOT_CHARACTERS
    ) {
      throw new Error("Chrome returned an invalid or oversized screenshot.");
    }
    return { mimeType: "image/png", data: result.data };
  }

  frame(input: BrowserCompanionFrameRequest): BrowserCompanionFrame | null {
    const connection = this.#connections.get(
      connectionKey(input.projectId, input.nodeId),
    );
    if (connection === undefined || !isChildLive(connection.child)) return null;
    const frame = connection.latestFrame;
    return frame !== null && frame.sequence > input.afterSequence
      ? frame
      : null;
  }

  async setViewport(input: BrowserCompanionViewportInput): Promise<void> {
    const connection = this.#requireConnection(input);
    await this.#sendToPage(connection, "Emulation.setDeviceMetricsOverride", {
      width: input.width,
      height: input.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: input.width,
      screenHeight: input.height,
    });
    connection.viewport = { width: input.width, height: input.height };
    await this.#restartScreencast(connection);
  }

  async dispatchInput(input: BrowserCompanionInput): Promise<void> {
    const connection = this.#requireConnection(input);
    const event = input.event;
    if (event.kind === "pointer") {
      await this.#sendToPage(connection, "Input.dispatchMouseEvent", {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button,
        buttons: event.buttons,
        clickCount: event.clickCount,
        pointerType: "mouse",
      });
      return;
    }
    if (event.kind === "wheel") {
      await this.#sendToPage(connection, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: event.x,
        y: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: event.modifiers,
        pointerType: "mouse",
      });
      return;
    }
    if (event.kind === "text") {
      await this.#sendToPage(connection, "Input.insertText", {
        text: event.text,
      });
      return;
    }
    await this.#sendToPage(connection, "Input.dispatchKeyEvent", {
      type: event.type,
      key: event.key,
      code: event.code,
      text: event.type === "keyDown" ? event.text : "",
      unmodifiedText: event.type === "keyDown" ? event.text : "",
      modifiers: event.modifiers,
      autoRepeat: event.autoRepeat,
    });
  }

  async navigate(input: BrowserCompanionNavigationInput): Promise<void> {
    const connection = this.#requireConnection(input);
    if (input.action === "reload") {
      await this.#sendToPage(connection, "Page.reload", { ignoreCache: false });
      return;
    }
    const history = await this.#sendToPage<{
      currentIndex?: unknown;
      entries?: unknown;
    }>(connection, "Page.getNavigationHistory");
    if (
      typeof history.currentIndex !== "number" ||
      !Number.isInteger(history.currentIndex) ||
      !isUnknownArray(history.entries)
    )
      return;
    const offset = input.action === "back" ? -1 : 1;
    const entry = history.entries[history.currentIndex + offset];
    if (!isHistoryEntry(entry)) return;
    await this.#sendToPage(connection, "Page.navigateToHistoryEntry", {
      entryId: entry.id,
    });
  }

  async close(input: BrowserCompanionNodeKey): Promise<BrowserCompanionStatus> {
    await this.#stopConnection(connectionKey(input.projectId, input.nodeId));
    return statusView("closed");
  }

  async clear(input: BrowserCompanionNodeKey): Promise<BrowserCompanionStatus> {
    const key = connectionKey(input.projectId, input.nodeId);
    await this.#stopConnection(key);
    const profilePath = this.#profilePath(input.projectId, input.nodeId);
    assertOwnedProfilePath(this.#profileRoot, profilePath);
    await rm(profilePath, { recursive: true, force: true });
    this.#audit("clear-profile", "allowed", {
      projectId: input.projectId,
      nodeId: input.nodeId,
    });
    return statusView("closed");
  }

  async resetForPrivacy(): Promise<void> {
    await this.#stopAll();
    await rm(this.#profileRoot, { recursive: true, force: true });
  }

  async pause(): Promise<void> {
    await this.#stopAll();
  }

  async dispose(): Promise<void> {
    await this.#stopAll();
  }

  async #launch(
    input: BrowserCompanionOpenInput,
    url: string,
  ): Promise<BrowserCompanionStatus> {
    const executable = this.#findExecutable();
    if (executable === null) {
      this.#audit("launch", "denied", {
        ...auditMetadata(input, url),
        reason: "chrome-not-found",
      });
      return statusView(
        "unavailable",
        null,
        "",
        null,
        "Google Chrome is not installed.",
      );
    }
    const profilePath = this.#profilePath(input.projectId, input.nodeId);
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    const child = this.#spawnChrome(
      executable,
      [
        "--remote-debugging-pipe",
        `--user-data-dir=${profilePath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        url,
      ],
      {
        // fd 3/4 are the private CDP transport. Chrome diagnostics are not
        // collected, avoiding sensitive log retention and pipe backpressure.
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
        windowsHide: false,
      },
    );
    try {
      await onceSpawned(child);
      const client = new CdpPipeClient(child);
      const version = await client.send<{ product?: unknown }>(
        "Browser.getVersion",
      );
      const target = await waitForPageTarget(client, url);
      const attached = await client.send<{ sessionId?: unknown }>(
        "Target.attachToTarget",
        {
          targetId: target.targetId,
          flatten: true,
        },
      );
      if (typeof attached.sessionId !== "string") {
        throw new Error("Chrome did not create a page inspection session.");
      }
      await client.send("Runtime.enable", {}, attached.sessionId);
      await client.send("Page.enable", {}, attached.sessionId);
      const key = connectionKey(input.projectId, input.nodeId);
      const connection: ChromeConnection = {
        key,
        projectId: input.projectId,
        nodeId: input.nodeId,
        profilePath,
        child,
        client,
        targetId: target.targetId,
        sessionId: attached.sessionId,
        chromeVersion:
          typeof version.product === "string"
            ? version.product.replace(/^Chrome\//u, "")
            : "Chrome",
        requestedUrl: url,
        sharedOrigin: new URL(url).origin,
        reattaching: null,
        latestFrame: null,
        frameSequence: 0,
        lastFrameAt: 0,
        viewport: { width: 1_280, height: 800 },
        unregisterAgentSource: () => undefined,
        closing: false,
      };
      client.onEvent((event) =>
        this.#captureScreencastFrame(connection, event),
      );
      await this.#startScreencast(connection);
      connection.unregisterAgentSource = this.#previewBrowser.registerSource(
        input.projectId,
        input.nodeId,
        {
          isLive: () =>
            this.#connections.get(key) === connection && isChildLive(child),
          inspect: async () => await this.#inspect(connection),
          screenshot: async () => {
            await this.#assertSharedOrigin(connection);
            const screenshot = await this.snapshot(input);
            if (screenshot === null) throw new Error("preview-not-live");
            return screenshot;
          },
        },
      );
      this.#connections.set(key, connection);
      child.once("exit", () => this.#forgetConnection(connection));
      this.#audit("launch", "allowed", auditMetadata(input, url));
      return await this.status(input);
    } catch (error) {
      if (isChildLive(child)) child.kill("SIGTERM");
      this.#audit("launch", "failed", {
        ...auditMetadata(input, url),
        reason: errorMessage(error),
      });
      return statusView("failed", null, "", null, errorMessage(error));
    }
  }

  async #inspect(
    connection: ChromeConnection,
  ): Promise<AgentPreviewInspection> {
    const result = await this.#sendToPage<{
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    }>(connection, "Runtime.evaluate", {
      expression: DOM_INSPECTION_EXPRESSION,
      returnByValue: true,
      awaitPromise: true,
    });
    if (
      result.exceptionDetails !== undefined ||
      !isInspection(result.result?.value)
    ) {
      throw new Error("Chrome page inspection failed.");
    }
    assertSameOrigin(result.result.value.url, connection.sharedOrigin);
    // Page console output frequently contains tokens, request payloads, and
    // application internals. Agents get the visible document snapshot only.
    return { ...result.result.value, console: [] };
  }

  async #pageMetadata(
    connection: ChromeConnection,
  ): Promise<{ url: string; title: string }> {
    const result = await this.#sendToPage<{
      result?: { value?: unknown };
    }>(connection, "Runtime.evaluate", {
      expression: "({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    const value = result.result?.value;
    if (!isPageMetadata(value)) throw new Error("Chrome page is not ready.");
    return value;
  }

  async #assertSharedOrigin(connection: ChromeConnection): Promise<void> {
    const page = await this.#pageMetadata(connection);
    assertSameOrigin(page.url, connection.sharedOrigin);
  }

  async #sendToPage<Result>(
    connection: ChromeConnection,
    method: string,
    params: unknown = {},
  ): Promise<Result> {
    try {
      return await connection.client.send<Result>(
        method,
        params,
        connection.sessionId,
      );
    } catch (error) {
      if (!isRecoverableSessionError(error)) throw error;
      await this.#reattach(connection);
      return await connection.client.send<Result>(
        method,
        params,
        connection.sessionId,
      );
    }
  }

  async #reattach(connection: ChromeConnection): Promise<void> {
    if (connection.reattaching !== null) return await connection.reattaching;
    const reattaching = (async (): Promise<void> => {
      const target = await waitForPageTarget(
        connection.client,
        connection.requestedUrl,
      );
      const attached = await connection.client.send<{ sessionId?: unknown }>(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true },
      );
      if (typeof attached.sessionId !== "string") {
        throw new Error("Chrome did not restore its page session.");
      }
      connection.targetId = target.targetId;
      connection.sessionId = attached.sessionId;
      await connection.client.send("Runtime.enable", {}, connection.sessionId);
      await connection.client.send("Page.enable", {}, connection.sessionId);
      connection.latestFrame = null;
      await this.#startScreencast(connection);
    })().finally(() => {
      connection.reattaching = null;
    });
    connection.reattaching = reattaching;
    await reattaching;
  }

  async #restartScreencast(connection: ChromeConnection): Promise<void> {
    try {
      await this.#sendToPage(connection, "Page.stopScreencast");
    } catch {
      // A session with no active stream can be started directly.
    }
    connection.latestFrame = null;
    await this.#startScreencast(connection);
  }

  async #startScreencast(connection: ChromeConnection): Promise<void> {
    await this.#sendToPage(connection, "Page.startScreencast", {
      format: "jpeg",
      quality: 65,
      maxWidth: connection.viewport.width,
      maxHeight: connection.viewport.height,
      everyNthFrame: 1,
    });
  }

  #captureScreencastFrame(connection: ChromeConnection, event: CdpEvent): void {
    if (
      event.method !== "Page.screencastFrame" ||
      event.sessionId !== connection.sessionId
    )
      return;
    if (typeof event.params !== "object" || event.params === null) return;
    const params = event.params as Record<string, unknown>;
    const screencastSessionId = params["sessionId"];
    if (typeof screencastSessionId === "number") {
      void connection.client
        .send(
          "Page.screencastFrameAck",
          { sessionId: screencastSessionId },
          connection.sessionId,
        )
        .catch(() => undefined);
    }
    const data = params["data"];
    if (typeof data !== "string" || data.length > MAX_FRAME_CHARACTERS) return;
    const now = Date.now();
    if (now - connection.lastFrameAt < MIN_FRAME_INTERVAL_MS) return;
    connection.lastFrameAt = now;
    connection.frameSequence += 1;
    connection.latestFrame = {
      sequence: connection.frameSequence,
      mimeType: "image/jpeg",
      data,
    };
  }

  #requireConnection(input: BrowserCompanionNodeKey): ChromeConnection {
    const connection = this.#connections.get(
      connectionKey(input.projectId, input.nodeId),
    );
    if (connection === undefined || !isChildLive(connection.child)) {
      throw new Error("Chrome is not connected for this preview.");
    }
    return connection;
  }

  async #stopAll(): Promise<void> {
    await Promise.all(
      [...this.#connections.keys()].map(
        async (key) => await this.#stopConnection(key),
      ),
    );
  }

  async #stopConnection(key: string): Promise<void> {
    const connection = this.#connections.get(key);
    if (connection === undefined) return;
    connection.closing = true;
    connection.unregisterAgentSource();
    this.#connections.delete(key);
    try {
      await connection.client.send("Browser.close");
    } catch {
      if (isChildLive(connection.child)) connection.child.kill("SIGTERM");
    }
    await waitForExit(connection.child, 3_000);
    connection.client.close();
  }

  #forgetConnection(connection: ChromeConnection): void {
    if (this.#connections.get(connection.key) !== connection) return;
    connection.unregisterAgentSource();
    this.#connections.delete(connection.key);
    connection.client.close();
    if (!connection.closing) {
      this.#audit("closed", "allowed", {
        projectId: connection.projectId,
        nodeId: connection.nodeId,
      });
    }
  }

  #profilePath(projectId: string, nodeId: string): string {
    const digest = createHash("sha256")
      .update(`${projectId}\0${nodeId}`)
      .digest("hex");
    return join(this.#profileRoot, digest);
  }
}

function validatedHttpsUrl(candidate: string): string {
  const parsed = new URL(candidate);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(
      "External Chrome previews require a credential-free HTTPS URL.",
    );
  }
  return parsed.href;
}

function connectionKey(projectId: string, nodeId: string): string {
  return `${projectId}\0${nodeId}`;
}

function auditMetadata(
  input: BrowserCompanionNodeKey,
  url: string,
): Record<string, unknown> {
  return {
    projectId: input.projectId,
    nodeId: input.nodeId,
    origin: new URL(url).origin,
  };
}

function statusView(
  state: BrowserCompanionStatus["state"],
  url: string | null = null,
  title = "",
  chromeVersion: string | null = null,
  error: string | null = null,
): BrowserCompanionStatus {
  return { state, url, title, chromeVersion, profilePersisted: true, error };
}

function isChildLive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && !child.killed;
}

async function onceSpawned(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return;
  await new Promise<void>((resolvePromise, reject) => {
    child.once("spawn", resolvePromise);
    child.once("error", reject);
  });
}

async function waitForPageTarget(
  client: CdpPipeClient,
  expectedUrl: string,
): Promise<TargetInfo> {
  const deadline = Date.now() + TARGET_WAIT_MS;
  while (Date.now() < deadline) {
    const result = await client.send<{ targetInfos?: unknown }>(
      "Target.getTargets",
    );
    const targets = Array.isArray(result.targetInfos)
      ? result.targetInfos.filter(isTargetInfo)
      : [];
    const exact = targets.find(
      (target) => target.type === "page" && target.url === expectedUrl,
    );
    const webPage = targets.find(
      (target) => target.type === "page" && /^https:\/\//u.test(target.url),
    );
    if (exact !== undefined) return exact;
    if (webPage !== undefined) return webPage;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Chrome did not open the requested page.");
}

function isTargetInfo(value: unknown): value is TargetInfo {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["targetId"] === "string" &&
    typeof record["type"] === "string" &&
    typeof record["url"] === "string"
  );
}

function isPageMetadata(
  value: unknown,
): value is { url: string; title: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["url"] === "string" && typeof record["title"] === "string"
  );
}

function isHistoryEntry(value: unknown): value is { id: number } {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>)["id"] === "number";
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function assertSameOrigin(candidate: string, expectedOrigin: string): void {
  try {
    if (new URL(candidate).origin === expectedOrigin) return;
  } catch {
    // Fall through to the same non-disclosing authorization failure.
  }
  throw new Error("preview-origin-changed");
}

function isRecoverableSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /session with given id not found|no session with given id|target closed|no target with given id/iu.test(
    error.message,
  );
}

function isInspection(
  value: unknown,
): value is Omit<AgentPreviewInspection, "console"> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return ["url", "title", "text", "dom"].every(
    (key) => typeof record[key] === "string",
  );
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (!isChildLive(child)) return;
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => {
      if (isChildLive(child)) child.kill("SIGTERM");
      resolvePromise();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

function assertOwnedProfilePath(root: string, candidate: string): void {
  const resolvedRoot = `${resolve(root)}/`;
  if (!resolve(candidate).startsWith(resolvedRoot)) {
    throw new Error(
      "Refusing to clear a Chrome profile outside Forgeboard storage.",
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 2_048)
    : "Chrome companion failed.";
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
    url: location.href.slice(0, 2048),
    title: document.title.slice(0, 1024),
    text: (document.body?.innerText ?? '').slice(0, 65536),
    dom: clone.outerHTML.slice(0, 131072)
  };
})()`;
