import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../CanvasNode.js';
import { canvasPlacementObstacles, freeCanvasPosition } from './auto-placement.js';

const SIZE = { width: 320, height: 180 };

function rect(x: number, y: number, width = SIZE.width, height = SIZE.height) {
  return { x, y, width, height };
}

function overlaps(
  position: { x: number; y: number },
  obstacle: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    position.x < obstacle.x + obstacle.width &&
    obstacle.x < position.x + SIZE.width &&
    position.y < obstacle.y + obstacle.height &&
    obstacle.y < position.y + SIZE.height
  );
}

describe('freeCanvasPosition', () => {
  it('keeps the desired position when the canvas is empty', () => {
    expect(freeCanvasPosition({ x: 220, y: 150 }, SIZE, [])).toEqual({ x: 220, y: 150 });
  });

  it('keeps the desired position when nothing sits there', () => {
    const obstacles = [rect(1_000, 1_000)];
    expect(freeCanvasPosition({ x: 220, y: 150 }, SIZE, obstacles)).toEqual({ x: 220, y: 150 });
  });

  it('steps aside instead of overlapping an occupying node', () => {
    const obstacles = [rect(220, 150)];
    const position = freeCanvasPosition({ x: 220, y: 150 }, SIZE, obstacles);
    expect(position).not.toEqual({ x: 220, y: 150 });
    expect(obstacles.some((obstacle) => overlaps(position, obstacle))).toBe(false);
  });

  it('never overlaps any node in a crowded cluster and stays nearby', () => {
    const obstacles: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        obstacles.push(rect(220 + column * 200, 150 + row * 120));
      }
    }
    const position = freeCanvasPosition({ x: 220, y: 150 }, SIZE, obstacles);
    expect(obstacles.some((obstacle) => overlaps(position, obstacle))).toBe(false);
    expect(Math.abs(position.x - 220)).toBeLessThanOrEqual(2_400);
    expect(Math.abs(position.y - 150)).toBeLessThanOrEqual(2_400);
  });

  it('is deterministic for the same canvas', () => {
    const obstacles = [rect(220, 150), rect(560, 150), rect(220, 400)];
    const first = freeCanvasPosition({ x: 220, y: 150 }, SIZE, obstacles);
    const second = freeCanvasPosition({ x: 220, y: 150 }, SIZE, obstacles);
    expect(first).toEqual(second);
  });

  it('respects the breathing gap around neighbors', () => {
    const obstacles = [rect(220, 150, 100, 100)];
    const position = freeCanvasPosition({ x: 220, y: 150 }, SIZE, obstacles);
    const gapX =
      position.x >= 220
        ? position.x - (220 + 100)
        : 220 - (position.x + SIZE.width);
    const gapY =
      position.y >= 150
        ? position.y - (150 + 100)
        : 150 - (position.y + SIZE.height);
    expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(24);
  });
});

describe('canvasPlacementObstacles', () => {
  it('reads live measured dimensions and skips hidden nodes', () => {
    const nodes = [
      workshopNode('measured', { x: 10, y: 20 }, { measured: { width: 400, height: 300 } }),
      workshopNode('hidden', { x: 900, y: 900 }, { hidden: true }),
    ];
    const obstacles = canvasPlacementObstacles(nodes);
    expect(obstacles).toEqual([{ x: 10, y: 20, width: 400, height: 300 }]);
  });
});

function workshopNode(
  id: string,
  position: { x: number; y: number },
  overrides: Partial<WorkshopNode> = {},
): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position,
    data: {
      kind: 'task',
      title: id,
      description: '',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#58a6a6',
    },
    ...overrides,
  };
}
