import { describe, expect, it } from 'vitest';
import type { NodeChange } from '@xyflow/react';

import type { WorkshopNode } from '../../CanvasNode.js';
import { canvasNodeBounds, validateGroupMembership } from './group-containment.js';
import {
  applyGroupAwareNodeChanges,
  finalizeDraggedGroupMembership,
  fitAutomaticGroupFrames,
  frameIdsClaimingMembers,
  frameIdsWithChangedMembership,
  updateGroupFrameData,
} from './group-workspace-state.js';

describe('applyGroupAwareNodeChanges', () => {
  it('moves resolved unlocked members with a frame while preserving effective locks', () => {
    const free = node('free', 20, 20);
    const locked = node('locked', 80, 20, { locked: true });
    const protectedMember = node('protected', 140, 20);
    const movingFrame = frame('moving', 0, 0, 300, 220, ['free', 'locked', 'protected']);
    const nonContainingLockedFrame = frame('locked-owner', 500, 500, 100, 100, ['protected'], {
      locked: true,
    });
    const changes: NodeChange<WorkshopNode>[] = [
      {
        type: 'position',
        id: 'moving',
        position: { x: 50, y: 25 },
        dragging: true,
      },
    ];

    const result = applyGroupAwareNodeChanges(
      [movingFrame, free, locked, protectedMember, nonContainingLockedFrame],
      changes,
    );

    expect(at(result, 'moving').position).toEqual({ x: 50, y: 25 });
    expect(at(result, 'free').position).toEqual({ x: 70, y: 45 });
    expect(at(result, 'locked')).toBe(locked);
    expect(at(result, 'protected')).toBe(protectedMember);
    expect(at(result, 'locked-owner')).toBe(nonContainingLockedFrame);
  });

  it('does not double-shift a member with its own explicit position change', () => {
    const member = node('member', 20, 20);
    const group = frame('group', 0, 0, 300, 220, ['member']);
    const changes: NodeChange<WorkshopNode>[] = [
      { type: 'position', id: 'group', position: { x: 50, y: 25 }, dragging: true },
      { type: 'position', id: 'member', position: { x: 70, y: 45 }, dragging: true },
    ];

    const result = applyGroupAwareNodeChanges([group, member], changes);

    expect(at(result, 'group').position).toEqual({ x: 50, y: 25 });
    expect(at(result, 'member').position).toEqual({ x: 70, y: 45 });
  });

  it('auto-fits an affected frame after a member dimension change', () => {
    const first = node('first', 100, 100, { width: 50, height: 40 });
    const second = node('second', 200, 180, { width: 30, height: 20 });
    const group = frame('group', 0, 0, 400, 300, ['first', 'second'], { autoFit: true });
    const changes: NodeChange<WorkshopNode>[] = [
      {
        type: 'dimensions',
        id: 'first',
        dimensions: { width: 100, height: 60 },
        setAttributes: true,
        resizing: true,
      },
    ];

    const result = applyGroupAwareNodeChanges([group, first, second], changes);

    expect(canvasNodeBounds(at(result, 'first'))).toEqual({
      x: 100,
      y: 100,
      width: 210,
      height: 92,
    });
    expect(canvasNodeBounds(at(result, 'group'))).toEqual({
      x: 75,
      y: 66,
      width: 360,
      height: 240,
    });
  });

  it('rejects manual dimensions on an automatic frame by immediately restoring fitted bounds', () => {
    const member = node('member', 130, 80, { width: 100, height: 80 });
    const group = frame('group', 55, 6, 360, 240, ['member'], { autoFit: true });
    const changes: NodeChange<WorkshopNode>[] = [
      {
        type: 'dimensions',
        id: 'group',
        dimensions: { width: 700, height: 500 },
        setAttributes: true,
        resizing: true,
      },
    ];

    const result = applyGroupAwareNodeChanges([group, member], changes);

    expect(canvasNodeBounds(at(result, 'group'))).toEqual({
      x: 55,
      y: 6,
      width: 360,
      height: 240,
    });
  });

  it('reconciles removal and replacement, then fits a remaining automatic group', () => {
    const first = node('first', 100, 100, { width: 50, height: 40 });
    const removed = node('removed', 200, 180, { width: 30, height: 20 });
    const replaced = node('replaced', 250, 180, { width: 30, height: 20 });
    const group = frame('group', 0, 0, 500, 400, ['first', 'removed', 'replaced'], {
      autoFit: true,
    });
    const replacement = frame('replaced', 20, 20, 100, 100, []);
    const changes: NodeChange<WorkshopNode>[] = [
      { type: 'remove', id: 'removed' },
      { type: 'replace', id: 'replaced', item: replacement },
    ];

    const result = applyGroupAwareNodeChanges([group, first, removed, replaced], changes);

    expect(result.some(({ id }) => id === 'removed')).toBe(false);
    expect(children(result, 'group')).toEqual(['first']);
    expect(canvasNodeBounds(at(result, 'group'))).toEqual({
      x: 25,
      y: 26,
      width: 360,
      height: 240,
    });
    expect(validateGroupMembership(result).valid).toBe(true);
  });

  it('re-fits a moved automatic frame around members that locks leave behind', () => {
    const movable = node('movable', 100, 100);
    const locked = node('locked', 300, 100, { locked: true });
    const group = frame('group', 0, 0, 400, 300, ['movable', 'locked'], {
      autoFit: true,
    });
    const changes: NodeChange<WorkshopNode>[] = [
      {
        type: 'position',
        id: 'group',
        position: { x: 100, y: 0 },
        dragging: true,
      },
    ];

    const result = applyGroupAwareNodeChanges([group, movable, locked], changes);

    expect(at(result, 'movable').position).toEqual({ x: 200, y: 100 });
    expect(at(result, 'locked')).toBe(locked);
    expect(canvasNodeBounds(at(result, 'group'))).toEqual({
      x: 175,
      y: 26,
      width: 360,
      height: 240,
    });
    expect(at(result, 'group').data.autoFit).toBe(true);
  });
});

describe('finalizeDraggedGroupMembership', () => {
  it('overlays final positions, reassigns by full containment, and fits old/new automatic frames', () => {
    const member = node('member', 50, 50, { width: 40, height: 40 });
    const oldFrame = frame('old', 0, 0, 220, 220, ['member'], { autoFit: true });
    const newFrame = frame('new', 300, 0, 300, 260, [], { autoFit: true });
    const dragged = { ...member, position: { x: 350, y: 50 } };

    const result = finalizeDraggedGroupMembership([oldFrame, member, newFrame], [dragged]);

    expect(at(result.nodes, 'member').position).toEqual({ x: 350, y: 50 });
    expect(children(result.nodes, 'old')).toEqual([]);
    expect(children(result.nodes, 'new')).toEqual(['member']);
    expect(canvasNodeBounds(at(result.nodes, 'new'))).toEqual({
      x: 275,
      y: -24,
      width: 360,
      height: 240,
    });
    expect(result.changedFrameIds).toEqual(['new', 'old']);
  });

  it('uses the smallest fully containing unlocked frame', () => {
    const member = node('member', 500, 500, { width: 30, height: 30 });
    const large = frame('large', 0, 0, 400, 400, []);
    const small = frame('small', 80, 80, 100, 100, []);
    const dragged = { ...member, position: { x: 100, y: 100 } };

    const result = finalizeDraggedGroupMembership([large, small, member], [dragged]);

    expect(children(result.nodes, 'large')).toEqual([]);
    expect(children(result.nodes, 'small')).toEqual(['member']);
    expect(result.changedFrameIds).toEqual(['small']);
  });

  it('does not overlay or reassign effectively locked members and ignores frames as members', () => {
    const protectedMember = node('protected', 30, 30);
    const lockedOwner = frame('locked-owner', 0, 0, 200, 200, ['protected'], {
      locked: true,
    });
    const target = frame('target', 300, 0, 300, 240, []);
    const movableFrame = frame('movable-frame', 600, 0, 200, 200, []);

    const result = finalizeDraggedGroupMembership(
      [lockedOwner, protectedMember, target, movableFrame],
      [
        { ...protectedMember, position: { x: 350, y: 50 } },
        { ...movableFrame, position: { x: 700, y: 100 } },
      ],
    );

    expect(at(result.nodes, 'protected')).toBe(protectedMember);
    expect(children(result.nodes, 'locked-owner')).toEqual(['protected']);
    expect(children(result.nodes, 'target')).toEqual([]);
    expect(at(result.nodes, 'movable-frame').position).toEqual({ x: 700, y: 100 });
    expect(result.changedFrameIds).toEqual([]);
  });

  it('re-fits a dragged automatic frame even when the final frame position is already applied', () => {
    const locked = node('locked', 100, 100, { locked: true });
    const movedFrame = frame('group', 200, 0, 400, 300, ['locked'], { autoFit: true });

    const result = finalizeDraggedGroupMembership([movedFrame, locked], [movedFrame]);

    expect(at(result.nodes, 'locked')).toBe(locked);
    expect(canvasNodeBounds(at(result.nodes, 'group'))).toEqual({
      x: 25,
      y: 26,
      width: 360,
      height: 240,
    });
    expect(at(result.nodes, 'group').data.autoFit).toBe(true);
    expect(result.changedFrameIds).toEqual(['group']);
  });
});

describe('updateGroupFrameData', () => {
  it('normalizes explicit members, removes unlocked claims, and reports every locked child', () => {
    const movable = node('movable', 40, 40);
    const protectedMember = node('protected', 80, 40);
    const ownLocked = node('own-locked', 120, 40, { locked: true });
    const target = frame('target', 0, 0, 300, 220, ['old']);
    const other = frame('other', 0, 0, 400, 260, ['movable', 'protected']);
    const lockedOwner = frame('locked-owner', 0, 0, 400, 260, ['protected'], {
      locked: true,
    });
    const nested = frame('nested', 500, 500, 100, 100, []);

    const result = updateGroupFrameData(
      [target, other, lockedOwner, movable, protectedMember, ownLocked, nested],
      'target',
      {
        childNodeIds: ['movable', 'protected', 'own-locked', 'nested', 'missing', 'movable'],
        purpose: 'feature-area',
        layout: 'grid',
        autoFit: true,
      },
    );

    expect(result.blockedChildIds).toEqual(['own-locked', 'protected']);
    expect(children(result.nodes, 'target')).toEqual(['movable']);
    expect(children(result.nodes, 'other')).toEqual([]);
    expect(children(result.nodes, 'locked-owner')).toEqual(['protected']);
    expect(at(result.nodes, 'target').data).toMatchObject({
      purpose: 'feature-area',
      layout: 'grid',
      autoFit: true,
    });
    expect(validateGroupMembership(result.nodes).valid).toBe(true);
  });

  it('preserves membership when children are omitted and permits a locked frame to unlock', () => {
    const member = node('member', 40, 40);
    const unlocked = frame('unlocked', 0, 0, 200, 200, ['member']);
    const updated = updateGroupFrameData([unlocked, member], 'unlocked', {
      purpose: 'custom',
    });
    expect(children(updated.nodes, 'unlocked')).toEqual(['member']);
    expect(at(updated.nodes, 'unlocked').data.purpose).toBe('custom');

    const locked = frame('locked', 0, 0, 200, 200, ['member'], { locked: true });
    const rejected = updateGroupFrameData([locked, member], 'locked', { purpose: 'custom' });
    expect(at(rejected.nodes, 'locked')).toBe(locked);
    const unlockedResult = updateGroupFrameData([locked, member], 'locked', { locked: false });
    expect(at(unlockedResult.nodes, 'locked').data.locked).toBe(false);
    expect(children(unlockedResult.nodes, 'locked')).toEqual(['member']);
  });

  it('keeps an owned locked child through other edits and blocks only its requested removal', () => {
    const lockedMember = node('locked-member', 40, 40, { locked: true });
    const oldMember = node('old-member', 80, 40);
    const incoming = node('incoming', 400, 40);
    const target = frame('target', 0, 0, 300, 220, ['locked-member', 'old-member']);
    const other = frame('other', 350, 0, 300, 220, ['incoming']);

    const edited = updateGroupFrameData(
      [target, other, lockedMember, oldMember, incoming],
      'target',
      { childNodeIds: ['locked-member', 'incoming'], purpose: 'feature-area' },
    );

    expect(edited.blockedChildIds).toEqual([]);
    expect(children(edited.nodes, 'target')).toEqual(['incoming', 'locked-member']);
    expect(children(edited.nodes, 'other')).toEqual([]);

    const removal = updateGroupFrameData(edited.nodes, 'target', {
      childNodeIds: ['incoming'],
    });
    expect(removal.blockedChildIds).toEqual(['locked-member']);
    expect(children(removal.nodes, 'target')).toEqual(['incoming', 'locked-member']);
  });

  it('rejects protected additions without removing them from their existing owners', () => {
    const individuallyLocked = node('individually-locked', 400, 40, { locked: true });
    const lockedFrameMember = node('locked-frame-member', 750, 40);
    const movable = node('movable', 40, 40);
    const target = frame('target', 0, 0, 300, 220, []);
    const other = frame('other', 350, 0, 300, 220, ['individually-locked']);
    const lockedOwner = frame('locked-owner', 700, 0, 300, 220, ['locked-frame-member'], {
      locked: true,
    });

    const result = updateGroupFrameData(
      [target, other, lockedOwner, movable, individuallyLocked, lockedFrameMember],
      'target',
      {
        childNodeIds: ['movable', 'individually-locked', 'locked-frame-member'],
      },
    );

    expect(result.blockedChildIds).toEqual(['individually-locked', 'locked-frame-member']);
    expect(children(result.nodes, 'target')).toEqual(['movable']);
    expect(children(result.nodes, 'other')).toEqual(['individually-locked']);
    expect(children(result.nodes, 'locked-owner')).toEqual(['locked-frame-member']);
    expect(validateGroupMembership(result.nodes).valid).toBe(true);
  });
});

describe('group frame state utilities', () => {
  it('reports target and donor frames whose membership changed', () => {
    const member = node('member', 100, 100);
    const retained = node('retained', 400, 100);
    const before = [
      frame('target', 0, 0, 400, 300, []),
      frame('donor', 300, 0, 400, 300, ['member', 'retained']),
      member,
      retained,
    ];
    const after = updateGroupFrameData(before, 'target', { childNodeIds: ['member'] }).nodes;

    expect(frameIdsWithChangedMembership(before, after)).toEqual(['donor', 'target']);
    expect(frameIdsWithChangedMembership(after, after)).toEqual([]);
  });

  it('returns stable raw frame claims for requested members', () => {
    const first = frame('z-frame', 0, 0, 100, 100, ['a', 'a']);
    const second = frame('a-frame', 0, 0, 100, 100, ['b']);
    const unrelated = frame('other', 0, 0, 100, 100, ['c']);

    expect(frameIdsClaimingMembers([first, unrelated, second], ['b', 'a', 'missing'])).toEqual([
      'a-frame',
      'z-frame',
    ]);
    expect(frameIdsClaimingMembers([first], [])).toEqual([]);
  });

  it('fits only requested unlocked frames with auto-fit enabled', () => {
    const a = node('a', 100, 100, { width: 40, height: 20 });
    const b = node('b', 400, 100, { width: 40, height: 20 });
    const c = node('c', 700, 100, { width: 40, height: 20 });
    const automatic = frame('automatic', 0, 0, 300, 200, ['a'], { autoFit: true });
    const manual = frame('manual', 300, 0, 300, 200, ['b']);
    const lockedAutomatic = frame('locked', 600, 0, 300, 200, ['c'], {
      autoFit: true,
      locked: true,
    });

    const result = fitAutomaticGroupFrames(
      [automatic, a, manual, b, lockedAutomatic, c],
      ['locked', 'automatic', 'manual', 'automatic'],
    );

    expect(canvasNodeBounds(at(result, 'automatic'))).toEqual({
      x: 25,
      y: 26,
      width: 360,
      height: 240,
    });
    expect(at(result, 'manual')).toBe(manual);
    expect(at(result, 'locked')).toBe(lockedAutomatic);
  });
});

interface NodeOptions {
  readonly width?: number;
  readonly height?: number;
  readonly locked?: boolean;
}

interface FrameOptions {
  readonly autoFit?: boolean;
  readonly locked?: boolean;
}

function node(id: string, x: number, y: number, options: NodeOptions = {}): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x, y },
    width: options.width ?? 40,
    height: options.height ?? 30,
    data: {
      kind: 'task',
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
  options: FrameOptions = {},
): WorkshopNode {
  const value = node(id, x, y, {
    width,
    height,
    ...(options.locked === undefined ? {} : { locked: options.locked }),
  });
  return {
    ...value,
    data: {
      ...value.data,
      kind: 'group-frame',
      childNodeIds,
      autoFit: options.autoFit ?? false,
    },
  };
}

function at(nodes: readonly WorkshopNode[], id: string): WorkshopNode {
  const value = nodes.find((node) => node.id === id);
  if (value === undefined) throw new Error(`Missing node ${id}`);
  return value;
}

function children(nodes: readonly WorkshopNode[], frameId: string): readonly string[] {
  return at(nodes, frameId).data.childNodeIds ?? [];
}
