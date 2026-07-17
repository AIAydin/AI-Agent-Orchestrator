import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../../CanvasNode.js';
import type { WorkshopEdge } from '../../../model/types.js';
import { projectGroupDisplay } from './group-display.js';

describe('group display projections', () => {
  it('layers frames behind ordinary nodes while preserving lower custom layers', () => {
    const lowNode = node('low', 'task', { zIndex: -4 });
    const highNode = node('high', 'task', { zIndex: 12 });
    const defaultFrame = frame('default-frame');
    const lowerFrame = frame('lower-frame', { zIndex: -20 });

    const projection = projectGroupDisplay([highNode, defaultFrame, lowerFrame, lowNode], []);

    expect(projectedNode(projection.nodes, 'default-frame').zIndex).toBe(-5);
    expect(projectedNode(projection.nodes, 'lower-frame').zIndex).toBe(-20);
    expect(projectedNode(projection.nodes, 'low')).toBe(lowNode);
    expect(projectedNode(projection.nodes, 'high')).toBe(highNode);
  });

  it('hides collapsed members and every incident edge without erasing existing display flags', () => {
    const member = node('member', 'task', { hidden: false });
    const visible = node('visible');
    const preHidden = node('pre-hidden', 'task', { hidden: true, zIndex: 9 });
    const group = frame('group', { collapsed: true, childNodeIds: ['member'] });
    const memberEdge = edge('member-edge', 'member', 'visible', { hidden: false, zIndex: 7 });
    const preHiddenEdge = edge('pre-hidden-edge', 'pre-hidden', 'visible');
    const unrelatedEdge = edge('unrelated-edge', 'visible', 'group', {
      hidden: false,
      zIndex: 3,
    });
    const alreadyHiddenEdge = edge('already-hidden-edge', 'visible', 'group', { hidden: true });

    const projection = projectGroupDisplay(
      [member, group, visible, preHidden],
      [memberEdge, preHiddenEdge, unrelatedEdge, alreadyHiddenEdge],
    );

    expect(projectedNode(projection.nodes, 'member')).toMatchObject({ hidden: true });
    expect(projectedNode(projection.nodes, 'pre-hidden')).toBe(preHidden);
    expect(projectedEdge(projection.edges, 'member-edge')).toMatchObject({
      hidden: true,
      zIndex: 7,
    });
    expect(projectedEdge(projection.edges, 'pre-hidden-edge').hidden).toBe(true);
    expect(projectedEdge(projection.edges, 'unrelated-edge')).toBe(unrelatedEdge);
    expect(projectedEdge(projection.edges, 'already-hidden-edge')).toBe(alreadyHiddenEdge);
    expect(member.hidden).toBe(false);
    expect(memberEdge.hidden).toBe(false);
  });

  it('uses reconciled ownership for duplicate, stale, nested, and competing claims', () => {
    const child = node('child', 'task', { x: 50, y: 50, width: 20, height: 20 });
    const nested = frame('nested', { x: 10, y: 10, width: 50, height: 50 });
    const collapsedLarge = frame('large', {
      collapsed: true,
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      childNodeIds: ['child', 'child', 'missing', 'nested'],
    });
    const expandedSmall = frame('small', {
      x: 40,
      y: 40,
      width: 100,
      height: 100,
      childNodeIds: ['child'],
    });
    const connection = edge('connection', 'child', 'outside');
    const outside = node('outside');
    const inputs = [collapsedLarge, child, nested, expandedSmall, outside];

    const expandedWinner = projectGroupDisplay(inputs, [connection]);
    expect(projectedNode(expandedWinner.nodes, 'child').hidden).not.toBe(true);
    expect(projectedEdge(expandedWinner.edges, 'connection')).toBe(connection);

    const collapsedWinner = projectGroupDisplay(
      inputs.map((candidate) =>
        candidate.id === 'small'
          ? { ...candidate, data: { ...candidate.data, collapsed: true } }
          : candidate,
      ),
      [connection],
    );
    expect(projectedNode(collapsedWinner.nodes, 'child').hidden).toBe(true);
    expect(projectedEdge(collapsedWinner.edges, 'connection').hidden).toBe(true);
    expect(projectedNode(collapsedWinner.nodes, 'nested').hidden).not.toBe(true);
  });
});

interface NodeOptions {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly hidden?: boolean;
  readonly zIndex?: number;
  readonly collapsed?: boolean;
  readonly childNodeIds?: string[];
}

function node(id: string, kind: WorkshopNode['data']['kind'] = 'task', options: NodeOptions = {}) {
  return {
    id,
    type: 'workshop',
    position: { x: options.x ?? 500, y: options.y ?? 500 },
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
    ...(options.zIndex === undefined ? {} : { zIndex: options.zIndex }),
    data: {
      kind,
      title: id,
      description: '',
      status: 'idle',
      locked: false,
      collapsed: options.collapsed ?? false,
      color: '#445566',
      ...(options.childNodeIds === undefined ? {} : { childNodeIds: options.childNodeIds }),
    },
  } satisfies WorkshopNode;
}

function frame(id: string, options: NodeOptions = {}): WorkshopNode {
  return node(id, 'group-frame', options);
}

function edge(
  id: string,
  source: string,
  target: string,
  options: Pick<WorkshopEdge, 'hidden' | 'zIndex'> = {},
): WorkshopEdge {
  return { id, source, target, ...options };
}

function projectedNode(nodes: readonly WorkshopNode[], id: string): WorkshopNode {
  const value = nodes.find((node) => node.id === id);
  if (value === undefined) throw new Error(`Missing projected node ${id}`);
  return value;
}

function projectedEdge(edges: readonly WorkshopEdge[], id: string): WorkshopEdge {
  const value = edges.find((edge) => edge.id === id);
  if (value === undefined) throw new Error(`Missing projected edge ${id}`);
  return value;
}
