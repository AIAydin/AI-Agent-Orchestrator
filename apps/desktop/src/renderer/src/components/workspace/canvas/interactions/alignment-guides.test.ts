import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../CanvasNode.js';
import { alignmentGuidesForDrag } from './alignment-guides.js';

describe('canvas alignment guides', () => {
  it('shows vertical and horizontal guides for matching node edges', () => {
    const dragged = node('dragged', { x: 101, y: 99 }, 100, 50);
    const target = node('target', { x: 100, y: 100 }, 120, 80);

    expect(alignmentGuidesForDrag([dragged], [dragged, target], 2)).toEqual({
      vertical: { coordinate: 100, start: 99, end: 180 },
      horizontal: { coordinate: 100, start: 100, end: 220 },
    });
  });

  it('uses the full dragged selection bounds and ignores hidden alignment targets', () => {
    const first = node('first', { x: 0, y: 10 }, 100, 50);
    const second = node('second', { x: 120, y: 10 }, 100, 50);
    const target = node('target', { x: 1, y: 100 }, 220, 50);
    const hidden = { ...node('hidden', { x: 0, y: 10 }, 220, 50), hidden: true };

    expect(alignmentGuidesForDrag([first, second], [first, second, target, hidden], 2)).toEqual({
      vertical: { coordinate: 1, start: 10, end: 150 },
    });
  });

  it('returns no guides outside the flow-coordinate tolerance', () => {
    const dragged = node('dragged', { x: 0, y: 0 }, 100, 50);
    const target = node('target', { x: 20, y: 20 }, 100, 50);
    expect(alignmentGuidesForDrag([dragged], [dragged, target], 5)).toEqual({});
  });
});

function node(
  id: string,
  position: { x: number; y: number },
  width: number,
  height: number,
): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position,
    width,
    height,
    data: {
      kind: 'task',
      title: id,
      description: id,
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
    },
  };
}
