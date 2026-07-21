import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import {
  DEFAULT_GROUP_FRAME_DIMENSIONS,
  GROUP_FRAME_MINIMUM_DIMENSIONS,
  defaultNodeDimensionsForKind,
  minimumNodeDimensionsForKind,
} from '../../../../../shared/canvas/node-dimensions.js';
import type { NodeKind, WorkshopNode } from '../canvas/CanvasNode.js';

export function initialWorkshopNodeDimensions(kind: NodeKind): {
  readonly width: number;
  readonly height: number;
} {
  if (kind === 'group-frame') return { ...DEFAULT_GROUP_FRAME_DIMENSIONS };
  return { ...defaultNodeDimensionsForKind(kind) };
}

export function persistedWorkshopNodeDimensions(
  node: Pick<WorkshopNode, 'data' | 'height' | 'width'>,
): { readonly width: number; readonly height: number } {
  const fallback = initialWorkshopNodeDimensions(node.data.kind);
  const minimum =
    node.data.kind === 'group-frame'
      ? GROUP_FRAME_MINIMUM_DIMENSIONS
      : minimumNodeDimensionsForKind(node.data.kind);
  return {
    width: Math.max(minimum.width, positiveDimension(node.width) ?? fallback.width),
    height: Math.max(minimum.height, positiveDimension(node.height) ?? fallback.height),
  };
}

export function workshopNodeForPersistence(node: WorkshopNode): CanvasDocument['nodes'][number] {
  return {
    id: node.id,
    type: node.data.kind,
    position: node.position,
    ...persistedWorkshopNodeDimensions(node),
    data: node.data,
  };
}

function positiveDimension(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
