import type { WorkshopNode } from '../CanvasNode.js';
import type { WorkshopEdge } from '../../model/types.js';
import {
  captureSelectedSubgraph,
  type CanvasClipboardSelection,
} from '../interactions/selection-clipboard.js';
import { removeNodePreservingGroupHierarchy } from '../interactions/groups/group-containment.js';
import {
  fitAutomaticGroupFrames,
  frameIdsClaimingMembers,
} from '../interactions/groups/group-workspace-state.js';

/** Captures exactly the context-clicked node, regardless of the graph's previous selection. */
export function contextNodeSelection(
  nodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
  nodeId: string,
): CanvasClipboardSelection {
  return captureSelectedSubgraph(
    nodes.map((node) => ({ ...node, selected: node.id === nodeId })),
    edges,
    nodeId,
  );
}

/** Applies the same membership reconciliation and automatic frame fit as inspector deletion. */
export function removeContextNode(
  nodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
  nodeId: string,
): { readonly nodes: WorkshopNode[]; readonly edges: WorkshopEdge[] } {
  const affectedFrameIds = frameIdsClaimingMembers(nodes, [nodeId]);
  return {
    nodes: fitAutomaticGroupFrames(
      removeNodePreservingGroupHierarchy(nodes, nodeId),
      affectedFrameIds,
    ),
    edges: edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
  };
}

export function inheritedContextLockIds(
  nodes: readonly WorkshopNode[],
  protectedNodeIds: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    nodes.filter((node) => protectedNodeIds.has(node.id) && !node.data.locked).map(({ id }) => id),
  );
}
