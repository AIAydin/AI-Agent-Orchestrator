import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';

import {
  WebContentsView,
  type BrowserWindow,
  type Dialog,
  type NativeImage,
  type Shell,
  type WebContents,
} from 'electron';

import {
  PreviewConsoleViewSchema,
  PreviewScreenshotResultSchema,
  PreviewSurfaceEventSchema,
  PreviewSurfaceViewSchema,
  type PreviewConsoleEntry,
  type PreviewConsoleView,
  type PreviewScreenshotResult,
  type PreviewSurfaceBounds,
  type PreviewSurfaceCreateInput,
  type PreviewSurfaceEvent,
  type PreviewSurfaceHistoryInput,
  type PreviewSurfaceView,
} from '../../../shared/preview/surface/index.js';
import { installPreviewSurfaceSecurity } from './security-policy.js';
import { redactedConsoleSource, validatedSurfaceUrl } from './url-policy.js';

const MAX_CONSOLE_ENTRIES = 500;
const MAX_CONSOLE_BYTES = 256 * 1_024;
const MAX_CONSOLE_MESSAGE_BYTES = 8 * 1_024;
const MAX_SURFACES = 8;
const MAX_SURFACES_PER_NODE = 2;
const CONSOLE_NOTIFICATION_INTERVAL_MS = 100;
const CONSOLE_DISCLOSURE =
  'Console output is captured in memory only, bounded to 500 entries and 256 KiB, and may contain application data.' as const;

type SurfaceStatus = PreviewSurfaceView['status'];

interface SurfaceRecord {
  id: string;
  ownerId: string;
  parent: BrowserWindow;
  projectId: string;
  nodeId: string;
  allowed: URL;
  bounds: PreviewSurfaceBounds;
  status: SurfaceStatus;
  failure: string | null;
  view: WebContentsView;
  consoleEntries: PreviewConsoleEntry[];
  consoleBytes: number;
  consoleTruncated: boolean;
  nextSequence: number;
  touchEmulation: boolean;
  consoleNotificationTimer: ReturnType<typeof setTimeout> | null;
  attached: boolean;
  destroyed: boolean;
  uninstallSecurity: () => void;
}

export interface PreviewSurfaceRuntimeOptions {
  dialog: Pick<Dialog, 'showMessageBox' | 'showSaveDialog'>;
  shell: Pick<Shell, 'openExternal'>;
  emit: (ownerId: string, event: PreviewSurfaceEvent) => void;
  audit?: (
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ) => unknown;
  createView?: (partition: string) => WebContentsView;
  savePng?: (path: string, data: Buffer) => Promise<void>;
  now?: () => Date;
}

export class PreviewSurfaceRuntime {
  readonly #surfaces = new Map<string, SurfaceRecord>();
  readonly #byNode = new Map<string, Set<string>>();
  readonly #dialog: PreviewSurfaceRuntimeOptions['dialog'];
  readonly #shell: PreviewSurfaceRuntimeOptions['shell'];
  readonly #emit: PreviewSurfaceRuntimeOptions['emit'];
  readonly #auditEvent: NonNullable<PreviewSurfaceRuntimeOptions['audit']>;
  readonly #createView: NonNullable<PreviewSurfaceRuntimeOptions['createView']>;
  readonly #savePng: NonNullable<PreviewSurfaceRuntimeOptions['savePng']>;
  readonly #now: NonNullable<PreviewSurfaceRuntimeOptions['now']>;
  #disposed = false;

  constructor(options: PreviewSurfaceRuntimeOptions) {
    this.#dialog = options.dialog;
    this.#shell = options.shell;
    this.#emit = options.emit;
    this.#auditEvent = options.audit ?? (() => undefined);
    this.#createView =
      options.createView ??
      ((partition) =>
        new WebContentsView({
          webPreferences: {
            partition,
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false,
          },
        }));
    this.#savePng = options.savePng ?? secureWritePng;
    this.#now = options.now ?? (() => new Date());
  }

  async create(
    ownerId: string,
    parent: BrowserWindow,
    input: PreviewSurfaceCreateInput,
    authorizedUrl: string,
  ): Promise<PreviewSurfaceView> {
    this.#assertAvailable();
    let allowed: URL;
    let requested: URL;
    try {
      allowed = validatedSurfaceUrl(authorizedUrl);
      requested = validatedSurfaceUrl(input.url);
    } catch (error) {
      this.#auditInput(input, 'create', 'denied', { reason: 'invalid-local-url' });
      throw error;
    }
    if (allowed.toString() !== requested.toString()) {
      this.#auditInput(input, 'create', 'denied', { reason: 'url-not-authorized' });
      throw new Error('The preview surface URL was not authorized.');
    }
    if (this.#surfaces.size >= MAX_SURFACES) {
      this.#auditInput(input, 'create', 'denied', { reason: 'global-surface-cap' });
      throw new Error(
        'Forgeboard supports at most 8 live preview surfaces. Close one and try again.',
      );
    }
    const key = nodeKey(ownerId, input.projectId, input.nodeId);
    const nodeSurfaces = this.#byNode.get(key) ?? new Set<string>();
    if (nodeSurfaces.size >= MAX_SURFACES_PER_NODE) {
      this.#auditInput(input, 'create', 'denied', { reason: 'node-surface-cap' });
      throw new Error('This preview already has two live surfaces. Close one and try again.');
    }
    const id = randomUUID();
    const view = this.#createView(`forgeboard-preview-${id}`);
    const record: SurfaceRecord = {
      id,
      ownerId,
      parent,
      projectId: input.projectId,
      nodeId: input.nodeId,
      allowed,
      bounds: { ...input.bounds },
      status: 'loading',
      failure: null,
      view,
      consoleEntries: [],
      consoleBytes: 0,
      consoleTruncated: false,
      nextSequence: 0,
      touchEmulation: input.touchEmulation,
      consoleNotificationTimer: null,
      attached: false,
      destroyed: false,
      uninstallSecurity: () => undefined,
    };
    let failureReason = 'surface-initialization-failed';
    try {
      record.uninstallSecurity = installPreviewSurfaceSecurity(
        view.webContents,
        view.webContents.session,
        allowed,
      );
      this.#bindEvents(record);
      this.#surfaces.set(id, record);
      nodeSurfaces.add(id);
      this.#byNode.set(key, nodeSurfaces);
      this.#assertAvailable();
      this.#assertParent(record);
      if (this.#surfaces.get(id) !== record) {
        failureReason = 'owner-closed-before-attach';
        throw new Error('The preview surface owner closed before the native view was attached.');
      }
      parent.contentView.addChildView(view);
      record.attached = true;
      view.setVisible(input.bounds.visible);
      if (input.bounds.visible) view.setBounds(surfaceRectangle(input.bounds));
      try {
        await view.webContents.loadURL(authorizedUrl);
      } catch (error) {
        record.status = 'failed';
        record.failure = safeError(error);
        this.#emitChanged(record);
      }
      if (
        this.#surfaces.get(id) !== record ||
        parent.isDestroyed() ||
        view.webContents.isDestroyed()
      ) {
        failureReason = 'owner-closed-during-load';
        throw new Error('The preview surface owner closed while the page was loading.');
      }
      if (record.touchEmulation) {
        try {
          await enableTouchEmulation(view.webContents);
        } catch (error) {
          failureReason = 'touch-emulation-unavailable';
          throw new Error(`Mobile touch emulation is unavailable: ${safeError(error)}`);
        }
        if (
          this.#surfaces.get(id) !== record ||
          parent.isDestroyed() ||
          view.webContents.isDestroyed()
        ) {
          failureReason = 'owner-closed-during-touch-setup';
          throw new Error('The preview surface owner closed while touch setup was pending.');
        }
      }
      const snapshot = this.#snapshot(record);
      this.#audit(record, 'create', snapshot.status === 'failed' ? 'failed' : 'allowed', {
        urlSha256: sha256(snapshot.url),
      });
      return snapshot;
    } catch (error) {
      this.#audit(record, 'create', 'failed', { reason: failureReason });
      this.#destroy(record);
      throw error;
    }
  }

  setBounds(ownerId: string, surfaceId: string, bounds: PreviewSurfaceBounds): PreviewSurfaceView {
    const record = this.#owned(ownerId, surfaceId);
    record.bounds = { ...bounds };
    record.view.setVisible(bounds.visible);
    if (bounds.visible) record.view.setBounds(surfaceRectangle(bounds));
    return this.#snapshot(record);
  }

  async navigate(
    ownerId: string,
    surfaceId: string,
    authorizedUrl: string,
  ): Promise<PreviewSurfaceView> {
    const record = this.#owned(ownerId, surfaceId);
    const parsed = validatedSurfaceUrl(authorizedUrl);
    if (parsed.origin !== record.allowed.origin) {
      this.#audit(record, 'navigate', 'denied', { reason: 'origin-not-authorized' });
      throw new Error('Preview surface navigation must remain on its approved local origin.');
    }
    record.status = 'loading';
    record.failure = null;
    try {
      await record.view.webContents.loadURL(authorizedUrl);
    } catch (error) {
      record.status = 'failed';
      record.failure = safeError(error);
      this.#emitChanged(record);
    }
    const snapshot = this.#snapshot(record);
    this.#audit(record, 'navigate', snapshot.status === 'failed' ? 'failed' : 'allowed', {
      urlSha256: sha256(snapshot.url),
    });
    return snapshot;
  }

  reload(ownerId: string, surfaceId: string): PreviewSurfaceView {
    const record = this.#owned(ownerId, surfaceId);
    record.status = 'loading';
    record.failure = null;
    record.view.webContents.reload();
    const snapshot = this.#snapshot(record);
    this.#audit(record, 'reload', 'allowed', {});
    return snapshot;
  }

  history(ownerId: string, input: PreviewSurfaceHistoryInput): PreviewSurfaceView {
    const record = this.#owned(ownerId, input.surfaceId);
    const history = record.view.webContents.navigationHistory;
    const available = input.direction === 'back' ? history.canGoBack() : history.canGoForward();
    if (!available) {
      this.#audit(record, 'history', 'denied', {
        direction: input.direction,
        reason: 'history-unavailable',
      });
      throw new Error(
        input.direction === 'back'
          ? 'This preview has no earlier page.'
          : 'This preview has no later page.',
      );
    }
    try {
      if (input.direction === 'back') history.goBack();
      else history.goForward();
      this.#audit(record, 'history', 'allowed', { direction: input.direction });
    } catch (error) {
      this.#audit(record, 'history', 'failed', { direction: input.direction });
      throw error;
    }
    return this.#snapshot(record);
  }

  console(ownerId: string, surfaceId: string): PreviewConsoleView {
    const record = this.#owned(ownerId, surfaceId);
    return PreviewConsoleViewSchema.parse({
      entries: record.consoleEntries,
      truncated: record.consoleTruncated,
      retainedBytes: record.consoleBytes,
      disclosure: CONSOLE_DISCLOSURE,
    });
  }

  binding(ownerId: string, surfaceId: string): { projectId: string; nodeId: string } {
    const record = this.#owned(ownerId, surfaceId);
    return { projectId: record.projectId, nodeId: record.nodeId };
  }

  async screenshot(ownerId: string, surfaceId: string): Promise<PreviewScreenshotResult> {
    const record = this.#owned(ownerId, surfaceId);
    try {
      this.#assertParent(record);
      const selection = await this.#dialog.showSaveDialog(record.parent, {
        title: 'Save preview screenshot',
        defaultPath: `forgeboard-preview-${record.nodeId.replace(/[^A-Za-z0-9._-]/g, '-')}.png`,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      });
      this.#assertParent(record);
      if (selection.canceled || !selection.filePath) {
        this.#audit(record, 'screenshot', 'denied', { reason: 'native-save-cancelled' });
        return PreviewScreenshotResultSchema.parse({
          saved: false,
          width: 0,
          height: 0,
        });
      }
      assertPngPath(selection.filePath);
      const image = await record.view.webContents.capturePage();
      const size = image.getSize();
      assertImageBounds(image, size.width, size.height);
      await this.#savePng(selection.filePath, image.toPNG());
      this.#audit(record, 'screenshot', 'allowed', {
        width: size.width,
        height: size.height,
      });
      return PreviewScreenshotResultSchema.parse({ saved: true, ...size });
    } catch (error) {
      this.#audit(record, 'screenshot', 'failed', { reason: 'capture-or-write-failed' });
      throw error;
    }
  }

  async openExternal(ownerId: string, surfaceId: string): Promise<boolean> {
    const record = this.#owned(ownerId, surfaceId);
    try {
      this.#assertParent(record);
      const exactUrl = record.view.webContents.getURL();
      const parsed = validatedSurfaceUrl(exactUrl);
      if (parsed.origin !== record.allowed.origin)
        throw new Error('The current preview URL is not approved.');
      const decision = await this.#dialog.showMessageBox(record.parent, {
        type: 'warning',
        title: 'Open preview in your system browser?',
        message: 'Open this exact local preview URL outside Forgeboard?',
        detail: exactUrl,
        buttons: ['Cancel', 'Open in browser'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      this.#assertParent(record);
      if (decision.response !== 1) {
        this.#audit(record, 'open-external', 'denied', {
          reason: 'native-confirmation-cancelled',
        });
        return false;
      }
      if (record.view.webContents.getURL() !== exactUrl) {
        throw new Error('The preview navigated after approval. Review the current URL again.');
      }
      await this.#shell.openExternal(exactUrl, { activate: true });
      this.#audit(record, 'open-external', 'allowed', { urlSha256: sha256(exactUrl) });
      return true;
    } catch (error) {
      this.#audit(record, 'open-external', 'failed', { reason: 'confirmation-or-open-failed' });
      throw error;
    }
  }

  close(ownerId: string, surfaceId: string): boolean {
    const record = this.#owned(ownerId, surfaceId);
    this.#audit(record, 'close', 'allowed', {});
    this.#destroy(record);
    return true;
  }

  closeNode(ownerId: string, projectId: string, nodeId: string): void {
    const ids = this.#byNode.get(nodeKey(ownerId, projectId, nodeId));
    for (const id of [...(ids ?? [])]) {
      const record = this.#surfaces.get(id);
      if (record) this.#destroy(record);
    }
  }

  closeOwner(ownerId: string): void {
    for (const record of [...this.#surfaces.values()]) {
      if (record.ownerId === ownerId) this.#destroy(record);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const record of [...this.#surfaces.values()]) this.#destroy(record);
  }

  reset(): void {
    for (const record of [...this.#surfaces.values()]) this.#destroy(record);
  }

  #bindEvents(record: SurfaceRecord): void {
    const contents = record.view.webContents;
    contents.on('did-start-loading', () => {
      record.status = 'loading';
      this.#emitChanged(record);
    });
    contents.on('did-finish-load', () => {
      record.status = 'ready';
      record.failure = null;
      this.#emitChanged(record);
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      record.status = 'failed';
      record.failure = `${description} (${code}) while loading ${safeUrlForError(url)}`.slice(
        0,
        2_048,
      );
      this.#emitChanged(record);
    });
    contents.on('render-process-gone', (_event, details) => {
      record.status = 'failed';
      record.failure = `Preview renderer stopped: ${details.reason}`.slice(0, 2_048);
      this.#emitChanged(record);
    });
    contents.debugger.on('detach', (_event, reason) => {
      if (!record.touchEmulation || this.#surfaces.get(record.id) !== record) return;
      record.touchEmulation = false;
      record.status = 'failed';
      record.failure = `Touch emulation stopped: ${reason}`.slice(0, 2_048);
      this.#emitChanged(record);
    });
    contents.on('console-message', (_event, level, message, line, sourceId) => {
      this.#captureConsole(record, level, message, line, sourceId);
    });
  }

  #captureConsole(
    record: SurfaceRecord,
    level: number,
    message: string,
    line: number,
    sourceId: string,
  ): void {
    const bounded = boundUtf8(message, MAX_CONSOLE_MESSAGE_BYTES);
    const entry: PreviewConsoleEntry = {
      sequence: record.nextSequence++,
      capturedAt: this.#now().toISOString(),
      level: consoleLevel(level),
      message: bounded.value,
      source: redactedConsoleSource(sourceId),
      line: Number.isInteger(line) && line >= 0 ? line : null,
    };
    const bytes = Buffer.byteLength(entry.message, 'utf8');
    record.consoleEntries.push(entry);
    record.consoleBytes += bytes;
    record.consoleTruncated ||= bounded.truncated;
    while (
      record.consoleEntries.length > MAX_CONSOLE_ENTRIES ||
      record.consoleBytes > MAX_CONSOLE_BYTES
    ) {
      const removed = record.consoleEntries.shift();
      if (!removed) break;
      record.consoleBytes -= Buffer.byteLength(removed.message, 'utf8');
      record.consoleTruncated = true;
    }
    if (record.consoleNotificationTimer === null) {
      record.consoleNotificationTimer = setTimeout(() => {
        record.consoleNotificationTimer = null;
        if (record.destroyed || this.#surfaces.get(record.id) !== record) return;
        this.#emit(
          record.ownerId,
          PreviewSurfaceEventSchema.parse({
            type: 'console',
            surfaceId: record.id,
          }),
        );
      }, CONSOLE_NOTIFICATION_INTERVAL_MS);
      record.consoleNotificationTimer.unref();
    }
  }

  #snapshot(record: SurfaceRecord): PreviewSurfaceView {
    const history = record.view.webContents.navigationHistory;
    const current = record.view.webContents.getURL();
    return PreviewSurfaceViewSchema.parse({
      surfaceId: record.id,
      projectId: record.projectId,
      nodeId: record.nodeId,
      url: current === '' || current === 'about:blank' ? record.allowed.toString() : current,
      status: record.status,
      bounds: record.bounds,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      touchEmulation: record.touchEmulation,
      failure: record.failure,
    });
  }

  #emitChanged(record: SurfaceRecord): void {
    if (!this.#surfaces.has(record.id)) return;
    this.#emit(
      record.ownerId,
      PreviewSurfaceEventSchema.parse({
        type: 'changed',
        surface: this.#snapshot(record),
      }),
    );
  }

  #owned(ownerId: string, surfaceId: string): SurfaceRecord {
    this.#assertAvailable();
    const record = this.#surfaces.get(surfaceId);
    if (!record || record.ownerId !== ownerId)
      throw new Error('This preview surface belongs to another renderer.');
    return record;
  }

  #assertParent(record: SurfaceRecord): void {
    if (record.parent.isDestroyed() || record.view.webContents.isDestroyed()) {
      throw new Error('The preview surface is no longer available.');
    }
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('The preview surface runtime has been disposed.');
  }

  #audit(
    record: SurfaceRecord,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void {
    this.#auditInput(record, action, outcome, { surfaceId: record.id, ...metadata });
  }

  #auditInput(
    input: Pick<SurfaceRecord, 'projectId' | 'nodeId'>,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void {
    try {
      this.#auditEvent(action, outcome, {
        projectId: input.projectId,
        nodeId: input.nodeId,
        ...metadata,
      });
    } catch {
      // Audit storage failure cannot change an already-decided local capability.
    }
  }

  #destroy(record: SurfaceRecord): void {
    if (record.destroyed) return;
    record.destroyed = true;
    if (record.consoleNotificationTimer !== null) {
      clearTimeout(record.consoleNotificationTimer);
      record.consoleNotificationTimer = null;
    }
    this.#surfaces.delete(record.id);
    const key = nodeKey(record.ownerId, record.projectId, record.nodeId);
    const nodeSurfaces = this.#byNode.get(key);
    nodeSurfaces?.delete(record.id);
    if (nodeSurfaces?.size === 0) this.#byNode.delete(key);
    record.uninstallSecurity();
    if (record.touchEmulation && record.view.webContents.debugger.isAttached()) {
      record.view.webContents.debugger.detach();
    }
    if (record.attached && !record.parent.isDestroyed()) {
      record.parent.contentView.removeChildView(record.view);
    }
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
  }
}

function nodeKey(ownerId: string, projectId: string, nodeId: string): string {
  return `${ownerId}\0${projectId}\0${nodeId}`;
}

function surfaceRectangle(bounds: PreviewSurfaceBounds): Electron.Rectangle {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function consoleLevel(level: number): PreviewConsoleEntry['level'] {
  if (level >= 3) return 'error';
  if (level === 2) return 'warning';
  if (level === 0) return 'debug';
  return 'info';
}

function boundUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const data = Buffer.from(value, 'utf8');
  if (data.byteLength <= maxBytes) return { value, truncated: false };
  return {
    value: data
      .subarray(0, maxBytes)
      .toString('utf8')
      .replace(/\uFFFD$/u, ''),
    truncated: true,
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'The preview page could not be loaded.').slice(
    0,
    2_048,
  );
}

function safeUrlForError(candidate: string): string {
  try {
    const url = validatedSurfaceUrl(candidate);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'the approved local preview';
  }
}

function assertPngPath(path: string): void {
  if (!isAbsolute(path) || path.includes('\0') || extname(path).toLowerCase() !== '.png') {
    throw new Error(
      'Preview screenshots must use an absolute .png path selected in the native dialog.',
    );
  }
}

function assertImageBounds(image: NativeImage, width: number, height: number): void {
  if (image.isEmpty() || width < 1 || height < 1 || width > 8_192 || height > 8_192) {
    throw new Error(
      'The preview screenshot dimensions are invalid or exceed the 8192 pixel limit.',
    );
  }
}

export async function secureWritePng(
  path: string,
  data: Buffer,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const noFollow = platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | noFollow, 0o600);
  try {
    const [pathIdentity, handleIdentity] = await Promise.all([lstat(path), handle.stat()]);
    if (
      pathIdentity.isSymbolicLink() ||
      pathIdentity.dev !== handleIdentity.dev ||
      pathIdentity.ino !== handleIdentity.ino
    ) {
      throw new Error('Forgeboard refused an unsafe screenshot destination.');
    }
    await handle.truncate(0);
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function enableTouchEmulation(webContents: WebContents): Promise<void> {
  const browserDebugger = webContents.debugger;
  if (browserDebugger.isAttached()) {
    throw new Error('The preview debugger is already attached.');
  }
  browserDebugger.attach('1.3');
  try {
    await browserDebugger.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
    await browserDebugger.sendCommand('Emulation.setEmitTouchEventsForMouse', {
      enabled: true,
      configuration: 'mobile',
    });
  } catch (error) {
    if (browserDebugger.isAttached()) browserDebugger.detach();
    throw error;
  }
}
