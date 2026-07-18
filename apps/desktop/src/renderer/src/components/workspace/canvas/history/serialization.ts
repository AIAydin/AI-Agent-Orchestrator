import { MarkerType } from '@xyflow/react';

import type { ExtensionDiscoveryView } from '../../../../../../shared/application/contracts.js';
import type {
  CanvasHistoryGraph,
  CanvasHistoryState,
} from '../../../../../../shared/canvas/history/contracts.js';
import type { Snapshot } from '../../model/types.js';
import { createEdgeData, edgeDataForPersistence } from '../../model/edge-config.js';
import { hydrateNodeData } from '../../model/helpers.js';
import { workshopNodeForPersistence } from '../../model/node-persistence.js';

export function snapshotForPersistence(snapshot: Snapshot): CanvasHistoryGraph {
  return {
    nodes: snapshot.nodes.map(workshopNodeForPersistence),
    edges: snapshot.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle === undefined || edge.sourceHandle === null
        ? {}
        : { sourceHandle: edge.sourceHandle }),
      ...(edge.targetHandle === undefined || edge.targetHandle === null
        ? {}
        : { targetHandle: edge.targetHandle }),
      type: edge.data?.edgeType ?? 'context',
      data: edgeDataForPersistence(edge.data),
    })),
  };
}

export function hydrateHistorySnapshot(
  graph: CanvasHistoryGraph,
  extensionDiscovery: ExtensionDiscoveryView,
): Snapshot {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: 'workshop' as const,
      position: node.position,
      ...(node.width === undefined ? {} : { width: node.width }),
      ...(node.height === undefined ? {} : { height: node.height }),
      data: hydrateNodeData(node.data, extensionDiscovery),
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
      ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: createEdgeData(edge.type, edge.source, edge.data),
      label: edge.type,
    })),
  };
}

export function durableHistoryState(
  projectId: string,
  canvasId: string,
  past: Snapshot[],
  future: Snapshot[],
): CanvasHistoryState {
  return {
    projectId,
    canvasId,
    past: past.map(snapshotForPersistence),
    future: future.map(snapshotForPersistence),
  };
}
