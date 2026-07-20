import {
  CanvasEdgeSchema,
  CanvasNodeSchema,
  type CanvasEdge,
  type CanvasNode,
} from '@forgeboard/core/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentPeersService,
  type AgentPeersStore,
  type AgentPeersTerminalBridge,
} from './service.js';

const NOW = '2026-07-20T12:00:00.000Z';
const PROJECT_ID = 'project-1';

class FakeStore implements AgentPeersStore {
  canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null = null;
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
  let clock: number;
  let service: AgentPeersService;

  beforeEach(() => {
    store = new FakeStore();
    bridge = createFakeBridge();
    clock = 1_700_000_000_000;
    service = new AgentPeersService(store, bridge, () => clock);
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
