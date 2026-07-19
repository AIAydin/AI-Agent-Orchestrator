import type { WorkshopNode } from '../CanvasNode.js';
import { descendantIds } from './groups/group-containment.js';
import { lockedCanvasNodeIds } from './lock-protection.js';

export interface CanvasKeyboardMovement {
  x: number;
  y: number;
}

export interface CanvasKeyboardMoveResult {
  nodes: WorkshopNode[];
  selectedNodeIds: string[];
  movedNodeIds: string[];
  lockedNodeIds: string[];
}

export type CanvasKeyboardMoveSummary = Omit<CanvasKeyboardMoveResult, 'nodes'>;

const ARROW_DIRECTIONS: Readonly<Record<string, CanvasKeyboardMovement>> = {
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
};

export function keyboardMovementForKey(
  key: string,
  shiftKey: boolean,
): CanvasKeyboardMovement | null {
  const direction = ARROW_DIRECTIONS[key];
  if (direction === undefined) return null;
  const distance = shiftKey ? 10 : 1;
  return { x: direction.x * distance, y: direction.y * distance };
}

export function moveSelectedCanvasNodes(
  nodes: readonly WorkshopNode[],
  movement: CanvasKeyboardMovement,
): CanvasKeyboardMoveResult {
  const lockedIds = lockedCanvasNodeIds(nodes);
  const selectedNodeIds: string[] = [];
  const lockedNodeIds: string[] = [];
  const movedIds = new Set<string>();
  for (const node of nodes) {
    if (node.selected !== true) continue;
    selectedNodeIds.push(node.id);
    if (lockedIds.has(node.id)) lockedNodeIds.push(node.id);
    else movedIds.add(node.id);
  }
  const selectedMovableFrameIds = new Set(
    nodes
      .filter(
        (node) =>
          node.selected === true && node.data.kind === 'group-frame' && !lockedIds.has(node.id),
      )
      .map((node) => node.id),
  );
  for (const frameId of selectedMovableFrameIds) {
    for (const childId of descendantIds(nodes, frameId)) {
      if (!lockedIds.has(childId)) movedIds.add(childId);
    }
  }
  const movedNodes = nodes.map((node) => {
    if (!movedIds.has(node.id)) return node;
    return {
      ...node,
      position: {
        x: node.position.x + movement.x,
        y: node.position.y + movement.y,
      },
    };
  });

  return {
    nodes: movedNodes,
    selectedNodeIds,
    movedNodeIds: nodes.filter(({ id }) => movedIds.has(id)).map(({ id }) => id),
    lockedNodeIds,
  };
}
