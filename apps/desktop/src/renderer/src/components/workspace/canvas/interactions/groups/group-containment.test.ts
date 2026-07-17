import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../../CanvasNode.js';
import {
  DEFAULT_CANVAS_NODE_HEIGHT,
  DEFAULT_CANVAS_NODE_WIDTH,
  arrangeGroupMembers,
  assignDraggedNodeToContainingFrame,
  canvasNodeBounds,
  fitGroupFrameToMembers,
  moveGroupFrameWithMembers,
  reconcileGroupMembership,
  validateGroupMembership,
} from './group-containment.js';

describe('group containment', () => {
  it('resolves explicit, measured, and default bounds while enforcing rendered minimums', () => {
    expect(canvasNodeBounds(node('explicit', 'task', 4, 8, { width: 220, height: 100 }))).toEqual({
      x: 4,
      y: 8,
      width: 220,
      height: 100,
    });
    expect(
      canvasNodeBounds(
        node('measured', 'task', 12, 16, {
          measured: { width: 245, height: 155 },
        }),
      ),
    ).toEqual({ x: 12, y: 16, width: 245, height: 155 });
    expect(canvasNodeBounds(node('undersized', 'task', 1, 2, { width: 20, height: 30 }))).toEqual({
      x: 1,
      y: 2,
      width: 210,
      height: 92,
    });
    expect(canvasNodeBounds(node('fallback', 'task', -5, -9))).toEqual({
      x: -5,
      y: -9,
      width: DEFAULT_CANVAS_NODE_WIDTH,
      height: DEFAULT_CANVAS_NODE_HEIGHT,
    });
    expect(canvasNodeBounds(frame('legacy-frame', 2, 3, 100, 80, []))).toEqual({
      x: 2,
      y: 3,
      width: 360,
      height: 240,
    });
  });

  it('validates and deterministically reconciles stale, duplicate, nested, and competing claims', () => {
    const child = node('child', 'task', 50, 50, { width: 20, height: 20 });
    const large = frame('large', 0, 0, 400, 300, ['child', 'child', 'missing', 'nested']);
    const small = frame('small', 40, 40, 100, 100, ['child']);
    const nested = frame('nested', 10, 10, 50, 50, []);
    const nodes = [large, child, nested, small];

    const validation = validateGroupMembership(nodes);
    expect(validation.valid).toBe(false);
    expect(validation.memberships).toEqual([{ childId: 'child', frameId: 'small' }]);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        { code: 'duplicate-child-id', childId: 'child', frameIds: ['large'] },
        {
          code: 'multiple-frame-membership',
          childId: 'child',
          frameIds: ['large', 'small'],
        },
        { code: 'stale-child-id', childId: 'missing', frameIds: ['large'] },
        { code: 'nested-group-frame', childId: 'nested', frameIds: ['large'] },
      ]),
    );

    const result = reconcileGroupMembership(nodes);
    expect(result.changedFrameIds).toEqual(['large']);
    expect(result.changedNodeIds).toEqual(['large']);
    expect(group(result.nodes, 'large').data.childNodeIds).toEqual([]);
    expect(group(result.nodes, 'small').data.childNodeIds).toEqual(['child']);
    expect(result.nodes.map((item) => item.id)).toEqual(nodes.map((item) => item.id));
    expect(result.membershipChanges).toEqual(
      expect.arrayContaining([
        {
          childId: 'child',
          fromFrameIds: ['large', 'small'],
          toFrameId: 'small',
        },
        { childId: 'missing', fromFrameIds: ['large'], toFrameId: null },
        { childId: 'nested', fromFrameIds: ['large'], toFrameId: null },
      ]),
    );
    expect(validateGroupMembership(result.nodes).valid).toBe(true);
  });

  it('prefers a containing existing owner before a smaller non-containing legacy claimant', () => {
    const child = node('child', 'task', 300, 300, { width: 20, height: 20 });
    const containing = frame('containing', 250, 250, 200, 200, ['child']);
    const smallerElsewhere = frame('smaller', 0, 0, 40, 40, ['child']);

    expect(reconcileGroupMembership([smallerElsewhere, child, containing]).memberships).toEqual([
      { childId: 'child', frameId: 'containing' },
    ]);
  });

  it('moves a frame and only its unlocked resolved members in flat coordinates', () => {
    const movable = node('movable', 'task', 30, 40, { width: 20, height: 20 });
    const locked = node('locked', 'task', 70, 80, {
      width: 20,
      height: 20,
      locked: true,
    });
    const groupNode = frame('group', 10, 20, 200, 180, ['locked', 'movable']);

    const moved = moveGroupFrameWithMembers([movable, groupNode, locked], 'group', {
      x: 110,
      y: 70,
    });
    expect(moved.disposition).toBe('moved');
    expect(moved.delta).toEqual({ x: 100, y: 50 });
    expect(moved.memberIds).toEqual(['locked', 'movable']);
    expect(moved.movedMemberIds).toEqual(['movable']);
    expect(moved.preservedLockedMemberIds).toEqual(['locked']);
    expect(moved.changedNodeIds).toEqual(['group', 'movable']);
    expect(at(moved.nodes, 'group').position).toEqual({ x: 110, y: 70 });
    expect(at(moved.nodes, 'movable').position).toEqual({ x: 130, y: 90 });
    expect(at(moved.nodes, 'locked')).toBe(locked);

    const lockedFrame = {
      ...groupNode,
      data: { ...groupNode.data, locked: true },
    };
    const rejected = moveGroupFrameWithMembers([lockedFrame, movable], 'group', { x: 0, y: 0 });
    expect(rejected).toMatchObject({
      disposition: 'rejected',
      reason: 'group-frame-locked',
      changedNodeIds: [],
    });
    expect(rejected.nodes[0]).toBe(lockedFrame);
  });

  it('assigns overlap to the smallest unlocked containing frame and unassigns outside all frames', () => {
    const dragged = node('dragged', 'task', 90, 90, { width: 20, height: 20 });
    const large = frame('large', 0, 0, 300, 300, ['dragged']);
    const medium = frame('medium', 50, 50, 120, 120, []);
    const smallestLocked = frame('small-locked', 80, 80, 50, 50, [], true);

    const assigned = assignDraggedNodeToContainingFrame(
      [large, smallestLocked, dragged, medium],
      'dragged',
    );
    expect(assigned).toMatchObject({
      disposition: 'reassigned',
      previousFrameIds: ['large'],
      candidateFrameIds: ['medium', 'large'],
      assignedFrameId: 'medium',
      changedFrameIds: ['large', 'medium'],
    });
    expect(group(assigned.nodes, 'large').data.childNodeIds).toEqual([]);
    expect(group(assigned.nodes, 'medium').data.childNodeIds).toEqual(['dragged']);
    expect(group(assigned.nodes, 'small-locked').data.childNodeIds).toEqual([]);

    const outsideNodes = assigned.nodes.map((item) =>
      item.id === 'dragged' ? { ...item, position: { x: 600, y: 600 } } : item,
    );
    const unassigned = assignDraggedNodeToContainingFrame(outsideNodes, 'dragged');
    expect(unassigned).toMatchObject({
      disposition: 'unassigned',
      assignedFrameId: null,
      candidateFrameIds: [],
      changedFrameIds: ['medium'],
    });
    expect(group(unassigned.nodes, 'medium').data.childNodeIds).toEqual([]);
  });

  it('does not assign a dropped node to an invisible collapsed frame', () => {
    const dragged = node('dragged', 'task', 90, 90, { width: 20, height: 20 });
    const collapsedValue = frame('collapsed', 50, 50, 120, 120, []);
    const collapsed = {
      ...collapsedValue,
      data: { ...collapsedValue.data, collapsed: true },
    };
    const visible = frame('visible', 0, 0, 300, 300, []);

    const assigned = assignDraggedNodeToContainingFrame([collapsed, visible, dragged], 'dragged');

    expect(assigned).toMatchObject({
      disposition: 'assigned',
      candidateFrameIds: ['visible'],
      assignedFrameId: 'visible',
      changedFrameIds: ['visible'],
    });
    expect(group(assigned.nodes, 'collapsed').data.childNodeIds).toEqual([]);
    expect(group(assigned.nodes, 'visible').data.childNodeIds).toEqual(['dragged']);
  });

  it('rejects dragged locked members and nested frame assignment without changing membership', () => {
    const locked = node('locked', 'task', 20, 20, { locked: true });
    const outer = frame('outer', 0, 0, 800, 600, ['locked']);
    const inner = frame('inner', 30, 30, 200, 200, []);

    expect(assignDraggedNodeToContainingFrame([outer, locked], 'locked')).toMatchObject({
      disposition: 'rejected',
      reason: 'dragged-node-locked',
      changedNodeIds: [],
      assignedFrameId: 'outer',
    });
    expect(assignDraggedNodeToContainingFrame([outer, inner], 'inner')).toMatchObject({
      disposition: 'rejected',
      reason: 'nested-group-frames-are-not-supported',
      changedNodeIds: [],
    });
  });

  it('fits an unlocked frame to explicit and measured member bounds while retaining locked members', () => {
    const first = node('first', 'task', 100, 120, { width: 50, height: 40 });
    const second = node('second', 'task', 200, 180, {
      measured: { width: 30, height: 20 },
      locked: true,
    });
    const groupNode = frame('group', 0, 0, 20, 20, ['first', 'second']);

    const fitted = fitGroupFrameToMembers([groupNode, first, second], 'group', {
      padding: 10,
    });
    expect(fitted).toMatchObject({
      disposition: 'fitted',
      memberIds: ['first', 'second'],
      fittedBounds: { x: 75, y: 76, width: 360, height: 240 },
      changedNodeIds: ['group'],
    });
    expect(canvasNodeBounds(group(fitted.nodes, 'group'))).toEqual({
      x: 75,
      y: 76,
      width: 360,
      height: 240,
    });
    expect(at(fitted.nodes, 'second')).toBe(second);
  });

  it('preserves a padded member union when it is larger than the group minimum', () => {
    const member = node('member', 'task', 100, 100, { width: 400, height: 300 });
    const groupNode = frame('group', 0, 0, 20, 20, ['member']);

    const fitted = fitGroupFrameToMembers([groupNode, member], 'group', { padding: 10 });

    expect(fitted.fittedBounds).toEqual({ x: 90, y: 90, width: 420, height: 320 });
    expect(canvasNodeBounds(group(fitted.nodes, 'group'))).toEqual({
      x: 90,
      y: 90,
      width: 420,
      height: 320,
    });
  });

  it('returns explicit no-op results when fitting or arranging a frame without members', () => {
    const empty = frame('empty', 10, 10, 100, 100, ['stale']);
    expect(fitGroupFrameToMembers([empty], 'empty')).toMatchObject({
      disposition: 'unchanged',
      reason: 'group-frame-has-no-members',
      memberIds: [],
      changedNodeIds: [],
    });
    expect(arrangeGroupMembers([empty], 'empty', 'grid')).toMatchObject({
      disposition: 'unchanged',
      reason: 'group-frame-has-no-members',
      memberIds: [],
      changedNodeIds: [],
    });
  });

  it('arranges horizontal and vertical members deterministically while preserving locked slots', () => {
    const a = node('a', 'task', 300, 300, { width: 20, height: 10 });
    const b = node('b', 'task', 400, 400, {
      width: 30,
      height: 20,
      locked: true,
    });
    const c = node('c', 'task', 500, 500, { width: 10, height: 30 });
    const groupNode = frame('group', 10, 20, 400, 300, ['c', 'b', 'a']);

    const horizontal = arrangeGroupMembers([c, groupNode, b, a], 'group', 'horizontal', {
      padding: 10,
      gap: 5,
    });
    expect(horizontal.memberIds).toEqual(['a', 'b', 'c']);
    expect(horizontal.movedMemberIds).toEqual(['a', 'c']);
    expect(horizontal.preservedLockedMemberIds).toEqual(['b']);
    expect(at(horizontal.nodes, 'a').position).toEqual({ x: 20, y: 30 });
    expect(at(horizontal.nodes, 'b')).toBe(b);
    expect(at(horizontal.nodes, 'c').position).toEqual({ x: 450, y: 30 });
    expect(horizontal.placements.find((placement) => placement.nodeId === 'b')).toMatchObject({
      target: { x: 235, y: 30 },
      applied: false,
      locked: true,
    });

    const vertical = arrangeGroupMembers([groupNode, a, b, c], 'group', 'vertical', {
      padding: 10,
      gap: 5,
    });
    expect(at(vertical.nodes, 'a').position).toEqual({ x: 20, y: 30 });
    expect(at(vertical.nodes, 'b')).toBe(b);
    expect(at(vertical.nodes, 'c').position).toEqual({ x: 20, y: 224 });
  });

  it('arranges a stable grid and keeps freeform coordinates untouched', () => {
    const a = node('a', 'task', 300, 300, { width: 20, height: 10 });
    const b = node('b', 'task', 400, 400, { width: 30, height: 20 });
    const c = node('c', 'task', 500, 500, { width: 10, height: 30 });
    const groupNode = frame('group', 10, 20, 400, 300, ['c', 'a', 'b']);

    const grid = arrangeGroupMembers([groupNode, c, b, a], 'group', 'grid', {
      padding: 10,
      gap: 5,
      gridColumns: 2,
    });
    expect(grid.disposition).toBe('arranged');
    expect(at(grid.nodes, 'a').position).toEqual({ x: 20, y: 30 });
    expect(at(grid.nodes, 'b').position).toEqual({ x: 235, y: 30 });
    expect(at(grid.nodes, 'c').position).toEqual({ x: 20, y: 127 });

    const freeform = arrangeGroupMembers(grid.nodes, 'group', 'freeform');
    expect(freeform).toMatchObject({
      disposition: 'unchanged',
      reason: 'freeform-layout-preserved',
      changedNodeIds: [],
    });
    expect(freeform.nodes.map((item) => item.position)).toEqual(
      grid.nodes.map((item) => item.position),
    );
  });
});

interface NodeOptions {
  readonly width?: number;
  readonly height?: number;
  readonly measured?: { readonly width?: number; readonly height?: number };
  readonly locked?: boolean;
}

function node(
  id: string,
  kind: WorkshopNode['data']['kind'],
  x: number,
  y: number,
  options: NodeOptions = {},
): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x, y },
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.measured === undefined ? {} : { measured: options.measured }),
    data: {
      kind,
      title: id,
      description: '',
      status: 'idle',
      locked: options.locked ?? false,
      collapsed: false,
      color: '#445566',
    },
  };
}

function frame(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  childNodeIds: string[],
  locked = false,
): WorkshopNode {
  const value = node(id, 'group-frame', x, y, { width, height, locked });
  return { ...value, data: { ...value.data, childNodeIds } };
}

function at(nodes: readonly WorkshopNode[], id: string): WorkshopNode {
  const value = nodes.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error(`Missing node ${id}`);
  return value;
}

function group(nodes: readonly WorkshopNode[], id: string): WorkshopNode {
  const value = at(nodes, id);
  if (value.data.kind !== 'group-frame') throw new Error(`${id} is not a group frame`);
  return value;
}
