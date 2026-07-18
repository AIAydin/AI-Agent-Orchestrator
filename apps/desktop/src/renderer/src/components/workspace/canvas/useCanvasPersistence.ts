import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import {
  fitCanvasHistory,
  type CanvasHistoryState,
} from '../../../../../shared/canvas/history/contracts.js';
import { unwrap } from '../../../lib/ipc.js';

export type CanvasSaveState = 'saved' | 'saving' | 'error';

type PersistCanvas = (
  document: CanvasDocument,
  history: CanvasHistoryState | null,
) => Promise<void>;

interface UseCanvasPersistenceOptions {
  projectId: string;
  document: CanvasDocument | null;
  history?: CanvasHistoryState | null;
  autosaveIntervalMs: number;
  onError: (message: string) => void;
  persistCanvas?: PersistCanvas;
}

interface PendingCanvasRevision {
  projectId: string;
  revision: number;
  document: CanvasDocument | null;
  history: CanvasHistoryState | null;
}

interface CanvasPersistenceController {
  saveState: CanvasSaveState;
  persistedUpdatedAt: string | null;
  flushCanvas: () => Promise<boolean>;
}

async function persistThroughForgeboard(
  document: CanvasDocument,
  history: CanvasHistoryState | null,
): Promise<void> {
  if (history === null) {
    unwrap(await window.forgeboard.canvas.save(document));
    return;
  }
  unwrap(
    await window.forgeboard.canvas.saveWithHistory({
      document,
      history: fitCanvasHistory(history),
    }),
  );
}

export function useCanvasPersistence({
  projectId,
  document,
  history = null,
  autosaveIntervalMs,
  onError,
  persistCanvas = persistThroughForgeboard,
}: UseCanvasPersistenceOptions): CanvasPersistenceController {
  const [saveState, setSaveState] = useState<CanvasSaveState>('saved');
  const [persistedUpdatedAt, setPersistedUpdatedAt] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const timerRef = useRef<number | null>(null);
  const scopeRef = useRef(projectId);
  const observedFingerprintRef = useRef<string | null>(null);
  const initializedScopeRef = useRef(false);
  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const latestRef = useRef<PendingCanvasRevision>({
    projectId,
    revision: 0,
    document: null,
    history: null,
  });
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const onErrorRef = useRef(onError);
  const persistCanvasRef = useRef(persistCanvas);

  onErrorRef.current = onError;
  persistCanvasRef.current = persistCanvas;
  const documentFingerprint = useMemo(
    () => (document === null ? null : JSON.stringify({ document, history })),
    [document, history],
  );

  const clearAutosave = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useLayoutEffect(() => {
    if (scopeRef.current !== projectId) {
      clearAutosave();
      scopeRef.current = projectId;
      observedFingerprintRef.current = null;
      initializedScopeRef.current = false;
      revisionRef.current += 1;
      savedRevisionRef.current = revisionRef.current;
      latestRef.current = {
        projectId,
        revision: revisionRef.current,
        document: null,
        history: null,
      };
      setPersistedUpdatedAt(null);
      setSaveState('saved');
    }

    if (
      document === null ||
      documentFingerprint === null ||
      observedFingerprintRef.current === documentFingerprint
    ) {
      return;
    }

    observedFingerprintRef.current = documentFingerprint;
    revisionRef.current += 1;
    latestRef.current = { projectId, revision: revisionRef.current, document, history };

    if (!initializedScopeRef.current) {
      initializedScopeRef.current = true;
      savedRevisionRef.current = revisionRef.current;
      setPersistedUpdatedAt(document.updatedAt);
      setSaveState('saved');
      return;
    }

    setSaveState('saving');
  }, [clearAutosave, document, documentFingerprint, history, projectId]);

  const drainSaves = useCallback((): Promise<boolean> => {
    if (inFlightRef.current) return inFlightRef.current;

    const task = (async () => {
      while (true) {
        const pending = latestRef.current;
        if (
          pending.document === null ||
          pending.projectId !== scopeRef.current ||
          pending.revision <= savedRevisionRef.current
        ) {
          if (mountedRef.current) setSaveState('saved');
          return true;
        }

        if (mountedRef.current) setSaveState('saving');
        const saving = {
          ...pending,
          document: {
            ...pending.document,
            updatedAt: new Date().toISOString(),
          },
        };

        try {
          await persistCanvasRef.current(saving.document, saving.history);
        } catch (cause) {
          if (saving.projectId !== scopeRef.current) continue;

          if (mountedRef.current) {
            setSaveState('error');
            const detail = cause instanceof Error ? `: ${cause.message.replace(/\.$/u, '')}` : '';
            onErrorRef.current(
              `Could not save the canvas${detail}. Your changes are still here; try saving again.`,
            );
          }
          return false;
        }

        if (saving.projectId !== scopeRef.current) continue;

        savedRevisionRef.current = Math.max(savedRevisionRef.current, saving.revision);
        if (mountedRef.current) setPersistedUpdatedAt(saving.document.updatedAt);
        const current = latestRef.current;
        if (
          mountedRef.current &&
          current.projectId === saving.projectId &&
          current.revision <= savedRevisionRef.current
        ) {
          setSaveState('saved');
        }
      }
    })();

    inFlightRef.current = task;
    void task.finally(() => {
      if (inFlightRef.current === task) inFlightRef.current = null;
    });
    return task;
  }, []);

  const flushCanvas = useCallback((): Promise<boolean> => {
    clearAutosave();
    return drainSaves();
  }, [clearAutosave, drainSaves]);

  useEffect(() => {
    clearAutosave();
    const pending = latestRef.current;
    if (
      pending.document === null ||
      pending.projectId !== projectId ||
      pending.revision <= savedRevisionRef.current
    ) {
      return;
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void drainSaves();
    }, autosaveIntervalMs);

    return clearAutosave;
  }, [autosaveIntervalMs, clearAutosave, document, drainSaves, projectId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearAutosave();
    };
  }, [clearAutosave]);

  return { saveState, persistedUpdatedAt, flushCanvas };
}
