import type { WorkshopNode } from '../CanvasNode.js';

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
  const selectedNodeIds: string[] = [];
  const movedNodeIds: string[] = [];
  const lockedNodeIds: string[] = [];
  const movedNodes = nodes.map((node) => {
    if (node.selected !== true) return node;
    selectedNodeIds.push(node.id);
    if (node.data.locked) {
      lockedNodeIds.push(node.id);
      return node;
    }
    movedNodeIds.push(node.id);
    return {
      ...node,
      position: {
        x: node.position.x + movement.x,
        y: node.position.y + movement.y,
      },
    };
  });

  return { nodes: movedNodes, selectedNodeIds, movedNodeIds, lockedNodeIds };
}
