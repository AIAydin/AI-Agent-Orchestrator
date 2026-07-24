import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { CanvasEdge, CanvasNode } from '@forgeboard/core/domain';

import { AgentPeersAdapterIdSchema } from '../../shared/agent-peers/index.js';
import { TerminalArgumentsSchema } from '../../shared/terminal/index.js';
import type {
  AgentPreviewAction,
  AgentPreviewActionIntent,
  AgentPreviewActionResult,
  AgentPreviewElements,
} from '../previews/webview/preview-agent-browser.js';
import { findPeerByName, resolvePeers, type PeerDescriptor } from './peer-graph.js';
import {
  parseActionRequest,
  parseScrollRequest,
  type PreviewActionAuthorizer,
} from './preview-control/contracts.js';

const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_MESSAGE_BYTES = 60_000;
const MAX_PREVIEW_ACTION_BYTES = 8_000;
const SCREEN_TAIL_BYTES = 64 * 1024;
/** Provisions that never get bound to a session (spawn failed, etc.) are reclaimed lazily. */
const PROVISION_EXPIRY_MS = 5 * 60_000;

export interface AgentPeersTerminalBridge {
  findActiveSessionByNode(projectId: string, nodeId: string): { sessionId: string } | null;
  deliverPeerInput(
    sessionId: string,
    sender: string,
    message: string,
  ): Promise<'delivered' | 'no-live-session'>;
  readTranscriptTail(sessionId: string, maxBytes: number): Promise<string | null>;
}

export interface AgentPeersStore {
  loadCanvas(projectId: string): { nodes: CanvasNode[]; edges: CanvasEdge[] } | null;
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void;
}

export interface AgentPeersPreviewBridge {
  isLive(projectId: string, nodeId: string): boolean;
  inspect(
    projectId: string,
    nodeId: string,
  ): Promise<{
    url: string;
    title: string;
    text: string;
    dom: string;
    console: readonly string[];
  }>;
  screenshot(projectId: string, nodeId: string): Promise<{ mimeType: 'image/png'; data: string }>;
  elements(projectId: string, nodeId: string): Promise<AgentPreviewElements>;
  scroll(
    projectId: string,
    nodeId: string,
    deltaY: number,
  ): Promise<{ pageVersion: string; url: string }>;
  describeAction(
    projectId: string,
    nodeId: string,
    action: AgentPreviewAction,
  ): Promise<AgentPreviewActionIntent>;
  performAction(
    projectId: string,
    nodeId: string,
    action: AgentPreviewAction,
    expectedPageVersion: string,
  ): Promise<AgentPreviewActionResult>;
}

export interface PeerProvision {
  readonly provisionId: string;
  /** `http://127.0.0.1:<port>` — localhost-only, no external interface is ever bound. */
  readonly url: string;
}

export interface AgentPeerLaunchMaterial {
  readonly projectId: string;
  readonly nodeId: string;
  readonly adapterId: string;
  readonly arguments: readonly string[];
}

interface ProvisionRecord {
  readonly provisionId: string;
  readonly token: string;
  readonly projectId: string;
  readonly nodeId: string;
  sessionId: string | null;
  launchMaterial: AgentPeerLaunchMaterial | null;
  readonly createdAt: number;
}

interface CallerContext {
  readonly callerName: string;
  readonly peers: PeerDescriptor[];
}

type MessageDeliveredListener = (event: { projectId: string; edgeId: string }) => void;

/**
 * The agent-peers hub: a localhost-only HTTP server the `peer-mcp` stdio shim calls (via a
 * per-session bearer token minted by `provision`) to list peers, deliver messages, and read a
 * peer's screen. Every request is authenticated before any routing decision — there is no
 * unauthenticated endpoint, not even for error reporting — and the server never binds anything
 * but `127.0.0.1`, so it is unreachable from outside the machine.
 */
export class AgentPeersService {
  readonly #store: AgentPeersStore;
  readonly #bridge: AgentPeersTerminalBridge;
  readonly #now: () => number;
  readonly #previews: AgentPeersPreviewBridge | null;
  readonly #authorizePreviewAction: PreviewActionAuthorizer;

  #server: Server | null = null;
  #port: number | null = null;

  readonly #provisionsById = new Map<string, ProvisionRecord>();
  readonly #provisionsByToken = new Map<string, ProvisionRecord>();
  readonly #provisionIdBySession = new Map<string, string>();
  readonly #cleanupsByProvision = new Map<string, Array<() => Promise<void>>>();
  readonly #rateLimitHits = new Map<string, number[]>();
  readonly #messageListeners = new Set<MessageDeliveredListener>();
  readonly #pendingPreviewActions = new Set<string>();

  readonly #handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    void this.#route(request, response);
  };

  constructor(
    store: AgentPeersStore,
    bridge: AgentPeersTerminalBridge,
    now: () => number = Date.now,
    previews: AgentPeersPreviewBridge | null = null,
    authorizePreviewAction: PreviewActionAuthorizer = () => Promise.resolve(false),
  ) {
    this.#store = store;
    this.#bridge = bridge;
    this.#now = now;
    this.#previews = previews;
    this.#authorizePreviewAction = authorizePreviewAction;
  }

  /** Starts the hub lazily (first call only) and mints a fresh token for this node's session. */
  async provision(projectId: string, nodeId: string): Promise<PeerProvision> {
    await this.#ensureListening();
    this.#pruneExpiredProvisions();
    const provisionId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const record: ProvisionRecord = {
      provisionId,
      token,
      projectId,
      nodeId,
      sessionId: null,
      launchMaterial: null,
      createdAt: this.#now(),
    };
    this.#provisionsById.set(provisionId, record);
    this.#provisionsByToken.set(token, record);
    return { provisionId, url: this.#originUrl() };
  }

  /**
   * Single consumer: TerminalService, once, at spawn time — the env vars it injects into the
   * child process so `peer-mcp` can reach the hub.
   */
  environmentForProvision(provisionId: string): Record<string, string> | null {
    this.#pruneExpiredProvisions();
    const record = this.#provisionsById.get(provisionId);
    if (record === undefined || this.#port === null) return null;
    return {
      FORGEBOARD_PEER_URL: this.#originUrl(),
      FORGEBOARD_PEER_TOKEN: record.token,
    };
  }

  /**
   * Records the exact provider arguments created inside Electron main. Automatic Agent launches
   * consume this record instead of trusting the renderer's copy of `extraArguments`.
   */
  registerLaunchMaterial(
    provisionId: string,
    adapterId: string,
    arguments_: readonly string[],
  ): void {
    this.#pruneExpiredProvisions();
    const record = this.#provisionsById.get(provisionId);
    if (record === undefined || record.sessionId !== null) {
      throw new Error('Peer session expired. Start again.');
    }
    if (record.launchMaterial !== null) {
      throw new Error('Peer launch material was already registered.');
    }
    record.launchMaterial = {
      projectId: record.projectId,
      nodeId: record.nodeId,
      adapterId: AgentPeersAdapterIdSchema.parse(adapterId),
      arguments: TerminalArgumentsSchema.parse([...arguments_]),
    };
  }

  /** Main-process-only exact launch metadata for automatic Agent command reconstruction. */
  launchMaterialForProvision(provisionId: string): AgentPeerLaunchMaterial | null {
    this.#pruneExpiredProvisions();
    const material = this.#provisionsById.get(provisionId)?.launchMaterial;
    return material === null || material === undefined
      ? null
      : { ...material, arguments: [...material.arguments] };
  }

  /** Binds a provision to its spawned session, which exempts it from unbound-provision expiry. */
  bindSession(provisionId: string, sessionId: string): void {
    const record = this.#provisionsById.get(provisionId);
    if (record === undefined) return;
    if (record.sessionId !== null && record.sessionId !== sessionId) {
      this.#provisionIdBySession.delete(record.sessionId);
    }
    record.sessionId = sessionId;
    this.#provisionIdBySession.set(sessionId, provisionId);
  }

  /** Invalidates the session's token immediately and runs any registered cleanup, best-effort. */
  releaseSession(sessionId: string): void {
    const provisionId = this.#provisionIdBySession.get(sessionId);
    if (provisionId === undefined) return;
    this.#provisionIdBySession.delete(sessionId);
    const record = this.#provisionsById.get(provisionId);
    if (record !== undefined) {
      this.#provisionsById.delete(provisionId);
      this.#provisionsByToken.delete(record.token);
    }
    const cleanups = this.#cleanupsByProvision.get(provisionId) ?? [];
    this.#cleanupsByProvision.delete(provisionId);
    for (const cleanup of cleanups) {
      cleanup().catch(() => {
        // Best-effort: a cleanup failure must not block session teardown.
      });
    }
  }

  /** Task 9 registers provider-config cleanup here, keyed by provision (not session). */
  registerCleanup(provisionId: string, cleanup: () => Promise<void>): void {
    const cleanups = this.#cleanupsByProvision.get(provisionId) ?? [];
    cleanups.push(cleanup);
    this.#cleanupsByProvision.set(provisionId, cleanups);
  }

  onMessageDelivered(listener: MessageDeliveredListener): () => void {
    this.#messageListeners.add(listener);
    return () => {
      this.#messageListeners.delete(listener);
    };
  }

  async pauseForShutdown(): Promise<void> {
    await this.#runRegisteredCleanups();
    await this.#stopServer();
    this.#clearProvisionState();
  }

  async pauseForDataMutation(): Promise<void> {
    await this.#runRegisteredCleanups();
    await this.#stopServer();
    this.#clearProvisionState();
  }

  async resetForPrivacy(): Promise<void> {
    await this.#runRegisteredCleanups();
    await this.#stopServer();
    this.#clearProvisionState();
  }

  /** No-op: `provision()` restarts the hub lazily the next time it's called. */
  resumeAfterPrivacyReset(): void {
    // Intentionally empty.
  }

  async dispose(): Promise<void> {
    await this.#runRegisteredCleanups();
    await this.#stopServer();
    this.#clearProvisionState();
    this.#messageListeners.clear();
  }

  // ---------------------------------------------------------------------------------------
  // HTTP server lifecycle
  // ---------------------------------------------------------------------------------------

  async #ensureListening(): Promise<void> {
    if (this.#server !== null) return;
    const server = createServer(this.#handleRequest);
    // Permanent handler: without it, a fault after startup (once the `once` listener below has
    // either fired and detached, or never fires again) would leave zero 'error' listeners and
    // crash the process. Best-effort: nothing to do but not let it become unhandled.
    server.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('agent-peers hub failed to bind a localhost port');
    }
    this.#server = server;
    this.#port = address.port;
  }

  async #stopServer(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  #originUrl(): string {
    return `http://127.0.0.1:${String(this.#port)}`;
  }

  /**
   * Runs every still-registered cleanup (i.e. not already run by `releaseSession` for its
   * provision) before a teardown path wipes provision state, so privacy-sensitive on-disk
   * artifacts (see `registerCleanup`) are never silently dropped. Best-effort, mirroring
   * `releaseSession`'s fire-and-forget pattern, but awaited here so a slow cleanup is given the
   * chance to finish before the caller proceeds — a rejection can never crash teardown.
   */
  async #runRegisteredCleanups(): Promise<void> {
    const cleanups = [...this.#cleanupsByProvision.values()].flat();
    this.#cleanupsByProvision.clear();
    await Promise.allSettled(
      cleanups.map((cleanup) =>
        cleanup().catch(() => {
          // Best-effort: a cleanup failure must not block teardown.
        }),
      ),
    );
  }

  #clearProvisionState(): void {
    this.#provisionsById.clear();
    this.#provisionsByToken.clear();
    this.#provisionIdBySession.clear();
    this.#rateLimitHits.clear();
    this.#pendingPreviewActions.clear();
  }

  #pruneExpiredProvisions(): void {
    const now = this.#now();
    for (const record of this.#provisionsById.values()) {
      if (record.sessionId === null && now - record.createdAt > PROVISION_EXPIRY_MS) {
        this.#provisionsById.delete(record.provisionId);
        this.#provisionsByToken.delete(record.token);
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------------------

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const token = this.#extractBearerToken(request.headers.authorization);
      const provision = token === null ? undefined : this.#resolveProvisionByToken(token);
      if (provision === undefined) {
        this.#respondJson(response, 401, { error: 'unauthorized' });
        return;
      }

      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/v1/peers') {
        this.#handlePeers(provision, response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/message') {
        await this.#handleMessage(provision, request, response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/screen') {
        await this.#handleScreen(provision, url, response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/previews') {
        this.#handlePreviews(provision, response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/videos') {
        this.#handleVideos(provision, response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/preview') {
        await this.#handlePreviewRead(provision, url, response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/preview/screenshot') {
        await this.#handlePreviewScreenshot(provision, url, response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/preview/elements') {
        await this.#handlePreviewElements(provision, url, response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/preview/scroll') {
        await this.#handlePreviewScroll(provision, request, response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/preview/action') {
        await this.#handlePreviewAction(provision, request, response);
        return;
      }
      this.#respondJson(response, 404, { error: 'not-found' });
    } catch {
      if (!response.headersSent) this.#respondJson(response, 500, { error: 'internal-error' });
    }
  }

  #extractBearerToken(header: string | undefined): string | null {
    if (header === undefined) return null;
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) return null;
    const token = header.slice(prefix.length).trim();
    return token === '' ? null : token;
  }

  #resolveProvisionByToken(token: string): ProvisionRecord | undefined {
    this.#pruneExpiredProvisions();
    return this.#provisionsByToken.get(token);
  }

  /**
   * Resolves the caller's own display name (its node title, not a peer's) and its peer list from
   * the live canvas. Returns `null` if the project or the caller's own node has since vanished
   * from the canvas — a condition every route must handle as a graceful 404, never a crash.
   */
  #resolveCallerContext(provision: ProvisionRecord): CallerContext | null {
    const canvas = this.#store.loadCanvas(provision.projectId);
    if (canvas === null) return null;
    const callerNode = canvas.nodes.find((node) => node.id === provision.nodeId);
    if (callerNode === undefined) return null;
    return {
      callerName: callerNode.title,
      peers: resolvePeers(canvas.nodes, canvas.edges, provision.nodeId),
    };
  }

  // ---------------------------------------------------------------------------------------
  // GET /v1/peers
  // ---------------------------------------------------------------------------------------

  #handlePeers(provision: ProvisionRecord, response: ServerResponse): void {
    const context = this.#resolveCallerContext(provision);
    if (context === null) {
      this.#respondJson(response, 404, { error: 'unknown-node' });
      return;
    }
    const agents = context.peers.map((peer) => ({
      name: peer.name,
      provider: peer.provider,
      live: this.#bridge.findActiveSessionByNode(provision.projectId, peer.nodeId) !== null,
      muted: peer.muted,
    }));
    this.#respondJson(response, 200, { agents });
  }

  // ---------------------------------------------------------------------------------------
  // POST /v1/message
  // ---------------------------------------------------------------------------------------

  async #handleMessage(
    provision: ProvisionRecord,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.#readBody(request, MAX_MESSAGE_BYTES);
    if (body === null) {
      // The client may still be mid-upload; don't reuse this connection for another request.
      response.setHeader('Connection', 'close');
      this.#respondJson(response, 413, { error: 'message-too-large' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
    } catch {
      this.#respondJson(response, 400, { error: 'invalid-json' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.#respondJson(response, 400, { error: 'invalid-body' });
      return;
    }
    const to = (parsed as Record<string, unknown>)['to'];
    const message = (parsed as Record<string, unknown>)['message'];
    if (typeof to !== 'string' || typeof message !== 'string') {
      this.#respondJson(response, 400, { error: 'invalid-body' });
      return;
    }

    const context = this.#resolveCallerContext(provision);
    if (context === null) {
      this.#respondJson(response, 404, { error: 'unknown-node' });
      return;
    }

    const auditBase = {
      projectId: provision.projectId,
      nodeId: provision.nodeId,
      to,
    };
    const peer = findPeerByName(context.peers, to);
    if (peer === undefined) {
      this.#audit('denied', { ...auditBase, reason: 'unknown-peer' });
      this.#respondJson(response, 200, { result: 'unknown-peer' });
      return;
    }
    if (peer.muted) {
      this.#audit('denied', {
        ...auditBase,
        edgeId: peer.edgeId,
        reason: 'muted',
      });
      this.#respondJson(response, 200, { result: 'muted' });
      return;
    }
    if (this.#isRateLimited(peer.edgeId)) {
      this.#audit('denied', {
        ...auditBase,
        edgeId: peer.edgeId,
        reason: 'rate-limited',
      });
      this.#respondJson(response, 200, { result: 'rate-limited' });
      return;
    }
    const session = this.#bridge.findActiveSessionByNode(provision.projectId, peer.nodeId);
    if (session === null) {
      this.#audit('denied', {
        ...auditBase,
        edgeId: peer.edgeId,
        reason: 'no-live-session',
      });
      this.#respondJson(response, 200, { result: 'no-live-session' });
      return;
    }
    const outcome = await this.#bridge.deliverPeerInput(
      session.sessionId,
      context.callerName,
      message,
    );
    if (outcome === 'no-live-session') {
      this.#audit('denied', {
        ...auditBase,
        edgeId: peer.edgeId,
        reason: 'no-live-session',
      });
      this.#respondJson(response, 200, { result: 'no-live-session' });
      return;
    }
    this.#audit('allowed', { ...auditBase, edgeId: peer.edgeId });
    this.#emitMessageDelivered({
      projectId: provision.projectId,
      edgeId: peer.edgeId,
    });
    this.#respondJson(response, 200, { result: 'delivered' });
  }

  /** Reads the request body up to `maxBytes`, enforcing the cap while reading — never buffering
   * an unbounded amount before checking. Returns `null` on overflow. */
  async #readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      total += chunk.byteLength;
      if (total > maxBytes) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async #readJsonBody(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
    const bytes = await this.#readBody(request, MAX_PREVIEW_ACTION_BYTES);
    if (bytes === null) {
      this.#respondJson(response, 413, { error: 'preview-action-too-large' });
      return null;
    }
    try {
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        this.#respondJson(response, 400, { error: 'invalid-json-body' });
        return null;
      }
      return parsed;
    } catch {
      this.#respondJson(response, 400, { error: 'invalid-json' });
      return null;
    }
  }

  /** Sliding 60s window, max 6 per edge. Uses the injected clock so tests are deterministic. */
  #isRateLimited(edgeId: string): boolean {
    const now = this.#now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const recent = (this.#rateLimitHits.get(edgeId) ?? []).filter(
      (timestamp) => timestamp > windowStart,
    );
    if (recent.length >= RATE_LIMIT_MAX) {
      this.#rateLimitHits.set(edgeId, recent);
      return true;
    }
    recent.push(now);
    this.#rateLimitHits.set(edgeId, recent);
    return false;
  }

  #audit(outcome: 'allowed' | 'denied', metadata: Record<string, unknown>): void {
    try {
      this.#store.appendAudit('agent-peers', 'message', outcome, metadata);
    } catch {
      // Best-effort: an audit failure must not break message delivery.
    }
  }

  #emitMessageDelivered(event: { projectId: string; edgeId: string }): void {
    for (const listener of this.#messageListeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving listener must not break delivery or other listeners.
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // GET /v1/screen
  // ---------------------------------------------------------------------------------------

  async #handleScreen(
    provision: ProvisionRecord,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const name = (url.searchParams.get('agent') ?? '').trim();
    if (name === '') {
      this.#respondJson(response, 400, { error: 'missing-agent' });
      return;
    }
    const context = this.#resolveCallerContext(provision);
    if (context === null) {
      this.#respondJson(response, 404, { error: 'unknown-node' });
      return;
    }
    const peer = findPeerByName(context.peers, name);
    if (peer === undefined) {
      this.#respondJson(response, 404, { error: 'unknown-peer' });
      return;
    }
    const session = this.#bridge.findActiveSessionByNode(provision.projectId, peer.nodeId);
    if (session === null) {
      this.#respondJson(response, 404, { error: 'no-live-session' });
      return;
    }
    const text = await this.#bridge.readTranscriptTail(session.sessionId, SCREEN_TAIL_BYTES);
    this.#respondJson(response, 200, { text: text ?? '' });
  }

  // ---------------------------------------------------------------------------------------
  // Read-only connected preview access
  // ---------------------------------------------------------------------------------------

  #handlePreviews(provision: ProvisionRecord, response: ServerResponse): void {
    const connected = this.#connectedPreviews(provision);
    if (connected === null) {
      this.#respondJson(response, 404, { error: 'unknown-node' });
      return;
    }
    this.#respondJson(response, 200, {
      previews: connected.map((entry) => ({
        id: entry.node.id,
        name: entry.node.title,
        kind: entry.node.type,
        readable: entry.node.data.agentBrowserAccess,
        interactive: entry.node.data.agentBrowserAccess && entry.node.data.agentBrowserInteraction,
        live: this.#previews?.isLive(provision.projectId, entry.node.id) ?? false,
      })),
    });
  }

  #handleVideos(provision: ProvisionRecord, response: ServerResponse): void {
    const videos = this.#connectedVideos(provision);
    if (videos === null) {
      this.#respondJson(response, 404, { error: 'unknown-node' });
      return;
    }
    this.#auditVideoList(
      provision,
      videos.map((node) => node.id),
    );
    this.#respondJson(response, 200, {
      videos: videos.map((node) => ({
        id: node.id,
        name: node.title,
        relativePath: node.data.file!.relativePath,
        available: node.data.file!.missing === false,
      })),
    });
  }

  #connectedVideos(
    provision: ProvisionRecord,
  ): Array<Extract<CanvasNode, { type: 'video' }>> | null {
    const canvas = this.#store.loadCanvas(provision.projectId);
    if (canvas === null) return null;
    const caller = canvas.nodes.find((node) => node.id === provision.nodeId);
    if (caller === undefined || caller.type !== 'agent') return null;
    const approvedIds = new Set(caller.data.contextAttachmentIds);
    for (const edge of canvas.edges) {
      if (edge.type !== 'context' || edge.config.muted) continue;
      if (edge.sourceNodeId === caller.id) approvedIds.add(edge.targetNodeId);
      if (edge.targetNodeId === caller.id) approvedIds.add(edge.sourceNodeId);
    }
    return canvas.nodes.filter(
      (node): node is Extract<CanvasNode, { type: 'video' }> =>
        node.type === 'video' &&
        approvedIds.has(node.id) &&
        node.data.file !== undefined &&
        node.data.file.projectId === provision.projectId &&
        node.data.file.kind === 'file',
    );
  }

  #auditVideoList(provision: ProvisionRecord, videoIds: readonly string[]): void {
    try {
      this.#store.appendAudit('agent-peers', 'list-videos', 'allowed', {
        projectId: provision.projectId,
        nodeId: provision.nodeId,
        videoIds: [...videoIds],
      });
    } catch {
      // Audit storage failure must not expose more data or crash the request.
    }
  }

  async #handlePreviewRead(
    provision: ProvisionRecord,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const previewId = (url.searchParams.get('previewId') ?? '').trim();
    const preview = this.#authorizedPreview(provision, previewId);
    if (preview === null) {
      this.#auditPreview(provision, previewId, 'denied');
      this.#respondJson(response, 403, { error: 'preview-access-denied' });
      return;
    }
    if (this.#previews === null) {
      this.#respondJson(response, 404, { error: 'preview-not-live' });
      return;
    }
    try {
      const inspection = await this.#previews.inspect(provision.projectId, preview.node.id);
      this.#auditPreview(provision, preview.node.id, 'allowed');
      this.#respondJson(response, 200, inspection);
    } catch {
      this.#respondJson(response, 404, { error: 'preview-not-live' });
    }
  }

  async #handlePreviewScreenshot(
    provision: ProvisionRecord,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const previewId = (url.searchParams.get('previewId') ?? '').trim();
    const preview = this.#authorizedPreview(provision, previewId);
    if (preview === null) {
      this.#auditPreview(provision, previewId, 'denied');
      this.#respondJson(response, 403, { error: 'preview-access-denied' });
      return;
    }
    if (this.#previews === null) {
      this.#respondJson(response, 404, { error: 'preview-not-live' });
      return;
    }
    try {
      const screenshot = await this.#previews.screenshot(provision.projectId, preview.node.id);
      this.#auditPreview(provision, preview.node.id, 'allowed', 'screenshot');
      this.#respondJson(response, 200, screenshot);
    } catch {
      this.#respondJson(response, 404, { error: 'preview-not-live' });
    }
  }

  async #handlePreviewElements(
    provision: ProvisionRecord,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const previewId = (url.searchParams.get('previewId') ?? '').trim();
    const preview = this.#authorizedPreview(provision, previewId, true);
    if (preview === null) {
      this.#auditPreview(provision, previewId, 'denied', 'inspect-elements');
      this.#respondJson(response, 403, { error: 'preview-interaction-denied' });
      return;
    }
    if (this.#previews === null) {
      this.#respondJson(response, 404, { error: 'preview-not-live' });
      return;
    }
    try {
      const elements = await this.#previews.elements(provision.projectId, preview.node.id);
      this.#auditPreview(provision, preview.node.id, 'allowed', 'inspect-elements');
      this.#respondJson(response, 200, elements);
    } catch (error) {
      this.#respondJson(response, 409, {
        error: safePreviewActionError(error),
      });
    }
  }

  async #handlePreviewScroll(
    provision: ProvisionRecord,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.#readJsonBody(request, response);
    if (body === null) return;
    const input = parseScrollRequest(body);
    if (input === null) {
      this.#respondJson(response, 400, { error: 'invalid-preview-scroll' });
      return;
    }
    const preview = this.#authorizedPreview(provision, input.previewId, true);
    if (preview === null) {
      this.#auditPreview(provision, input.previewId, 'denied', 'scroll');
      this.#respondJson(response, 403, { error: 'preview-interaction-denied' });
      return;
    }
    if (this.#previews === null) {
      this.#respondJson(response, 404, { error: 'preview-not-live' });
      return;
    }
    try {
      const result = await this.#previews.scroll(
        provision.projectId,
        preview.node.id,
        input.deltaY,
      );
      this.#auditPreview(provision, preview.node.id, 'allowed', 'scroll');
      this.#respondJson(response, 200, result);
    } catch (error) {
      this.#respondJson(response, 409, {
        error: safePreviewActionError(error),
      });
    }
  }

  async #handlePreviewAction(
    provision: ProvisionRecord,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.#readJsonBody(request, response);
    if (body === null) return;
    const input = parseActionRequest(body);
    if (input === null) {
      this.#respondJson(response, 400, { error: 'invalid-preview-action' });
      return;
    }
    const preview = this.#authorizedPreview(provision, input.previewId, true);
    if (preview === null) {
      this.#auditPreviewAction(provision, input.previewId, input.action.kind, 'denied');
      this.#respondJson(response, 403, { error: 'preview-interaction-denied' });
      return;
    }
    if (this.#previews === null) {
      this.#respondJson(response, 404, { error: 'preview-not-live' });
      return;
    }
    const pendingKey = `${provision.projectId}\u0000${preview.node.id}`;
    if (this.#pendingPreviewActions.has(pendingKey)) {
      this.#respondJson(response, 409, {
        error: 'preview-action-already-pending',
      });
      return;
    }
    this.#pendingPreviewActions.add(pendingKey);
    try {
      const intent = await this.#previews.describeAction(
        provision.projectId,
        preview.node.id,
        input.action,
      );
      const approved = await this.#authorizePreviewAction({
        projectId: provision.projectId,
        agentNodeId: provision.nodeId,
        agentName: this.#callerName(provision),
        previewNodeId: preview.node.id,
        previewName: preview.node.title,
        edgeId: preview.edgeId,
        intent,
      });
      if (!approved) {
        this.#auditPreviewAction(provision, preview.node.id, input.action.kind, 'denied', {
          edgeId: preview.edgeId,
          origin: intent.origin,
          reason: 'user-declined',
        });
        this.#respondJson(response, 403, { error: 'preview-action-declined' });
        return;
      }
      const reauthorized = this.#authorizedPreview(provision, preview.node.id, true);
      if (reauthorized === null || reauthorized.edgeId !== preview.edgeId) {
        this.#auditPreviewAction(provision, preview.node.id, input.action.kind, 'denied', {
          edgeId: preview.edgeId,
          origin: intent.origin,
          reason: 'authorization-changed',
        });
        this.#respondJson(response, 403, {
          error: 'preview-interaction-denied',
        });
        return;
      }
      this.#store.appendAudit('agent-peers', 'browser-action-approved', 'allowed', {
        projectId: provision.projectId,
        nodeId: provision.nodeId,
        previewId: preview.node.id,
        action: input.action.kind,
        edgeId: preview.edgeId,
        origin: intent.origin,
        elementKind: intent.element.kind,
        consequential: intent.consequential,
      });
      const result = await this.#previews.performAction(
        provision.projectId,
        preview.node.id,
        input.action,
        intent.pageVersion,
      );
      this.#auditPreviewAction(provision, preview.node.id, input.action.kind, 'allowed', {
        edgeId: preview.edgeId,
        origin: intent.origin,
        elementKind: intent.element.kind,
        consequential: intent.consequential,
      });
      this.#respondJson(response, 200, result);
    } catch (error) {
      this.#auditPreviewAction(provision, preview.node.id, input.action.kind, 'denied', {
        edgeId: preview.edgeId,
        reason: safePreviewActionError(error),
      });
      this.#respondJson(response, 409, {
        error: safePreviewActionError(error),
      });
    } finally {
      this.#pendingPreviewActions.delete(pendingKey);
    }
  }

  #connectedPreviews(provision: ProvisionRecord): Array<{
    node: Extract<CanvasNode, { type: 'web-preview' | 'mobile-preview' }>;
    edgeId: string;
  }> | null {
    const canvas = this.#store.loadCanvas(provision.projectId);
    if (canvas === null || !canvas.nodes.some((node) => node.id === provision.nodeId)) return null;
    const previews = new Map<
      string,
      Extract<CanvasNode, { type: 'web-preview' | 'mobile-preview' }>
    >();
    for (const node of canvas.nodes) {
      if (node.type === 'web-preview' || node.type === 'mobile-preview')
        previews.set(node.id, node);
    }
    const connected: Array<{
      node: Extract<CanvasNode, { type: 'web-preview' | 'mobile-preview' }>;
      edgeId: string;
    }> = [];
    for (const edge of canvas.edges) {
      if (edge.type !== 'context' || edge.config.muted) continue;
      const otherId =
        edge.sourceNodeId === provision.nodeId
          ? edge.targetNodeId
          : edge.targetNodeId === provision.nodeId
            ? edge.sourceNodeId
            : null;
      if (otherId === null) continue;
      const node = previews.get(otherId);
      if (node !== undefined && !connected.some((entry) => entry.node.id === node.id)) {
        connected.push({ node, edgeId: edge.id });
      }
    }
    return connected;
  }

  #authorizedPreview(
    provision: ProvisionRecord,
    previewId: string,
    interaction = false,
  ): {
    node: Extract<CanvasNode, { type: 'web-preview' | 'mobile-preview' }>;
    edgeId: string;
  } | null {
    if (previewId === '') return null;
    return (
      this.#connectedPreviews(provision)?.find(
        (entry) =>
          entry.node.id === previewId &&
          entry.node.data.agentBrowserAccess &&
          (!interaction || entry.node.data.agentBrowserInteraction),
      ) ?? null
    );
  }

  #callerName(provision: ProvisionRecord): string {
    const canvas = this.#store.loadCanvas(provision.projectId);
    return canvas?.nodes.find((node) => node.id === provision.nodeId)?.title ?? 'Connected agent';
  }

  #auditPreviewAction(
    provision: ProvisionRecord,
    previewId: string,
    action: AgentPreviewAction['kind'],
    outcome: 'allowed' | 'denied',
    extra: Record<string, unknown> = {},
  ): void {
    try {
      this.#store.appendAudit('agent-peers', 'browser-action', outcome, {
        projectId: provision.projectId,
        nodeId: provision.nodeId,
        previewId,
        action,
        ...extra,
      });
    } catch {
      // Audit failure must fail closed at the authorization boundary, not
      // expose action text or break a completed browser operation.
    }
  }

  #auditPreview(
    provision: ProvisionRecord,
    previewId: string,
    outcome: 'allowed' | 'denied',
    action = 'read-preview',
  ): void {
    try {
      this.#store.appendAudit('agent-peers', action, outcome, {
        projectId: provision.projectId,
        nodeId: provision.nodeId,
        previewId,
      });
    } catch {
      // Audit storage failure must not expose more data or crash the request.
    }
  }

  // ---------------------------------------------------------------------------------------
  // Response helper
  // ---------------------------------------------------------------------------------------

  #respondJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(payload);
  }
}

function safePreviewActionError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return SAFE_PREVIEW_ACTION_ERRORS.has(message) ? message : 'preview-action-unavailable';
}

const SAFE_PREVIEW_ACTION_ERRORS = new Set([
  'preview-not-live',
  'preview-interaction-unavailable',
  'preview-origin-changed',
  'preview-page-changed',
  'preview-elements-unavailable',
  'preview-element-handle-invalid',
  'preview-element-changed',
  'preview-element-disabled',
  'preview-action-requires-user',
  'preview-popup-actions-are-user-only',
  'preview-sensitive-entry-blocked',
  'preview-text-length-invalid',
  'preview-element-not-editable',
  'preview-element-not-visible',
  'preview-scroll-delta-required',
]);
