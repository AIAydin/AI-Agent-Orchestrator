import {
  CanvasEdgeSchema,
  CanvasNodeSchema,
  type CanvasEdge,
  type CanvasNode,
} from '@forgeboard/core/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentPeersService,
  type AgentPeersPreviewBridge,
  type AgentPeersStore,
  type AgentPeersTerminalBridge,
} from './service.js';
import type { PreviewActionAuthorizer } from './preview-control/contracts.js';

const NOW = '2026-07-20T12:00:00.000Z';
const PROJECT_ID = 'project-1';

class FakeStore implements AgentPeersStore {
  canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null = null;
  failBrowserActionApprovalAudit = false;
  readonly auditEvents: {
    category: string;
    action: string;
    outcome: 'allowed' | 'denied' | 'failed';
    metadata: Record<string, unknown>;
  }[] = [];

  loadCanvas(): { nodes: CanvasNode[]; edges: CanvasEdge[] } | null {
    return this.canvas;
  }

  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void {
    if (this.failBrowserActionApprovalAudit && action === 'browser-action-approved') {
      throw new Error('audit unavailable');
    }
    this.auditEvents.push({ category, action, outcome, metadata });
  }
}

function createFakeBridge() {
  return {
    findActiveSessionByNode: vi.fn<AgentPeersTerminalBridge['findActiveSessionByNode']>(() => null),
    deliverPeerInput: vi.fn<AgentPeersTerminalBridge['deliverPeerInput']>(() =>
      Promise.resolve('delivered'),
    ),
    readTranscriptTail: vi.fn<AgentPeersTerminalBridge['readTranscriptTail']>(() =>
      Promise.resolve(null),
    ),
  };
}

function createFakePreviewBridge() {
  return {
    isLive: vi.fn<AgentPeersPreviewBridge['isLive']>(() => true),
    inspect: vi.fn<AgentPeersPreviewBridge['inspect']>(() =>
      Promise.resolve({
        url: 'https://miro.com/app/board',
        title: 'Planning board',
        text: 'Visible board text',
        dom: '<html><body>Visible board text</body></html>',
        console: [],
      }),
    ),
    screenshot: vi.fn<AgentPeersPreviewBridge['screenshot']>(() =>
      Promise.resolve({ mimeType: 'image/png', data: 'cG5n' }),
    ),
    elements: vi.fn<AgentPeersPreviewBridge['elements']>(() =>
      Promise.resolve({
        pageVersion: 'page-version-1',
        url: 'https://miro.com/app/board',
        title: 'Planning board',
        elements: [
          {
            handle: '11111111-1111-4111-8111-111111111111',
            kind: 'button',
            name: 'Add card',
            disabled: false,
            editable: false,
            sensitive: false,
            consequential: false,
            userOnly: false,
            destination: null,
          },
        ],
      }),
    ),
    scroll: vi.fn<AgentPeersPreviewBridge['scroll']>(() =>
      Promise.resolve({
        pageVersion: 'page-version-1',
        url: 'https://miro.com/app/board',
      }),
    ),
    navigate: vi.fn<AgentPeersPreviewBridge['navigate']>(() =>
      Promise.resolve({ url: 'http://localhost:5173/settings' }),
    ),
    describeAction: vi.fn<AgentPeersPreviewBridge['describeAction']>(
      (_projectId, _nodeId, action) =>
        Promise.resolve({
          pageVersion: 'page-version-1',
          url: 'https://miro.com/app/board',
          origin: 'https://miro.com',
          action: action.kind,
          element: {
            handle: action.elementHandle,
            kind: 'button',
            name: 'Add card',
            disabled: false,
            editable: false,
            sensitive: false,
            consequential: false,
            userOnly: false,
            destination: null,
          },
          textPreview: action.kind === 'type' ? action.text : null,
          textLength: action.kind === 'type' ? action.text.length : null,
          consequential: action.kind === 'type',
        }),
    ),
    performAction: vi.fn<AgentPeersPreviewBridge['performAction']>(
      (_projectId, _nodeId, _action, expectedPageVersion) =>
        Promise.resolve({
          performed: true,
          pageVersion: expectedPageVersion,
          url: 'https://miro.com/app/board',
        }),
    ),
  };
}

function nodeBase(id: string, title: string) {
  return {
    id,
    title,
    color: '#445566',
    icon: 'node',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function agentNode(id: string, title: string, adapterId?: string): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase(id, title),
    type: 'agent',
    data: adapterId === undefined ? {} : { adapterId },
  });
}

function previewNode(
  id: string,
  title: string,
  agentBrowserAccess: boolean,
  agentBrowserInteraction = false,
): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase(id, title),
    type: 'web-preview',
    data: {
      url: 'https://miro.com/',
      agentBrowserAccess,
      agentBrowserInteraction,
    },
  });
}

function videoNode(id: string, title: string, relativePath: string, missing = false): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase(id, title),
    type: 'video',
    data: {
      file: { projectId: PROJECT_ID, relativePath, kind: 'file', missing },
    },
  });
}

function contextEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  config: { muted?: boolean } = {},
): CanvasEdge {
  return CanvasEdgeSchema.parse({
    id,
    sourceNodeId,
    targetNodeId,
    type: 'context',
    config,
    createdAt: NOW,
  });
}

async function fetchJson(
  url: string,
  token: string | null,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(url, { ...init, headers });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

describe('AgentPeersService', () => {
  let store: FakeStore;
  let bridge: ReturnType<typeof createFakeBridge>;
  let previewBridge: ReturnType<typeof createFakePreviewBridge>;
  let authorizePreviewAction: ReturnType<typeof vi.fn<PreviewActionAuthorizer>>;
  let clock: number;
  let service: AgentPeersService;

  beforeEach(() => {
    store = new FakeStore();
    bridge = createFakeBridge();
    previewBridge = createFakePreviewBridge();
    authorizePreviewAction = vi.fn<PreviewActionAuthorizer>(() => Promise.resolve(false));
    clock = 1_700_000_000_000;
    service = new AgentPeersService(
      store,
      bridge,
      () => clock,
      previewBridge,
      authorizePreviewAction,
    );
  });

  afterEach(async () => {
    await service.dispose();
  });

  function setCanvas(nodes: CanvasNode[], edges: CanvasEdge[]): void {
    store.canvas = { nodes, edges };
  }

  it('provisions a URL and only answers requests bearing a valid token', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id)]);

    const provision = await service.provision(PROJECT_ID, a.id);
    expect(provision.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const env = service.environmentForProvision(provision.provisionId);
    expect(env).not.toBeNull();
    const token = env?.['FORGEBOARD_PEER_TOKEN'] ?? '';
    expect(env?.['FORGEBOARD_PEER_URL']).toBe(provision.url);

    const missing = await fetchJson(`${provision.url}/v1/peers`, null);
    expect(missing.status).toBe(401);
    expect(missing.body['error']).toBeTypeOf('string');

    const wrong = await fetchJson(`${provision.url}/v1/peers`, 'not-the-token');
    expect(wrong.status).toBe(401);

    const valid = await fetchJson(`${provision.url}/v1/peers`, token);
    expect(valid.status).toBe(200);
  });

  it('binds exact main-created launch arguments to the provision identity', async () => {
    const a = agentNode('agent-a', 'Agent A', 'claude');
    setCanvas([a], []);
    const provision = await service.provision(PROJECT_ID, a.id);
    const arguments_ = ['--mcp-config', '/private/main-owned/mcp.json'];

    service.registerLaunchMaterial(provision.provisionId, 'claude', arguments_);
    arguments_[1] = '/renderer-mutated/mcp.json';

    expect(service.launchMaterialForProvision(provision.provisionId)).toEqual({
      projectId: PROJECT_ID,
      nodeId: a.id,
      adapterId: 'claude',
      arguments: ['--mcp-config', '/private/main-owned/mcp.json'],
    });
    expect(() => service.registerLaunchMaterial(provision.provisionId, 'claude', [])).toThrow(
      /already registered/u,
    );
  });

  it('GET /v1/peers reflects live from findActiveSessionByNode', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B', 'codex');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id)]);
    bridge.findActiveSessionByNode.mockImplementation((_projectId, nodeId) =>
      nodeId === b.id ? { sessionId: 'session-b' } : null,
    );

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const { status, body } = await fetchJson(`${provision.url}/v1/peers`, token);
    expect(status).toBe(200);
    expect(body['agents']).toEqual([
      { name: 'Agent B', provider: 'codex', live: true, muted: false },
    ]);
  });

  it('lists directly connected previews and reads only those explicitly shared with agents', async () => {
    const agent = agentNode('agent-a', 'Agent A');
    const shared = previewNode('preview-shared', 'Shared board', true);
    const privatePreview = previewNode('preview-private', 'Private board', false);
    setCanvas(
      [agent, shared, privatePreview],
      [
        contextEdge('edge-shared', agent.id, shared.id),
        contextEdge('edge-private', agent.id, privatePreview.id),
      ],
    );
    const provision = await service.provision(PROJECT_ID, agent.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const listed = await fetchJson(`${provision.url}/v1/previews`, token);
    expect(listed.status).toBe(200);
    expect(listed.body['previews']).toEqual([
      {
        id: shared.id,
        name: shared.title,
        kind: 'web-preview',
        readable: true,
        interactive: false,
        live: true,
      },
      {
        id: privatePreview.id,
        name: privatePreview.title,
        kind: 'web-preview',
        readable: false,
        interactive: false,
        live: true,
      },
    ]);

    const read = await fetchJson(
      `${provision.url}/v1/preview?previewId=${encodeURIComponent(shared.id)}`,
      token,
    );
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      title: 'Planning board',
      text: 'Visible board text',
    });
    expect(previewBridge.inspect).toHaveBeenCalledWith(PROJECT_ID, shared.id);

    const denied = await fetchJson(
      `${provision.url}/v1/preview?previewId=${encodeURIComponent(privatePreview.id)}`,
      token,
    );
    expect(denied.status).toBe(403);
    expect(previewBridge.inspect).toHaveBeenCalledTimes(1);
  });

  it('requires interaction opt-in and native approval before a browser action', async () => {
    const agent = agentNode('agent-a', 'Agent A');
    const readOnly = previewNode('preview-read-only', 'Read-only board', true);
    const interactive = previewNode('preview-interactive', 'Interactive board', true, true);
    setCanvas(
      [agent, readOnly, interactive],
      [
        contextEdge('edge-read-only', agent.id, readOnly.id),
        contextEdge('edge-interactive', agent.id, interactive.id),
      ],
    );
    authorizePreviewAction.mockResolvedValue(true);
    const provision = await service.provision(PROJECT_ID, agent.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const deniedElements = await fetchJson(
      `${provision.url}/v1/preview/elements?previewId=${encodeURIComponent(readOnly.id)}`,
      token,
    );
    expect(deniedElements.status).toBe(403);
    expect(previewBridge.elements).not.toHaveBeenCalled();

    const elements = await fetchJson(
      `${provision.url}/v1/preview/elements?previewId=${encodeURIComponent(interactive.id)}`,
      token,
    );
    expect(elements.status).toBe(200);
    expect(elements.body['pageVersion']).toBe('page-version-1');

    const action = {
      kind: 'click' as const,
      elementHandle: '11111111-1111-4111-8111-111111111111',
    };
    const performed = await fetchJson(`${provision.url}/v1/preview/action`, token, {
      method: 'POST',
      body: JSON.stringify({ previewId: interactive.id, action }),
    });
    expect(performed.status).toBe(200);
    expect(authorizePreviewAction).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        agentNodeId: agent.id,
        previewNodeId: interactive.id,
        edgeId: 'edge-interactive',
      }),
    );
    expect(previewBridge.performAction).toHaveBeenCalledWith(
      PROJECT_ID,
      interactive.id,
      action,
      'page-version-1',
    );
  });

  it('navigates only interaction-enabled previews and surfaces safe navigation errors', async () => {
    const agent = agentNode('agent-a', 'Agent A');
    const readOnly = previewNode('preview-read-only', 'Read-only board', true);
    const interactive = previewNode('preview-interactive', 'Interactive board', true, true);
    setCanvas(
      [agent, readOnly, interactive],
      [
        contextEdge('edge-read-only', agent.id, readOnly.id),
        contextEdge('edge-interactive', agent.id, interactive.id),
      ],
    );
    const provision = await service.provision(PROJECT_ID, agent.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const denied = await fetchJson(`${provision.url}/v1/preview/navigate`, token, {
      method: 'POST',
      body: JSON.stringify({ previewId: readOnly.id, url: 'http://localhost:5173/settings' }),
    });
    expect(denied.status).toBe(403);
    expect(denied.body['error']).toBe('preview-interaction-denied');
    expect(previewBridge.navigate).not.toHaveBeenCalled();

    const navigated = await fetchJson(`${provision.url}/v1/preview/navigate`, token, {
      method: 'POST',
      body: JSON.stringify({ previewId: interactive.id, url: 'http://localhost:5173/settings' }),
    });
    expect(navigated.status).toBe(200);
    expect(navigated.body).toEqual({ url: 'http://localhost:5173/settings' });
    expect(previewBridge.navigate).toHaveBeenCalledWith(
      PROJECT_ID,
      interactive.id,
      'http://localhost:5173/settings',
    );
    expect(store.auditEvents).toContainEqual(
      expect.objectContaining({ action: 'navigate', outcome: 'allowed' }),
    );

    previewBridge.navigate.mockRejectedValueOnce(new Error('preview-navigation-blocked'));
    const blocked = await fetchJson(`${provision.url}/v1/preview/navigate`, token, {
      method: 'POST',
      body: JSON.stringify({ previewId: interactive.id, url: 'http://localhost:9999/' }),
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body['error']).toBe('preview-navigation-blocked');

    previewBridge.navigate.mockRejectedValueOnce(new Error('ECONNRESET private detail'));
    const masked = await fetchJson(`${provision.url}/v1/preview/navigate`, token, {
      method: 'POST',
      body: JSON.stringify({ previewId: interactive.id, url: 'http://localhost:5173/other' }),
    });
    expect(masked.status).toBe(409);
    expect(masked.body['error']).toBe('preview-action-unavailable');

    const invalid = await fetchJson(`${provision.url}/v1/preview/navigate`, token, {
      method: 'POST',
      body: JSON.stringify({ previewId: interactive.id }),
    });
    expect(invalid.status).toBe(400);
  });

  it('does not execute declined actions or retain typed text in the audit log', async () => {
    const agent = agentNode('agent-a', 'Agent A');
    const interactive = previewNode('preview-interactive', 'Interactive board', true, true);
    setCanvas([agent, interactive], [contextEdge('edge-interactive', agent.id, interactive.id)]);
    authorizePreviewAction.mockResolvedValue(false);
    const provision = await service.provision(PROJECT_ID, agent.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';
    const secretMarker = 'private page text that must not be audited';
    const response = await fetchJson(`${provision.url}/v1/preview/action`, token, {
      method: 'POST',
      body: JSON.stringify({
        previewId: interactive.id,
        action: {
          kind: 'type',
          elementHandle: '11111111-1111-4111-8111-111111111111',
          text: secretMarker,
          replace: true,
        },
      }),
    });

    expect(response).toMatchObject({
      status: 403,
      body: { error: 'preview-action-declined' },
    });
    expect(previewBridge.performAction).not.toHaveBeenCalled();
    expect(JSON.stringify(store.auditEvents)).not.toContain(secretMarker);
  });

  it('rechecks the live edge and interaction permission after approval', async () => {
    const agent = agentNode('agent-a', 'Agent A');
    const interactive = previewNode('preview-interactive', 'Interactive board', true, true);
    const edge = contextEdge('edge-interactive', agent.id, interactive.id);
    setCanvas([agent, interactive], [edge]);
    authorizePreviewAction.mockImplementation(() => {
      setCanvas([agent, previewNode(interactive.id, interactive.title, true, false)], [edge]);
      return Promise.resolve(true);
    });
    const provision = await service.provision(PROJECT_ID, agent.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';
    const response = await fetchJson(`${provision.url}/v1/preview/action`, token, {
      method: 'POST',
      body: JSON.stringify({
        previewId: interactive.id,
        action: {
          kind: 'click',
          elementHandle: '11111111-1111-4111-8111-111111111111',
        },
      }),
    });

    expect(response).toMatchObject({
      status: 403,
      body: { error: 'preview-interaction-denied' },
    });
    expect(previewBridge.performAction).not.toHaveBeenCalled();
  });

  it('fails closed before execution when the required action approval audit cannot be stored', async () => {
    const agent = agentNode('agent-a', 'Agent A');
    const interactive = previewNode('preview-interactive', 'Interactive board', true, true);
    setCanvas([agent, interactive], [contextEdge('edge-interactive', agent.id, interactive.id)]);
    authorizePreviewAction.mockResolvedValue(true);
    store.failBrowserActionApprovalAudit = true;
    const provision = await service.provision(PROJECT_ID, agent.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const response = await fetchJson(`${provision.url}/v1/preview/action`, token, {
      method: 'POST',
      body: JSON.stringify({
        previewId: interactive.id,
        action: {
          kind: 'click',
          elementHandle: '11111111-1111-4111-8111-111111111111',
        },
      }),
    });

    expect(response).toMatchObject({
      status: 409,
      body: { error: 'preview-action-unavailable' },
    });
    expect(previewBridge.performAction).not.toHaveBeenCalled();
  });

  it('exposes only Video nodes explicitly attached or context-connected to the caller', async () => {
    const attached = videoNode('video-attached', 'Demo', 'forgeboard-videos/demo.mp4');
    const connected = videoNode('video-connected', 'Moved clip', 'clips/moved.webm', true);
    const privateVideo = videoNode('video-private', 'Private', 'private.mp4');
    const caller = CanvasNodeSchema.parse({
      ...nodeBase('agent-a', 'Claude'),
      type: 'agent',
      data: { adapterId: 'claude', contextAttachmentIds: [attached.id] },
    });
    setCanvas(
      [caller, attached, connected, privateVideo],
      [contextEdge('edge-video', caller.id, connected.id)],
    );
    const provision = await service.provision(PROJECT_ID, caller.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const listed = await fetchJson(`${provision.url}/v1/videos`, token);
    expect(listed.status).toBe(200);
    expect(listed.body['videos']).toEqual([
      {
        id: attached.id,
        name: attached.title,
        relativePath: 'forgeboard-videos/demo.mp4',
        available: true,
      },
      {
        id: connected.id,
        name: connected.title,
        relativePath: 'clips/moved.webm',
        available: false,
      },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain('private.mp4');
    expect(store.auditEvents).toContainEqual(
      expect.objectContaining({ action: 'list-videos', outcome: 'allowed' }),
    );
  });

  it('does not expose previews through muted or indirect context connections', async () => {
    const caller = agentNode('agent-a', 'Agent A');
    const peer = agentNode('agent-b', 'Agent B');
    const muted = previewNode('preview-muted', 'Muted board', true);
    const indirect = previewNode('preview-indirect', 'Indirect board', true);
    setCanvas(
      [caller, peer, muted, indirect],
      [
        contextEdge('edge-muted', caller.id, muted.id, { muted: true }),
        contextEdge('edge-peer', caller.id, peer.id),
        contextEdge('edge-indirect', peer.id, indirect.id),
      ],
    );
    const provision = await service.provision(PROJECT_ID, caller.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const listed = await fetchJson(`${provision.url}/v1/previews`, token);
    expect(listed.body['previews']).toEqual([]);
    for (const preview of [muted, indirect]) {
      const denied = await fetchJson(
        `${provision.url}/v1/preview?previewId=${encodeURIComponent(preview.id)}`,
        token,
      );
      expect(denied.status).toBe(403);
    }
    expect(previewBridge.inspect).not.toHaveBeenCalled();
  });

  it('POST /v1/message happy path delivers, fires onMessageDelivered, and audits allowed', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    const edge = contextEdge('edge-1', a.id, b.id);
    setCanvas([a, b], [edge]);
    bridge.findActiveSessionByNode.mockImplementation((_projectId, nodeId) =>
      nodeId === b.id ? { sessionId: 'session-b' } : null,
    );
    bridge.deliverPeerInput.mockResolvedValue('delivered');

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';
    const delivered = vi.fn();
    service.onMessageDelivered(delivered);

    const { status, body } = await fetchJson(`${provision.url}/v1/message`, token, {
      method: 'POST',
      body: JSON.stringify({ to: 'Agent B', message: 'hello there' }),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ result: 'delivered' });
    expect(bridge.deliverPeerInput).toHaveBeenCalledWith('session-b', 'Agent A', 'hello there');
    expect(delivered).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      edgeId: edge.id,
    });
    expect(store.auditEvents).toEqual([
      expect.objectContaining({
        category: 'agent-peers',
        action: 'message',
        outcome: 'allowed',
      }),
    ]);
  });

  it('a muted edge blocks delivery without calling the bridge and audits denied', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id, { muted: true })]);

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const { status, body } = await fetchJson(`${provision.url}/v1/message`, token, {
      method: 'POST',
      body: JSON.stringify({ to: 'Agent B', message: 'hello' }),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ result: 'muted' });
    expect(bridge.deliverPeerInput).not.toHaveBeenCalled();
    expect(store.auditEvents).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        metadata: expect.objectContaining({ reason: 'muted' }) as unknown,
      }),
    ]);
  });

  it('rate-limits the 7th message within 60s on the same edge', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id)]);
    bridge.findActiveSessionByNode.mockImplementation((_projectId, nodeId) =>
      nodeId === b.id ? { sessionId: 'session-b' } : null,
    );
    bridge.deliverPeerInput.mockResolvedValue('delivered');

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const send = () =>
      fetchJson(`${provision.url}/v1/message`, token, {
        method: 'POST',
        body: JSON.stringify({ to: 'Agent B', message: 'hi' }),
      });

    for (let i = 0; i < 6; i += 1) {
      const { body } = await send();
      expect(body['result']).toBe('delivered');
    }
    const seventh = await send();
    expect(seventh.body).toEqual({ result: 'rate-limited' });
    expect(bridge.deliverPeerInput).toHaveBeenCalledTimes(6);
  });

  it('the rate-limit window slides: still blocked at 59_999ms, allowed again once past 60_000ms', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id)]);
    bridge.findActiveSessionByNode.mockImplementation((_projectId, nodeId) =>
      nodeId === b.id ? { sessionId: 'session-b' } : null,
    );
    bridge.deliverPeerInput.mockResolvedValue('delivered');

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const send = () =>
      fetchJson(`${provision.url}/v1/message`, token, {
        method: 'POST',
        body: JSON.stringify({ to: 'Agent B', message: 'hi' }),
      });

    const start = clock;
    for (let i = 0; i < 6; i += 1) {
      const { body } = await send();
      expect(body['result']).toBe('delivered');
    }
    const seventh = await send();
    expect(seventh.body).toEqual({ result: 'rate-limited' });

    clock = start + 59_999;
    const stillLimited = await send();
    expect(stillLimited.body).toEqual({ result: 'rate-limited' });

    clock = start + 60_001;
    const slid = await send();
    expect(slid.body).toEqual({ result: 'delivered' });
  });

  it('a peer without a live session returns no-live-session', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id)]);
    bridge.findActiveSessionByNode.mockReturnValue(null);

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const { status, body } = await fetchJson(`${provision.url}/v1/message`, token, {
      method: 'POST',
      body: JSON.stringify({ to: 'Agent B', message: 'hi' }),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ result: 'no-live-session' });
    expect(bridge.deliverPeerInput).not.toHaveBeenCalled();
  });

  it('an unknown peer name returns unknown-peer', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id)]);

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const { status, body } = await fetchJson(`${provision.url}/v1/message`, token, {
      method: 'POST',
      body: JSON.stringify({ to: 'Nobody', message: 'hi' }),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ result: 'unknown-peer' });
  });

  it('GET /v1/screen returns the transcript tail, and 404s for an unknown peer', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id)]);
    bridge.findActiveSessionByNode.mockImplementation((_projectId, nodeId) =>
      nodeId === b.id ? { sessionId: 'session-b' } : null,
    );
    bridge.readTranscriptTail.mockResolvedValue('hello world');

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const found = await fetchJson(
      `${provision.url}/v1/screen?agent=${encodeURIComponent('Agent B')}`,
      token,
    );
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ text: 'hello world' });
    expect(bridge.readTranscriptTail).toHaveBeenCalledWith('session-b', 64 * 1024);

    const notFound = await fetchJson(
      `${provision.url}/v1/screen?agent=${encodeURIComponent('Nobody')}`,
      token,
    );
    expect(notFound.status).toBe(404);
    expect(notFound.body['error']).toBeTypeOf('string');
  });

  it('rejects a message body over the byte cap with 413', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id)]);

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const oversized = JSON.stringify({
      to: 'Agent B',
      message: 'x'.repeat(70_000),
    });
    const { status, body } = await fetchJson(`${provision.url}/v1/message`, token, {
      method: 'POST',
      body: oversized,
    });

    expect(status).toBe(413);
    expect(body['error']).toBeTypeOf('string');
    expect(bridge.deliverPeerInput).not.toHaveBeenCalled();
  });

  it('releaseSession invalidates the token so subsequent calls are 401', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id)]);

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';
    service.bindSession(provision.provisionId, 'session-a');

    const before = await fetchJson(`${provision.url}/v1/peers`, token);
    expect(before.status).toBe(200);

    service.releaseSession('session-a');

    const after = await fetchJson(`${provision.url}/v1/peers`, token);
    expect(after.status).toBe(401);
  });

  it('runs registered cleanup when a session is released', async () => {
    const a = agentNode('agent-a', 'Agent A');
    setCanvas([a], []);
    const provision = await service.provision(PROJECT_ID, a.id);
    service.bindSession(provision.provisionId, 'session-a');
    const cleanup = vi.fn(() => Promise.resolve());
    service.registerCleanup(provision.provisionId, cleanup);

    service.releaseSession('session-a');

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('resetForPrivacy runs registered cleanups before wiping provision state', async () => {
    const a = agentNode('agent-a', 'Agent A');
    setCanvas([a], []);
    const provision = await service.provision(PROJECT_ID, a.id);
    const cleanup = vi.fn(() => Promise.resolve());
    service.registerCleanup(provision.provisionId, cleanup);

    await service.resetForPrivacy();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('dispose runs registered cleanups', async () => {
    const a = agentNode('agent-a', 'Agent A');
    setCanvas([a], []);
    const provision = await service.provision(PROJECT_ID, a.id);
    const cleanup = vi.fn(() => Promise.resolve());
    service.registerCleanup(provision.provisionId, cleanup);

    await service.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('a rejecting cleanup does not throw out of resetForPrivacy', async () => {
    const a = agentNode('agent-a', 'Agent A');
    setCanvas([a], []);
    const provision = await service.provision(PROJECT_ID, a.id);
    service.registerCleanup(provision.provisionId, () => Promise.reject(new Error('boom')));

    await expect(service.resetForPrivacy()).resolves.toBeUndefined();
  });

  it('releaseSession followed by dispose does not double-run that provision cleanup', async () => {
    const a = agentNode('agent-a', 'Agent A');
    setCanvas([a], []);
    const provision = await service.provision(PROJECT_ID, a.id);
    service.bindSession(provision.provisionId, 'session-a');
    const cleanup = vi.fn(() => Promise.resolve());
    service.registerCleanup(provision.provisionId, cleanup);

    service.releaseSession('session-a');
    expect(cleanup).toHaveBeenCalledTimes(1);

    await service.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('malformed JSON bodies return 400 without crashing the hub', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id)]);

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    const { status, body } = await fetchJson(`${provision.url}/v1/message`, token, {
      method: 'POST',
      body: '{not json',
    });

    expect(status).toBe(400);
    expect(body['error']).toBeTypeOf('string');

    const stillWorks = await fetchJson(`${provision.url}/v1/peers`, token);
    expect(stillWorks.status).toBe(200);
  });

  it('handles a caller node removed from the canvas gracefully (404, no crash)', async () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    setCanvas([a, b], [contextEdge('edge-1', a.id, b.id)]);

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    // Simulate the caller's own node having been deleted from the canvas since provisioning.
    setCanvas([b], []);

    const { status, body } = await fetchJson(`${provision.url}/v1/peers`, token);
    expect(status).toBe(404);
    expect(body['error']).toBeTypeOf('string');
  });

  it('expires an unbound provision after 5 minutes', async () => {
    const a = agentNode('agent-a', 'Agent A');
    setCanvas([a], []);

    const provision = await service.provision(PROJECT_ID, a.id);
    const token =
      service.environmentForProvision(provision.provisionId)?.['FORGEBOARD_PEER_TOKEN'] ?? '';

    clock += 5 * 60_000 + 1;

    const { status } = await fetchJson(`${provision.url}/v1/peers`, token);
    expect(status).toBe(401);
  });
});
