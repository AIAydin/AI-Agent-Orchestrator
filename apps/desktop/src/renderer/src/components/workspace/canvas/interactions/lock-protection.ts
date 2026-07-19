import type { Connection, EdgeChange, NodeChange } from '@xyflow/react';

import type { WorkshopNode } from '../CanvasNode.js';
import type { WorkshopEdge } from '../../model/types.js';
import { descendantIds } from './groups/group-containment.js';

export function filterLockedNodeChanges(
  changes: readonly NodeChange<WorkshopNode>[],
  nodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
): NodeChange<WorkshopNode>[] {
  const lockedNodeIds = lockedCanvasNodeIds(nodes);
  const removalProtectedNodeIds = removalProtectedCanvasNodeIds(nodes, edges);
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
  const lockedNodeIds = lockedCanvasNodeIds(nodes);
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
  const lockedNodeIds = lockedCanvasNodeIds(nodes);
  return (
    source !== undefined &&
    target !== undefined &&
    !lockedNodeIds.has(source.id) &&
    !lockedNodeIds.has(target.id)
  );
}

export function lockedCanvasNodeIds(nodes: readonly WorkshopNode[]): Set<string> {
  const lockedNodeIds = new Set(nodes.filter((node) => node.data.locked).map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const protectRawDescendants = (frameId: string, visited: Set<string>): void => {
    if (visited.has(frameId)) return;
    visited.add(frameId);
    const frame = byId.get(frameId);
    if (frame?.data.kind !== 'group-frame') return;
    for (const childId of frame.data.childNodeIds ?? []) {
      lockedNodeIds.add(childId);
      if (byId.get(childId)?.data.kind === 'group-frame') protectRawDescendants(childId, visited);
    }
  };
  for (const frame of nodes) {
    if (frame.data.kind !== 'group-frame' || !frame.data.locked) continue;
    protectRawDescendants(frame.id, new Set());
  }
  return lockedNodeIds;
}

/**
 * Extends effective locks to deletions that would mutate a protected edge or indirectly ungroup a
 * locked child by removing its otherwise-unlocked frame.
 */
export function removalProtectedCanvasNodeIds(
  nodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
): Set<string> {
  const lockedNodeIds = lockedCanvasNodeIds(nodes);
  const protectedIds = new Set(lockedNodeIds);
  for (const edge of edges) {
    if (lockedNodeIds.has(edge.source) || lockedNodeIds.has(edge.target)) {
      protectedIds.add(edge.source);
      protectedIds.add(edge.target);
    }
  }
  for (const frame of nodes) {
    if (frame.data.kind !== 'group-frame') continue;
    if (descendantIds(nodes, frame.id).some((childId) => lockedNodeIds.has(childId))) {
      protectedIds.add(frame.id);
    }
  }
  return protectedIds;
}
