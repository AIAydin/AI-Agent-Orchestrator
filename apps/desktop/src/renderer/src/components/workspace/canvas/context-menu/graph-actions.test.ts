import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../CanvasNode.js';
import type { WorkshopEdge } from '../../model/types.js';
import {
  contextNodeSelection,
  inheritedContextLockIds,
  removeContextNode,
} from './graph-actions.js';

describe('context-menu graph actions', () => {
  it('captures the exact context group with its member closure and internal edges', () => {
    const nodes = [group('frame', ['member']), task('member', 80, 70), task('outside', 500, 70)];
    const edges = [edge('internal', 'frame', 'member'), edge('external', 'member', 'outside')];

    const selection = contextNodeSelection(nodes, edges, 'frame');

    expect(selection.nodes.map(({ id }) => id)).toEqual(['frame', 'member']);
    expect(selection.edges.map(({ id }) => id)).toEqual(['internal']);
  });

  it('removes incident edges, reconciles stale membership, and refits affected automatic frames', () => {
    const frame = {
      ...group('frame', ['removed', 'kept', 'missing']),
      width: 900,
      height: 700,
      data: {
        ...group('frame', []).data,
        autoFit: true,
        childNodeIds: ['removed', 'kept', 'missing'],
      },
    };
    const nodes = [frame, task('removed', 100, 100), task('kept', 500, 200)];
    const edges = [edge('incident', 'removed', 'kept'), edge('retained', 'frame', 'kept')];

    const result = removeContextNode(nodes, edges, 'removed');

    expect(result.nodes.map(({ id }) => id)).toEqual(['frame', 'kept']);
    expect(result.edges.map(({ id }) => id)).toEqual(['retained']);
    expect(result.nodes[0]).toMatchObject({
      position: { x: 425, y: 126 },
      width: 360,
      height: 240,
      data: { childNodeIds: ['kept'] },
    });
  });

  it('reports only effectively inherited locks for menu presentation', () => {
    const unlocked = task('inherited', 0, 0);
    const directlyLocked = {
      ...task('direct', 0, 0),
      data: { ...task('direct', 0, 0).data, locked: true },
    };

    expect([
      ...inheritedContextLockIds([unlocked, directlyLocked], new Set(['inherited', 'direct'])),
    ]).toEqual(['inherited']);
  });
});

function task(id: string, x: number, y: number): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x, y },
    width: 100,
    height: 50,
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

function group(id: string, childNodeIds: readonly string[]): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x: 0, y: 0 },
    width: 360,
    height: 240,
    data: {
      kind: 'group-frame',
      title: id,
      description: id,
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      purpose: 'custom',
      layout: 'freeform',
      autoFit: false,
      childNodeIds: [...childNodeIds],
    },
  };
}

function edge(id: string, source: string, target: string): WorkshopEdge {
  return { id, source, target };
}
