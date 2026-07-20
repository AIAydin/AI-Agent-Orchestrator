import {
  CanvasEdgeSchema,
  CanvasNodeSchema,
  type CanvasEdge,
  type CanvasNode,
} from '@forgeboard/core/domain';
import { describe, expect, it } from 'vitest';

import { findPeerByName, resolvePeers, type PeerDescriptor } from './peer-graph.js';

const NOW = '2026-07-20T12:00:00.000Z';

describe('resolvePeers', () => {
  it('resolves an agent-to-agent context edge as a peer when the queried node is the source', () => {
    const a = agentNode('agent-a', 'Agent A', 'claude-code');
    const b = agentNode('agent-b', 'Agent B', 'codex');
    const edge = contextEdge('edge-1', a.id, b.id);

    expect(resolvePeers([a, b], [edge], a.id)).toEqual([
      { nodeId: b.id, name: 'Agent B', provider: 'codex', edgeId: edge.id, muted: false },
    ]);
  });

  it('resolves the same context edge as a peer when the queried node is the target', () => {
    const a = agentNode('agent-a', 'Agent A', 'claude-code');
    const b = agentNode('agent-b', 'Agent B', 'codex');
    const edge = contextEdge('edge-1', a.id, b.id);

    expect(resolvePeers([a, b], [edge], b.id)).toEqual([
      { nodeId: a.id, name: 'Agent A', provider: 'claude-code', edgeId: edge.id, muted: false },
    ]);
  });

  it('does not treat a context edge to a non-agent node as a peer', () => {
    const a = agentNode('agent-a', 'Agent A');
    const task = taskNode('task-x', 'Some task');
    const edge = contextEdge('edge-1', a.id, task.id);

    expect(resolvePeers([a, task], [edge], a.id)).toEqual([]);
  });

  it('does not treat a non-context edge between two agents as a peer', () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    const edge = dependencyEdge('edge-1', a.id, b.id);

    expect(resolvePeers([a, b], [edge], a.id)).toEqual([]);
  });

  it('does not resolve multi-hop peers across an intermediate agent', () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    const c = agentNode('agent-c', 'Agent C');
    const ab = contextEdge('edge-ab', a.id, b.id);
    const bc = contextEdge('edge-bc', b.id, c.id);

    const peers = resolvePeers([a, b, c], [ab, bc], a.id);

    expect(peers.map((peer) => peer.nodeId)).toEqual([b.id]);
  });

  it('dedupes same-titled peers with a numeric suffix in encounter order', () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Claude Code');
    const c = agentNode('agent-c', 'Claude Code');
    const ab = contextEdge('edge-ab', a.id, b.id);
    const ac = contextEdge('edge-ac', a.id, c.id);

    const peers = resolvePeers([a, b, c], [ab, ac], a.id);

    expect(peers.map((peer) => peer.name)).toEqual(['Claude Code', 'Claude Code (2)']);
  });

  it('carries muted through from the edge config', () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    const c = agentNode('agent-c', 'Agent C');
    const muted = contextEdge('edge-ab', a.id, b.id, { muted: true });
    const unmuted = contextEdge('edge-ac', a.id, c.id, { muted: false });

    const peers = resolvePeers([a, b, c], [muted, unmuted], a.id);

    expect(peers).toEqual([
      expect.objectContaining({ nodeId: b.id, muted: true }),
      expect.objectContaining({ nodeId: c.id, muted: false }),
    ]);
  });

  it('excludes self-loop context edges from peer resolution', () => {
    const a = agentNode('agent-a', 'Agent A');
    const selfLoop = contextEdge('edge-self', a.id, a.id);

    expect(resolvePeers([a], [selfLoop], a.id)).toEqual([]);
  });

  it('falls back to "Agent" when title is whitespace-only', () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', ' ');
    const edge = contextEdge('edge-1', a.id, b.id);

    const peers = resolvePeers([a, b], [edge], a.id);

    expect(peers).toEqual([expect.objectContaining({ nodeId: b.id, name: 'Agent' })]);
  });

  it('treats cross-case title collisions as distinct peers', () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Title');
    const c = agentNode('agent-c', 'title');
    const ab = contextEdge('edge-ab', a.id, b.id);
    const ac = contextEdge('edge-ac', a.id, c.id);

    const peers = resolvePeers([a, b, c], [ab, ac], a.id);

    expect(peers.map((peer) => peer.name)).toEqual(['Title', 'title (2)']);
  });

  it('dedupes parallel context edges between the same peer pair', () => {
    const a = agentNode('agent-a', 'Agent A');
    const b = agentNode('agent-b', 'Agent B');
    const edge1 = contextEdge('edge-1', a.id, b.id);
    const edge2 = contextEdge('edge-2', a.id, b.id);

    const peers = resolvePeers([a, b], [edge1, edge2], a.id);

    expect(peers).toEqual([
      { nodeId: b.id, name: 'Agent B', provider: null, edgeId: edge1.id, muted: false },
    ]);
  });
});

describe('findPeerByName', () => {
  it('matches case-insensitively', () => {
    const peers: PeerDescriptor[] = [
      {
        nodeId: 'agent-b',
        name: 'Claude Code',
        provider: 'claude-code',
        edgeId: 'edge-1',
        muted: false,
      },
      {
        nodeId: 'agent-c',
        name: 'Claude Code (2)',
        provider: 'claude-code',
        edgeId: 'edge-2',
        muted: false,
      },
    ];

    expect(findPeerByName(peers, 'claude code')?.nodeId).toBe('agent-b');
    expect(findPeerByName(peers, 'CLAUDE CODE (2)')?.nodeId).toBe('agent-c');
    expect(findPeerByName(peers, 'nonexistent')).toBeUndefined();
  });
});

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

function taskNode(id: string, title: string): CanvasNode {
  return CanvasNodeSchema.parse({
    ...nodeBase(id, title),
    type: 'task',
    data: {},
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

function dependencyEdge(id: string, sourceNodeId: string, targetNodeId: string): CanvasEdge {
  return CanvasEdgeSchema.parse({
    id,
    sourceNodeId,
    targetNodeId,
    type: 'dependency',
    config: {},
    createdAt: NOW,
  });
}
