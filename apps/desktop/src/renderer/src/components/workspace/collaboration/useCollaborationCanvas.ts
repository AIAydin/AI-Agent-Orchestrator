import { useEffect, useRef, useState } from 'react';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import { canonicalCanvasFromLegacy } from '../../../../../shared/canvas/adapter.js';
import { collaborationMetadataSnapshotFromCanvas } from '../../../../../shared/collaboration/index.js';

interface UseCollaborationCanvasOptions {
  readonly enabled: boolean;
  readonly document: CanvasDocument | null;
  readonly selectedNodeId: string | null;
  readonly onError: (message: string) => void;
  readonly debounceMs?: number;
}

/** Publishes only the strict privacy projection; legacy node payloads never cross IPC. */
export function useCollaborationCanvas({
  enabled,
  document,
  selectedNodeId,
  onError,
  debounceMs = 200,
}: UseCollaborationCanvasOptions): void {
  const [sessionActive, setSessionActive] = useState(false);
  const lastErrorRef = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const collaboration = window.forgeboard.collaboration;
    if (!enabled || collaboration === undefined) {
      setSessionActive(false);
      return;
    }
    let mounted = true;
    let eventObserved = false;
    void collaboration
      .get()
      .then((result) => {
        if (!mounted || eventObserved) return;
        setSessionActive(result.ok && result.value !== null && result.value.status === 'connected');
      })
      .catch(() => {
        if (mounted && !eventObserved) {
          reportOnce(
            lastErrorRef,
            onErrorRef.current,
            'Forgeboard could not read collaboration status.',
          );
        }
      });
    const unsubscribe = collaboration.onEvent((event) => {
      if (!mounted || event.type !== 'status-changed') return;
      eventObserved = true;
      setSessionActive(event.connection.status === 'connected');
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [enabled]);

  useEffect(() => {
    const collaboration = window.forgeboard.collaboration;
    if (!enabled || !sessionActive || document === null || collaboration === undefined) return;
    const timer = window.setTimeout(() => {
      try {
        const migrated = canonicalCanvasFromLegacy(document);
        if (!migrated.ok) {
          reportOnce(
            lastErrorRef,
            onErrorRef.current,
            'Collaboration paused because this canvas cannot be represented by the safe metadata contract.',
          );
          return;
        }
        const snapshot = collaborationMetadataSnapshotFromCanvas(migrated.canvas);
        void collaboration
          .publish({ snapshot })
          .then((result) => {
            if (result.ok) lastErrorRef.current = null;
            else reportOnce(lastErrorRef, onErrorRef.current, result.error.message);
          })
          .catch(() =>
            reportOnce(
              lastErrorRef,
              onErrorRef.current,
              'Forgeboard could not publish collaboration metadata.',
            ),
          );
      } catch {
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          'Collaboration paused because the canvas metadata failed privacy validation.',
        );
      }
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [debounceMs, document, enabled, sessionActive]);

  useEffect(() => {
    const collaboration = window.forgeboard.collaboration;
    if (!enabled || !sessionActive || collaboration === undefined) return;
    void collaboration
      .updateAwareness({
        awareness: {
          selection: {
            nodeIds: selectedNodeId === null ? [] : [selectedNodeId],
          },
          activity:
            selectedNodeId === null
              ? { status: 'idle' }
              : { nodeId: selectedNodeId, status: 'editing' },
        },
      })
      .then((result) => {
        if (!result.ok) reportOnce(lastErrorRef, onErrorRef.current, result.error.message);
      })
      .catch(() =>
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          'Forgeboard could not update collaboration presence.',
        ),
      );
  }, [enabled, selectedNodeId, sessionActive]);
}

function reportOnce(
  lastError: { current: string | null },
  report: (message: string) => void,
  message: string,
): void {
  if (lastError.current === message) return;
  lastError.current = message;
  report(message);
}
