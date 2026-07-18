// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import type { SetStateAction } from 'react';
import type { NodeChange } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from '../../CanvasNode.js';
import type { WorkshopEdge } from '../../../model/types.js';
import {
  useCanvasGraphInteractions,
  type UseCanvasGraphInteractionsOptions,
} from './useCanvasGraphInteractions.js';

afterEach(cleanup);

describe('useCanvasGraphInteractions', () => {
  it('honors inherited locks and records collapse and resize exactly once before mutation', () => {
    const member = node('member', { title: 'Grouped task' });
    const lockedFrame = frame('frame', ['member'], { locked: true });
    const harness = setup([lockedFrame, member]);

    act(() => harness.hook.result.current.setNodeCollapsed('member', true));
    act(() => harness.hook.result.current.beginNodeResize('member'));
    expect(harness.recordSnapshot).not.toHaveBeenCalled();
    expect(harness.state.events[0]).toBe('Unlock the node or its group before collapsing it.');

    const unlockedNodes = harness.nodesRef.current.map((candidate) =>
      candidate.id === 'frame'
        ? { ...candidate, data: { ...candidate.data, locked: false } }
        : candidate,
    );
    harness.nodesRef.current = unlockedNodes;
    act(() => harness.hook.result.current.beginNodeResize('member'));
    act(() => harness.hook.result.current.setNodeCollapsed('member', true));
    act(() => harness.hook.result.current.setNodeCollapsed('member', true));

    expect(harness.recordSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.recordSnapshot.mock.calls[0]).toEqual([unlockedNodes, harness.edgesRef.current]);
    expect(harness.recordSnapshot.mock.calls[1]).toEqual([unlockedNodes, harness.edgesRef.current]);
    expect(at(harness.nodesRef.current, 'member').data.collapsed).toBe(true);
    expect(harness.state.nodes).toBe(harness.nodesRef.current);
    expect(harness.state.events[0]).toBe('Collapsed Grouped task.');
  });

  it('allows passive measurement but rejects authoritative dimensions in read-only mode', () => {
    const original = node('task');
    const harness = setup([original]);
    harness.readOnlyRef.current = true;
    const changes: NodeChange<WorkshopNode>[] = [
      { type: 'select', id: 'task', selected: true },
      {
        type: 'dimensions',
        id: 'task',
        dimensions: { width: 180, height: 90 },
      },
      {
        type: 'dimensions',
        id: 'task',
        dimensions: { width: 280, height: 190 },
        resizing: true,
      },
      {
        type: 'dimensions',
        id: 'task',
        dimensions: { width: 380, height: 290 },
        setAttributes: 'width',
      },
      { type: 'position', id: 'task', position: { x: 40, y: 50 }, dragging: true },
      { type: 'remove', id: 'task' },
    ];

    act(() => harness.hook.result.current.changeCanvasNodes(changes));

    expect(at(harness.nodesRef.current, 'task')).toMatchObject({
      selected: true,
      position: original.position,
      measured: { width: 180, height: 90 },
    });
    expect(at(harness.nodesRef.current, 'task').width).toBeUndefined();
    expect(at(harness.nodesRef.current, 'task').height).toBeUndefined();
    expect(harness.reportCollaborationReadOnly).toHaveBeenCalledTimes(1);
    expect(harness.recordSnapshot).not.toHaveBeenCalled();
  });

  it('filters locked mutations and records one snapshot for a multi-remove batch', () => {
    const lockedMember = node('locked-member');
    const group = frame('frame', ['locked-member'], { locked: true });
    const first = node('first');
    const second = node('second');
    const harness = setup([group, lockedMember, first, second]);
    const initialNodes = harness.nodesRef.current;
    const changes: NodeChange<WorkshopNode>[] = [
      {
        type: 'position',
        id: 'locked-member',
        position: { x: 900, y: 900 },
        dragging: true,
      },
      { type: 'remove', id: 'first' },
      { type: 'remove', id: 'second' },
    ];

    act(() => harness.hook.result.current.changeCanvasNodes(changes));

    expect(harness.recordSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.recordSnapshot).toHaveBeenCalledWith(initialNodes, harness.edgesRef.current);
    expect(at(harness.nodesRef.current, 'locked-member').position).toEqual({ x: 0, y: 0 });
    expect(harness.nodesRef.current.some(({ id }) => id === 'first' || id === 'second')).toBe(
      false,
    );
    expect(harness.state.events[0]).toBe('Unlock locked nodes before changing them.');
  });

  it('finalizes drag coordinates and group membership without creating another undo record', () => {
    const group = frame('frame', [], { x: 0, y: 0, width: 300, height: 220 });
    const member = node('member', { x: 500, y: 500, width: 40, height: 40 });
    const harness = setup([group, member]);
    const dragged = { ...member, position: { x: 50, y: 50 } };

    act(() => harness.hook.result.current.finishNodeDrag(dragged, [dragged]));

    expect(at(harness.nodesRef.current, 'member').position).toEqual({ x: 50, y: 50 });
    expect(at(harness.nodesRef.current, 'frame').data.childNodeIds).toEqual(['member']);
    expect(harness.recordSnapshot).not.toHaveBeenCalled();
    expect(harness.state.events[0]).toBe("Updated the group's placement and size.");
  });
});

interface HarnessState {
  nodes: WorkshopNode[];
  events: string[];
}

function setup(nodes: WorkshopNode[], edges: WorkshopEdge[] = []) {
  const state: HarnessState = { nodes, events: [] };
  const nodesRef = { current: nodes };
  const edgesRef = { current: edges };
  const readOnlyRef = { current: false };
  const setNodes = vi.fn<(value: SetStateAction<WorkshopNode[]>) => void>((value) => {
    state.nodes = applyState(value, state.nodes);
  });
  const setEvents = vi.fn<(value: SetStateAction<string[]>) => void>((value) => {
    state.events = applyState(value, state.events);
  });
  const recordSnapshot = vi.fn<(nodes: WorkshopNode[], edges: WorkshopEdge[]) => void>();
  const reportCollaborationReadOnly = vi.fn();
  const options = {
    nodesRef,
    edgesRef,
    readOnlyRef,
    setNodes,
    setEvents,
    recordSnapshot,
    reportCollaborationReadOnly,
  } satisfies UseCanvasGraphInteractionsOptions;
  return {
    state,
    nodesRef,
    edgesRef,
    readOnlyRef,
    recordSnapshot,
    reportCollaborationReadOnly,
    hook: renderHook(() => useCanvasGraphInteractions(options)),
  };
}

function applyState<T>(value: SetStateAction<T>, current: T): T {
  return typeof value === 'function' ? (value as (previous: T) => T)(current) : value;
}

interface NodeOptions {
  readonly title?: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly locked?: boolean;
}

function node(id: string, options: NodeOptions = {}): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x: options.x ?? 0, y: options.y ?? 0 },
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.height === undefined ? {} : { height: options.height }),
    data: {
      kind: 'task',
      title: options.title ?? id,
      description: '',
      status: 'idle',
      locked: options.locked ?? false,
      collapsed: false,
      color: '#445566',
    },
  };
}

function frame(id: string, childNodeIds: string[], options: NodeOptions = {}): WorkshopNode {
  const base = node(id, options);
  return {
    ...base,
    data: { ...base.data, kind: 'group-frame', childNodeIds },
  };
}

function at(nodes: readonly WorkshopNode[], id: string): WorkshopNode {
  const value = nodes.find((node) => node.id === id);
  if (value === undefined) throw new Error(`Missing node ${id}`);
  return value;
}
