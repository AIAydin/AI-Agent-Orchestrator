import { useCallback, useState } from 'react';

import type { Snapshot, WorkshopEdge } from '../../model/types.js';
import type { WorkshopNode } from '../CanvasNode.js';

interface DurableCanvasHistoryController {
  readonly past: Snapshot[];
  readonly future: Snapshot[];
  readonly recordSnapshot: (nodes: WorkshopNode[], edges: WorkshopEdge[]) => void;
  readonly replaceHistory: (past: Snapshot[], future: Snapshot[]) => void;
  readonly clearHistory: () => void;
  readonly undoSnapshot: (current: Snapshot) => Snapshot | null;
  readonly redoSnapshot: (current: Snapshot) => Snapshot | null;
}

export function useDurableCanvasHistory(): DurableCanvasHistoryController {
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);

  const recordSnapshot = useCallback((nodes: WorkshopNode[], edges: WorkshopEdge[]) => {
    setPast((items) => [...items.slice(-49), { nodes, edges }]);
    setFuture([]);
  }, []);
  const replaceHistory = useCallback((nextPast: Snapshot[], nextFuture: Snapshot[]) => {
    setPast(nextPast.slice(-50));
    setFuture(nextFuture.slice(0, 50));
  }, []);
  const clearHistory = useCallback(() => replaceHistory([], []), [replaceHistory]);
  const undoSnapshot = useCallback(
    (current: Snapshot): Snapshot | null => {
      const snapshot = past.at(-1);
      if (!snapshot) return null;
      setFuture((items) => [current, ...items].slice(0, 50));
      setPast((items) => items.slice(0, -1));
      return snapshot;
    },
    [past],
  );
  const redoSnapshot = useCallback(
    (current: Snapshot): Snapshot | null => {
      const snapshot = future[0];
      if (!snapshot) return null;
      setPast((items) => [...items, current].slice(-50));
      setFuture((items) => items.slice(1));
      return snapshot;
    },
    [future],
  );
  return {
    past,
    future,
    recordSnapshot,
    replaceHistory,
    clearHistory,
    undoSnapshot,
    redoSnapshot,
  };
}
