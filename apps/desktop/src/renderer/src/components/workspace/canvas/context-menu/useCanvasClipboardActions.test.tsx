// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkshopNode } from '../CanvasNode.js';
import type { WorkshopEdge } from '../../model/types.js';
import { useCanvasClipboardActions } from './useCanvasClipboardActions.js';

afterEach(() => vi.restoreAllMocks());

describe('useCanvasClipboardActions', () => {
  it('duplicates every selected node and their internal edge without an inspector selection', () => {
    const ids = ['first-copy', 'second-copy', 'edge-copy'];
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () => ids.shift()! as ReturnType<Crypto['randomUUID']>,
    );
    const record = vi.fn();
    const sourceNodes = [node('first', true), node('second', true), node('outside', false)];
    const sourceEdges = [
      edge('internal', 'first', 'second'),
      edge('external', 'second', 'outside'),
    ];

    const { result } = renderHook(() => {
      const [nodes, setNodes] = useState(sourceNodes);
      const [edges, setEdges] = useState(sourceEdges);
      const [, setSelectedNodeId] = useState<string | null>(null);
      const [, setSelectedEdgeId] = useState<string | null>(null);
      const [, setEvents] = useState<string[]>([]);
      const pendingNodeSelection = useRef<string | null>(null);
      const actions = useCanvasClipboardActions({
        graphReadOnly: false,
        nodes,
        edges,
        selectedNodeId: null,
        pendingNodeSelection,
        record,
        reportReadOnly: vi.fn(),
        setNodes,
        setEdges,
        setSelectedNodeId,
        setSelectedEdgeId,
        setEvents,
      });
      return { actions, nodes, edges };
    });

    act(() => result.current.actions.duplicateSelected());

    expect(record).toHaveBeenCalledTimes(1);
    expect(result.current.nodes.map(({ id }) => id)).toEqual([
      'first',
      'second',
      'outside',
      'first-copy',
      'second-copy',
    ]);
    expect(result.current.edges.map(({ id, source, target }) => ({ id, source, target }))).toEqual([
      { id: 'internal', source: 'first', target: 'second' },
      { id: 'external', source: 'second', target: 'outside' },
      { id: 'edge-copy', source: 'first-copy', target: 'second-copy' },
    ]);
  });
});

function node(id: string, selected: boolean): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x: 0, y: 0 },
    selected,
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

function edge(id: string, source: string, target: string): WorkshopEdge {
  return { id, source, target, type: 'dependency', selected: true };
}
