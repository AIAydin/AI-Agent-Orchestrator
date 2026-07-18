// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fitCanvasHistory } from '../../../../../../shared/canvas/history/contracts.js';
import type { Snapshot } from '../../model/types.js';
import { durableHistoryState } from '../../canvas/history/serialization.js';
import { useDurableCanvasHistory } from '../../canvas/history/useDurableCanvasHistory.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000091';
const CANVAS_ID = '00000000-0000-4000-8000-000000000092';

describe('durable canvas history controller', () => {
  it('preserves undo and redo order while moving the current graph between lanes', () => {
    const { result } = renderHook(() => useDurableCanvasHistory());

    act(() => {
      result.current.recordSnapshot(snapshot('first').nodes, []);
      result.current.recordSnapshot(snapshot('second').nodes, []);
    });
    expect(titles(result.current.past)).toEqual(['first', 'second']);

    let restored: Snapshot | null = null;
    act(() => {
      restored = result.current.undoSnapshot(snapshot('current'));
    });
    expect(titles(restored === null ? [] : [restored])).toEqual(['second']);
    expect(titles(result.current.past)).toEqual(['first']);
    expect(titles(result.current.future)).toEqual(['current']);

    act(() => {
      restored = result.current.redoSnapshot(snapshot('second'));
    });
    expect(titles(restored === null ? [] : [restored])).toEqual(['current']);
    expect(titles(result.current.past)).toEqual(['first', 'second']);
    expect(result.current.future).toEqual([]);
  });

  it('bounds restored lanes to 50 graphs and clears redo when a new edit is recorded', () => {
    const { result } = renderHook(() => useDurableCanvasHistory());
    const graphs = Array.from({ length: 55 }, (_, index) => snapshot(`graph-${index}`));

    act(() => {
      result.current.replaceHistory(graphs, graphs);
    });
    expect(titles(result.current.past)).toEqual(
      Array.from({ length: 50 }, (_, index) => `graph-${index + 5}`),
    );
    expect(titles(result.current.future)).toEqual(
      Array.from({ length: 50 }, (_, index) => `graph-${index}`),
    );

    act(() => {
      result.current.recordSnapshot(snapshot('new edit').nodes, []);
    });
    expect(result.current.past).toHaveLength(50);
    expect(titles(result.current.past).at(-1)).toBe('new edit');
    expect(result.current.future).toEqual([]);
  });

  it('canonicalizes oversized lanes by dropping the oldest past and farthest future graphs', () => {
    const graphs = Array.from({ length: 55 }, (_, index) => snapshot(`graph-${index}`));

    const fitted = fitCanvasHistory(durableHistoryState(PROJECT_ID, CANVAS_ID, graphs, graphs));

    expect(fitted.past.map((entry) => entry.nodes[0]?.data.title)).toEqual(
      Array.from({ length: 50 }, (_, index) => `graph-${index + 5}`),
    );
    expect(fitted.future.map((entry) => entry.nodes[0]?.data.title)).toEqual(
      Array.from({ length: 50 }, (_, index) => `graph-${index}`),
    );
  });

  it('clears both lanes when a replacement canvas becomes authoritative', () => {
    const { result } = renderHook(() => useDurableCanvasHistory());
    act(() => {
      result.current.replaceHistory([snapshot('past')], [snapshot('future')]);
    });

    act(() => {
      result.current.clearHistory();
    });

    expect(result.current.past).toEqual([]);
    expect(result.current.future).toEqual([]);
    expect(
      durableHistoryState(PROJECT_ID, CANVAS_ID, result.current.past, result.current.future),
    ).toMatchObject({ past: [], future: [] });
  });
});

function snapshot(title: string): Snapshot {
  return {
    nodes: [
      {
        id: `node-${title}`,
        type: 'workshop',
        position: { x: 0, y: 0 },
        data: {
          kind: 'task',
          title,
          description: '',
          status: 'idle',
          locked: false,
          collapsed: false,
          color: '#82909b',
        },
      },
    ],
    edges: [],
  };
}

function titles(snapshots: readonly Snapshot[]): Array<string | undefined> {
  return snapshots.map((entry) => entry.nodes[0]?.data.title);
}
