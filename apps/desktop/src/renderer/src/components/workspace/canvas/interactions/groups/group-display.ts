import type { WorkshopNode } from '../../CanvasNode.js';
import type { WorkshopEdge } from '../../../model/types.js';
import { descendantIds, reconcileGroupMembership } from './group-containment.js';

export interface GroupDisplayProjection {
  readonly nodes: WorkshopNode[];
  readonly edges: WorkshopEdge[];
}

/**
 * Derives React Flow display flags without mutating the persisted graph. Resolved group ownership
 * follows the same deterministic rules used by group containment and persistence reconciliation.
 */
export function projectGroupDisplay(
  nodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
): GroupDisplayProjection {
  const reconciled = reconcileGroupMembership(nodes);
  const hiddenMemberIds = new Set(
    reconciled.nodes
      .filter((node) => node.data.kind === 'group-frame' && node.data.collapsed === true)
      .flatMap((frame) => descendantIds(reconciled.nodes, frame.id)),
  );
  const frameLayer = groupFrameLayer(nodes);
  const projectedNodes = nodes.map((node) => projectNode(node, hiddenMemberIds, frameLayer));
  const hiddenNodeIds = new Set(
    projectedNodes.filter((node) => node.hidden === true).map((node) => node.id),
  );
  const projectedEdges = edges.map((edge) =>
    edge.hidden === true || (!hiddenNodeIds.has(edge.source) && !hiddenNodeIds.has(edge.target))
      ? edge
      : { ...edge, hidden: true },
  );
  return { nodes: projectedNodes, edges: projectedEdges };
}

function projectNode(
  node: WorkshopNode,
  hiddenMemberIds: ReadonlySet<string>,
  frameLayer: number,
): WorkshopNode {
  const hideMember = hiddenMemberIds.has(node.id) && node.hidden !== true;
  const lowerFrame =
    node.data.kind === 'group-frame' &&
    (!Number.isFinite(node.zIndex) || (node.zIndex as number) > frameLayer);
  if (!hideMember && !lowerFrame) return node;
  return {
    ...node,
    ...(hideMember ? { hidden: true } : {}),
    ...(lowerFrame ? { zIndex: frameLayer } : {}),
  };
}

function groupFrameLayer(nodes: readonly WorkshopNode[]): number {
  let lowestOrdinaryLayer = 0;
  for (const node of nodes) {
    if (node.data.kind === 'group-frame' || !Number.isFinite(node.zIndex)) continue;
    lowestOrdinaryLayer = Math.min(lowestOrdinaryLayer, node.zIndex as number);
  }
  return lowestOrdinaryLayer - 1;
}
