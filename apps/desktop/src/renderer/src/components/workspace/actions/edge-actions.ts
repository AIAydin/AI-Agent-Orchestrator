import type { WorkshopEdgeData } from '../model/edge-config.js';
import type { WorkshopEdge } from '../model/types.js';

export function updateWorkspaceEdgeData(
  edges: readonly WorkshopEdge[],
  edgeId: string,
  data: WorkshopEdgeData,
): WorkshopEdge[] {
  return edges.map((edge) => (edge.id === edgeId ? { ...edge, label: data.edgeType, data } : edge));
}
