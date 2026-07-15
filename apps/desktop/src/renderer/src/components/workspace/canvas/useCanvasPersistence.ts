import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import { unwrap } from '../../../lib/ipc.js';

export type CanvasSaveState = 'saved' | 'saving' | 'error';

type PersistCanvas = (document: CanvasDocument) => Promise<void>;

interface UseCanvasPersistenceOptions {
  projectId: string;
  document: CanvasDocument | null;
  autosaveIntervalMs: number;
  onError: (message: string) => void;
  persistCanvas?: PersistCanvas;
}

interface PendingCanvasRevision {
  projectId: string;
  revision: number;
  document: CanvasDocument | null;
}

interface CanvasPersistenceController {
  saveState: CanvasSaveState;
  flushCanvas: () => Promise<boolean>;
}

async function persistThroughForgeboard(document: CanvasDocument): Promise<void> {
  unwrap(await window.forgeboard.canvas.save(document));
}

export function useCanvasPersistence({
  projectId,
  document,
  autosaveIntervalMs,
  onError,
  persistCanvas = persistThroughForgeboard,
}: UseCanvasPersistenceOptions): CanvasPersistenceController {
  const [saveState, setSaveState] = useState<CanvasSaveState>('saved');
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
  });
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const onErrorRef = useRef(onError);
  const persistCanvasRef = useRef(persistCanvas);

  onErrorRef.current = onError;
  persistCanvasRef.current = persistCanvas;
  const documentFingerprint = useMemo(
    () => (document === null ? null : JSON.stringify(document)),
    [document],
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
      };
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
    latestRef.current = { projectId, revision: revisionRef.current, document };

    if (!initializedScopeRef.current) {
      initializedScopeRef.current = true;
      savedRevisionRef.current = revisionRef.current;
      setSaveState('saved');
      return;
    }

    setSaveState('saving');
  }, [clearAutosave, document, documentFingerprint, projectId]);

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
          await persistCanvasRef.current(saving.document);
        } catch (cause) {
          if (saving.projectId !== scopeRef.current) continue;

          if (mountedRef.current) {
            setSaveState('error');
            const detail = cause instanceof Error ? `: ${cause.message}` : '';
            onErrorRef.current(`Could not save the canvas${detail}`);
          }
          return false;
        }

        if (saving.projectId !== scopeRef.current) continue;

        savedRevisionRef.current = Math.max(savedRevisionRef.current, saving.revision);
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

  return { saveState, flushCanvas };
}
