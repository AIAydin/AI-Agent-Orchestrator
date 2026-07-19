import { useCallback, useEffect, useState } from 'react';

import type {
  PreviewEventEnvelope,
  PreviewSessionSnapshot,
  PreviewStartInput,
} from '../../../../../shared/application/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import type {
  AgentPreviewTarget,
  ComparisonRuntimeState,
  ComparisonSide,
  ComparisonSlot,
} from './types.js';

interface ComparisonSessionsInput {
  projectId: string;
  nodeId: string;
  baseInput: Omit<PreviewStartInput, 'target' | 'slot'>;
  leftTarget?: AgentPreviewTarget | undefined;
  rightTarget?: AgentPreviewTarget | undefined;
  onError: (message: string) => void;
}

export function useComparisonSessions({
  projectId,
  nodeId,
  baseInput,
  leftTarget,
  rightTarget,
  onError,
}: ComparisonSessionsInput) {
  const [sessions, setSessions] = useState<ComparisonRuntimeState>({ left: null, right: null });
  const [busy, setBusy] = useState<ComparisonSide | null>(null);

  const update = useCallback((side: ComparisonSide, session: PreviewSessionSnapshot | null) => {
    setSessions((current) => ({ ...current, [side]: session }));
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all(
      (['left', 'right'] as const).map(async (side) => {
        const value = unwrap(
          await window.forgeboard.previews.get({ projectId, nodeId, slot: slotFor(side) }),
        );
        if (active) update(side, value);
      }),
    ).catch((cause: unknown) => {
      if (active) onError(errorMessage(cause, 'Could not recover comparison previews.'));
    });
    const unsubscribe = window.forgeboard.previews.onEvent((event: PreviewEventEnvelope) => {
      if (
        !active ||
        event.projectId !== projectId ||
        event.nodeId !== nodeId ||
        event.kind !== 'state' ||
        event.slot === undefined
      ) {
        return;
      }
      update(event.slot === 'comparison-left' ? 'left' : 'right', event.session);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [nodeId, onError, projectId, update]);

  useEffect(() => {
    for (const [side, session, selected] of [
      ['left', sessions.left, leftTarget],
      ['right', sessions.right, rightTarget],
    ] as const) {
      if (!session || sameTarget(session.target, selected)) continue;
      update(side, null);
      void window.forgeboard.previews
        .stop({ projectId, nodeId, slot: slotFor(side) })
        .catch((cause: unknown) => {
          onError(errorMessage(cause, `Could not stop the stale ${side} comparison preview.`));
        });
    }
  }, [leftTarget, nodeId, onError, projectId, rightTarget, sessions, update]);

  async function launch(side: ComparisonSide, target: AgentPreviewTarget, restart: boolean) {
    setBusy(side);
    try {
      const input: PreviewStartInput = { ...baseInput, target, slot: slotFor(side) };
      const result = restart
        ? await window.forgeboard.previews.restart(input)
        : await window.forgeboard.previews.start(input);
      const next = unwrap(result);
      if (next) update(side, next);
    } catch (cause) {
      onError(errorMessage(cause, `Could not start the ${side} comparison preview.`));
    } finally {
      setBusy(null);
    }
  }

  async function stop(side: ComparisonSide) {
    setBusy(side);
    try {
      update(
        side,
        unwrap(await window.forgeboard.previews.stop({ projectId, nodeId, slot: slotFor(side) })),
      );
    } catch (cause) {
      onError(errorMessage(cause, `Could not stop the ${side} comparison preview.`));
    } finally {
      setBusy(null);
    }
  }

  return { sessions, busy, launch, stop };
}

export function slotFor(side: ComparisonSide): ComparisonSlot {
  return `comparison-${side}`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function sameTarget(
  actual: PreviewSessionSnapshot['target'],
  expected: AgentPreviewTarget | undefined,
): boolean {
  return actual?.kind === 'agent-run' && expected !== undefined && actual.runId === expected.runId;
}
