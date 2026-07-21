import { useEffect, useRef, useState } from 'react';

const DEFAULT_DURATION_MS = 1600;

/**
 * Tracks which canvas edges are currently "pulsing" because an agent-peer message just
 * transited them (Task 11). Subscribes exactly once; a repeat event for an edge already
 * pulsing resets/extends its timer rather than stacking a second removal.
 */
export function usePeerTransitPulse(
  subscribe: (cb: (event: { edgeId: string }) => void) => () => void,
  durationMs = DEFAULT_DURATION_MS,
): ReadonlySet<string> {
  const [pulsingEdges, setPulsingEdges] = useState<ReadonlySet<string>>(() => new Set());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = timersRef.current;
    const unsubscribe = subscribe((event) => {
      const existingTimer = timers.get(event.edgeId);
      if (existingTimer !== undefined) clearTimeout(existingTimer);

      timers.set(
        event.edgeId,
        setTimeout(() => {
          timers.delete(event.edgeId);
          setPulsingEdges((current) => {
            if (!current.has(event.edgeId)) return current;
            const next = new Set(current);
            next.delete(event.edgeId);
            return next;
          });
        }, durationMs),
      );

      setPulsingEdges((current) => {
        if (current.has(event.edgeId)) return current;
        const next = new Set(current);
        next.add(event.edgeId);
        return next;
      });
    });

    return () => {
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
    // Subscribe once: `subscribe` and `durationMs` are expected to be stable across the
    // lifetime of this hook's owner (Workspace subscribes with a fixed callback).
  }, []);

  return pulsingEdges;
}
