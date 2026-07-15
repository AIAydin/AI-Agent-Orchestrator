import type { Connection, EdgeChange, NodeChange } from '@xyflow/react';

import type { WorkshopNode } from '../CanvasNode.js';
import type { WorkshopEdge } from '../../model/types.js';

export function filterLockedNodeChanges(
  changes: readonly NodeChange<WorkshopNode>[],
  nodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
): NodeChange<WorkshopNode>[] {
  const lockedNodeIds = new Set(nodes.filter((node) => node.data.locked).map((node) => node.id));
  const removalProtectedNodeIds = new Set(lockedNodeIds);
  for (const edge of edges) {
    if (lockedNodeIds.has(edge.source) || lockedNodeIds.has(edge.target)) {
      removalProtectedNodeIds.add(edge.source);
      removalProtectedNodeIds.add(edge.target);
    }
  }
  return changes.filter((change) => {
    if (!('id' in change)) return true;
    if (change.type === 'remove' && removalProtectedNodeIds.has(change.id)) return false;
    if (!lockedNodeIds.has(change.id)) return true;
    switch (change.type) {
      case 'select':
        return true;
      case 'dimensions':
        return change.resizing !== true;
      case 'position':
      case 'remove':
      case 'replace':
        return false;
    }
  });
}

export function canConnectUnlocked(
  connection: Connection,
  nodes: readonly WorkshopNode[],
): boolean {
  return endpointsAreUnlocked(connection.source, connection.target, nodes);
}

export function canEditEdge(
  edge: Pick<WorkshopEdge, 'source' | 'target'>,
  nodes: readonly WorkshopNode[],
): boolean {
  return endpointsAreUnlocked(edge.source, edge.target, nodes);
}

export function filterLockedEdgeChanges(
  changes: readonly EdgeChange<WorkshopEdge>[],
  edges: readonly WorkshopEdge[],
  nodes: readonly WorkshopNode[],
): EdgeChange<WorkshopEdge>[] {
  const lockedNodeIds = new Set(nodes.filter((node) => node.data.locked).map((node) => node.id));
  const edgesById = new Map(edges.map((edge) => [edge.id, edge] as const));
  const touchesLockedNode = (edge: WorkshopEdge | undefined) =>
    edge !== undefined && (lockedNodeIds.has(edge.source) || lockedNodeIds.has(edge.target));

  return changes.filter((change) => {
    if (change.type !== 'remove' && change.type !== 'replace') return true;
    if (touchesLockedNode(edgesById.get(change.id))) return false;
    return change.type !== 'replace' || !touchesLockedNode(change.item);
  });
}

function endpointsAreUnlocked(
  sourceId: string | null,
  targetId: string | null,
  nodes: readonly WorkshopNode[],
): boolean {
  if (sourceId === null || targetId === null) return false;
  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  return source !== undefined && target !== undefined && !source.data.locked && !target.data.locked;
}
