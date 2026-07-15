import type { WorkshopNode } from '../CanvasNode.js';

export interface AlignmentGuideLine {
  coordinate: number;
  start: number;
  end: number;
}

export interface CanvasAlignmentGuides {
  vertical?: AlignmentGuideLine;
  horizontal?: AlignmentGuideLine;
}

interface NodeBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

const DEFAULT_NODE_WIDTH = 210;
const DEFAULT_NODE_HEIGHT = 92;

export function alignmentGuidesForDrag(
  draggedNodes: readonly WorkshopNode[],
  allNodes: readonly WorkshopNode[],
  tolerance = 5,
): CanvasAlignmentGuides {
  const draggedBounds = combinedBounds(draggedNodes);
  if (draggedBounds === null) return {};
  const draggedIds = new Set(draggedNodes.map((node) => node.id));
  const targetBounds = allNodes
    .filter((node) => !draggedIds.has(node.id) && node.hidden !== true)
    .map(nodeBounds);
  const guides: CanvasAlignmentGuides = {};

  const vertical = nearestAxisGuide(
    [draggedBounds.left, draggedBounds.centerX, draggedBounds.right],
    targetBounds,
    (bounds) => [bounds.left, bounds.centerX, bounds.right],
    tolerance,
    (target) => ({
      start: Math.min(draggedBounds.top, target.top),
      end: Math.max(draggedBounds.bottom, target.bottom),
    }),
  );
  if (vertical !== null) guides.vertical = vertical;

  const horizontal = nearestAxisGuide(
    [draggedBounds.top, draggedBounds.centerY, draggedBounds.bottom],
    targetBounds,
    (bounds) => [bounds.top, bounds.centerY, bounds.bottom],
    tolerance,
    (target) => ({
      start: Math.min(draggedBounds.left, target.left),
      end: Math.max(draggedBounds.right, target.right),
    }),
  );
  if (horizontal !== null) guides.horizontal = horizontal;
  return guides;
}

function nearestAxisGuide(
  draggedAnchors: readonly [number, number, number],
  targets: readonly NodeBounds[],
  targetAnchors: (bounds: NodeBounds) => readonly [number, number, number],
  tolerance: number,
  range: (bounds: NodeBounds) => Pick<AlignmentGuideLine, 'start' | 'end'>,
): AlignmentGuideLine | null {
  let best: { distance: number; guide: AlignmentGuideLine } | null = null;
  for (const target of targets) {
    const anchors = targetAnchors(target);
    for (let index = 0; index < draggedAnchors.length; index += 1) {
      const coordinate = anchors[index] as number;
      const distance = Math.abs((draggedAnchors[index] as number) - coordinate);
      if (distance > Math.max(0, tolerance) || (best !== null && distance >= best.distance)) {
        continue;
      }
      best = { distance, guide: { coordinate, ...range(target) } };
    }
  }
  return best?.guide ?? null;
}

function combinedBounds(nodes: readonly WorkshopNode[]): NodeBounds | null {
  if (nodes.length === 0) return null;
  const bounds = nodes.map(nodeBounds);
  const left = Math.min(...bounds.map((item) => item.left));
  const top = Math.min(...bounds.map((item) => item.top));
  const right = Math.max(...bounds.map((item) => item.right));
  const bottom = Math.max(...bounds.map((item) => item.bottom));
  return boundsFromEdges(left, top, right, bottom);
}

function nodeBounds(node: WorkshopNode): NodeBounds {
  const width =
    positiveDimension(node.width) ?? positiveDimension(node.measured?.width) ?? DEFAULT_NODE_WIDTH;
  const height =
    positiveDimension(node.height) ??
    positiveDimension(node.measured?.height) ??
    DEFAULT_NODE_HEIGHT;
  return boundsFromEdges(
    node.position.x,
    node.position.y,
    node.position.x + width,
    node.position.y + height,
  );
}

function boundsFromEdges(left: number, top: number, right: number, bottom: number): NodeBounds {
  return {
    left,
    top,
    right,
    bottom,
    centerX: left + (right - left) / 2,
    centerY: top + (bottom - top) / 2,
  };
}

function positiveDimension(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
