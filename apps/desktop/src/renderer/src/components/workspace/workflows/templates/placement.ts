import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { initialWorkshopNodeDimensions } from '../../model/node-persistence.js';
import type { WorkflowTemplate } from './catalog.js';

const GRAPH_GAP = 120;

/** Places a complete template to the right of every existing node, so no template box can overlap. */
export function collisionFreeTemplateOrigin(
  template: WorkflowTemplate,
  existingNodes: readonly WorkshopNode[],
  preferred: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  if (existingNodes.length === 0) return preferred;
  const existingRight = Math.max(
    ...existingNodes.map(
      (node) =>
        node.position.x +
        (positiveDimension(node.width) ?? initialWorkshopNodeDimensions(node.data.kind).width),
    ),
  );
  const templateLeft = Math.min(...template.nodes.map((node) => node.x));
  return { x: Math.max(preferred.x, existingRight + GRAPH_GAP - templateLeft), y: preferred.y };
}

function positiveDimension(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
