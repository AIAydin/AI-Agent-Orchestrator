import type { CanvasEdge, CanvasNode } from '@forgeboard/core/domain';

type AgentCanvasNode = Extract<CanvasNode, { type: 'agent' }>;

export interface PeerDescriptor {
  readonly nodeId: string;
  readonly name: string;
  readonly provider: string | null;
  readonly edgeId: string;
  readonly muted: boolean;
}

/**
 * Resolves the direct peers of an agent node: agent nodes joined to it by a `context` edge,
 * in either direction. Peers are one hop only — an edge must touch `nodeId` directly, so this
 * never walks transitively through an intermediate agent.
 */
export function resolvePeers(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  nodeId: string,
): PeerDescriptor[] {
  const agents = new Map<string, AgentCanvasNode>();
  for (const node of nodes) {
    if (node.type === 'agent') agents.set(node.id, node);
  }
  if (!agents.has(nodeId)) return [];

  const seen = new Map<string, number>();
  const peers: PeerDescriptor[] = [];
  for (const edge of edges) {
    if (edge.type !== 'context') continue;
    const otherId =
      edge.sourceNodeId === nodeId
        ? edge.targetNodeId
        : edge.targetNodeId === nodeId
          ? edge.sourceNodeId
          : null;
    if (otherId === null || otherId === nodeId) continue;
    const other = agents.get(otherId);
    if (other === undefined || peers.some((peer) => peer.nodeId === otherId)) continue;

    const base = other.title.trim() === '' ? 'Agent' : other.title.trim();
    const key = base.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);

    peers.push({
      nodeId: otherId,
      name: count === 1 ? base : `${base} (${count})`,
      provider: other.data.adapterId ?? null,
      edgeId: edge.id,
      muted: edge.config.muted,
    });
  }
  return peers;
}

export function findPeerByName(
  peers: readonly PeerDescriptor[],
  name: string,
): PeerDescriptor | undefined {
  const wanted = name.trim().toLowerCase();
  return peers.find((peer) => peer.name.toLowerCase() === wanted);
}
