import type { Connection, EdgeChange, NodeChange } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../CanvasNode.js';
import type { WorkshopEdge } from '../../model/types.js';
import {
  canConnectUnlocked,
  canEditEdge,
  filterLockedEdgeChanges,
  filterLockedNodeChanges,
} from './lock-protection.js';

describe('canvas lock protection', () => {
  const locked = node('locked', true);
  const open = node('open', false);

  it('blocks mutation changes for locked nodes while retaining selection and measurement', () => {
    const changes: NodeChange<WorkshopNode>[] = [
      { type: 'position', id: 'locked', position: { x: 20, y: 20 }, dragging: true },
      { type: 'remove', id: 'locked' },
      { type: 'select', id: 'locked', selected: true },
      { type: 'dimensions', id: 'locked', dimensions: { width: 100, height: 80 } },
      { type: 'dimensions', id: 'locked', dimensions: { width: 120, height: 90 }, resizing: true },
      { type: 'position', id: 'open', position: { x: 30, y: 30 }, dragging: true },
    ];

    expect(filterLockedNodeChanges(changes, [locked, open], [])).toEqual([
      { type: 'select', id: 'locked', selected: true },
      { type: 'dimensions', id: 'locked', dimensions: { width: 100, height: 80 } },
      { type: 'position', id: 'open', position: { x: 30, y: 30 }, dragging: true },
    ]);
  });

  it('rejects connections with either endpoint locked or missing', () => {
    expect(canConnectUnlocked(connection('open', 'locked'), [locked, open])).toBe(false);
    expect(canConnectUnlocked(connection('locked', 'open'), [locked, open])).toBe(false);
    expect(canConnectUnlocked(connection('open', 'open'), [locked, open])).toBe(true);
    expect(canConnectUnlocked(connection('missing', 'open'), [locked, open])).toBe(false);
    expect(canEditEdge(edge('locked-edge', 'locked', 'open'), [locked, open])).toBe(false);
    expect(canEditEdge(edge('open-edge', 'open', 'also-open'), [open])).toBe(false);
    expect(
      canEditEdge(edge('open-edge', 'open', 'also-open'), [open, node('also-open', false)]),
    ).toBe(true);
  });

  it('keeps edge selection but rejects removal when either endpoint is locked', () => {
    const edges = [
      edge('from-locked', 'locked', 'open'),
      edge('to-locked', 'open', 'locked'),
      edge('open-edge', 'open', 'also-open'),
    ];
    const changes: EdgeChange<WorkshopEdge>[] = [
      { type: 'select', id: 'from-locked', selected: true },
      { type: 'select', id: 'to-locked', selected: true },
      { type: 'remove', id: 'from-locked' },
      { type: 'remove', id: 'to-locked' },
      { type: 'remove', id: 'open-edge' },
      { type: 'replace', id: 'open-edge', item: edge('open-edge', 'open', 'locked') },
    ];

    expect(
      filterLockedEdgeChanges(changes, edges, [locked, open, node('also-open', false)]),
    ).toEqual([
      { type: 'select', id: 'from-locked', selected: true },
      { type: 'select', id: 'to-locked', selected: true },
      { type: 'remove', id: 'open-edge' },
    ]);
    expect(
      filterLockedNodeChanges([{ type: 'remove', id: 'open' }], [locked, open], edges),
    ).toEqual([]);
  });
});

function node(id: string, locked: boolean): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x: 0, y: 0 },
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

function connection(source: string, target: string): Connection {
  return { source, target, sourceHandle: null, targetHandle: null };
}

function edge(id: string, source: string, target: string): WorkshopEdge {
  return { id, source, target };
}
