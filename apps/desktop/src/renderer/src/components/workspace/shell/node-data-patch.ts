import type { WorkshopNode } from '../canvas/CanvasNode.js';

type NodeData = WorkshopNode['data'];

export function applyNodeDataPatch(current: NodeData, patch: Partial<NodeData>): NodeData {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as NodeData;
}
