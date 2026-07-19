import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../CanvasNode.js';
import { keyboardMovementForKey, moveSelectedCanvasNodes } from './keyboard-navigation.js';

describe('canvas keyboard navigation', () => {
  it('maps arrows to one-pixel movement and Shift+Arrow to ten pixels', () => {
    expect(keyboardMovementForKey('ArrowUp', false)).toEqual({ x: 0, y: -1 });
    expect(keyboardMovementForKey('ArrowDown', true)).toEqual({ x: 0, y: 10 });
    expect(keyboardMovementForKey('ArrowLeft', true)).toEqual({ x: -10, y: 0 });
    expect(keyboardMovementForKey('ArrowRight', false)).toEqual({ x: 1, y: 0 });
    expect(keyboardMovementForKey('Enter', false)).toBeNull();
  });

  it('moves every selected unlocked node without moving locked or unselected nodes', () => {
    const selected = node('selected', { x: 10, y: 20 }, true, false);
    const locked = node('locked', { x: 30, y: 40 }, true, true);
    const unselected = node('unselected', { x: 50, y: 60 }, false, false);

    const result = moveSelectedCanvasNodes([selected, locked, unselected], { x: 10, y: -10 });

    expect(result.selectedNodeIds).toEqual(['selected', 'locked']);
    expect(result.movedNodeIds).toEqual(['selected']);
    expect(result.lockedNodeIds).toEqual(['locked']);
    expect(result.nodes.map((item) => item.position)).toEqual([
      { x: 20, y: 10 },
      { x: 30, y: 40 },
      { x: 50, y: 60 },
    ]);
    expect(result.nodes[1]).toBe(locked);
    expect(result.nodes[2]).toBe(unselected);
  });

  it('keeps a selected member in place when its containing frame is locked', () => {
    const member = node('member', { x: 20, y: 30 }, true, false);
    const frame: WorkshopNode = {
      ...node('frame', { x: 0, y: 0 }, false, true),
      data: {
        ...node('frame', { x: 0, y: 0 }, false, true).data,
        kind: 'group-frame',
        childNodeIds: ['member'],
      },
    };

    const result = moveSelectedCanvasNodes([frame, member], { x: 10, y: 0 });

    expect(result.movedNodeIds).toEqual([]);
    expect(result.lockedNodeIds).toEqual(['member']);
    expect(result.nodes[1]?.position).toEqual({ x: 20, y: 30 });
  });

  it('moves an unlocked frame and each unlocked resolved member exactly once', () => {
    const frame: WorkshopNode = {
      ...node('frame', { x: 0, y: 0 }, true, false),
      data: {
        ...node('frame', { x: 0, y: 0 }, true, false).data,
        kind: 'group-frame',
        childNodeIds: ['member', 'selected-member', 'locked-member'],
      },
    };
    const member = node('member', { x: 20, y: 30 }, false, false);
    const selectedMember = node('selected-member', { x: 40, y: 50 }, true, false);
    const lockedMember = node('locked-member', { x: 60, y: 70 }, false, true);

    const result = moveSelectedCanvasNodes([frame, member, selectedMember, lockedMember], {
      x: 10,
      y: -5,
    });

    expect(result.selectedNodeIds).toEqual(['frame', 'selected-member']);
    expect(result.movedNodeIds).toEqual(['frame', 'member', 'selected-member']);
    expect(result.nodes.map((item) => item.position)).toEqual([
      { x: 10, y: -5 },
      { x: 30, y: 25 },
      { x: 50, y: 45 },
      { x: 60, y: 70 },
    ]);
  });

  it('moves every nested descendant once when ancestor and child frames are selected', () => {
    const outer = groupNode('outer', { x: 0, y: 0 }, true, ['inner']);
    const inner = groupNode('inner', { x: 20, y: 20 }, true, ['leaf']);
    const leaf = node('leaf', { x: 40, y: 40 }, false, false);

    const result = moveSelectedCanvasNodes([outer, inner, leaf], { x: 10, y: 5 });

    expect(result.movedNodeIds).toEqual(['outer', 'inner', 'leaf']);
    expect(result.nodes.map(({ position }) => position)).toEqual([
      { x: 10, y: 5 },
      { x: 30, y: 25 },
      { x: 50, y: 45 },
    ]);
  });
});

function groupNode(
  id: string,
  position: { x: number; y: number },
  selected: boolean,
  childNodeIds: string[],
): WorkshopNode {
  const value = node(id, position, selected, false);
  return { ...value, data: { ...value.data, kind: 'group-frame', childNodeIds } };
}

function node(
  id: string,
  position: { x: number; y: number },
  selected: boolean,
  locked: boolean,
): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position,
    selected,
    data: {
      kind: 'task',
      title: id,
      description: id,
      status: 'idle',
      locked,
      collapsed: false,
      color: '#445566',
    },
  };
}
