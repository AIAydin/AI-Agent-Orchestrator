import { useCallback, useEffect, useRef, useState } from 'react';

import type { RunEventEnvelope } from '../../../../../../shared/application/contracts.js';
import type { RunHistorySummary } from '../../../../../../shared/runs/contracts.js';
import { unwrap } from '../../../../lib/ipc.js';

const AGENT_ATTEMPT_HISTORY_LIMIT = 50;
const TERMINAL_EVENT_REFRESH_DELAY_MS = 75;

interface AgentAttemptHistoryState {
  readonly attempts: readonly RunHistorySummary[];
  readonly loading: boolean;
  readonly error: string | null;
}

export interface AgentAttemptHistory extends AgentAttemptHistoryState {
  readonly refresh: () => void;
}

interface LegacyCompatibleRunEventsApi {
  readonly onEvent?: (listener: (event: RunEventEnvelope) => void) => () => void;
}

export function useAgentAttemptHistory(
  projectId: string,
  nodeId: string,
  refreshKey: string,
): AgentAttemptHistory {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<AgentAttemptHistoryState>({
    attempts: [],
    loading: true,
    error: null,
  });
  const requestRef = useRef(0);

  useEffect(() => {
    let timer: number | null = null;
    const runs: LegacyCompatibleRunEventsApi = window.forgeboard.runs;
    if (!runs.onEvent) return;

    const unsubscribe = runs.onEvent((event) => {
      if (event.nodeId !== nodeId || (event.kind !== 'run-summary' && event.kind !== 'run-error')) {
        return;
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        setRevision((current) => current + 1);
      }, TERMINAL_EVENT_REFRESH_DELAY_MS);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [nodeId]);

  useEffect(() => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    let active = true;
    setState((current) => ({ ...current, loading: true, error: null }));

    void window.forgeboard.runs
      .list({ projectId, nodeId, limit: AGENT_ATTEMPT_HISTORY_LIMIT })
      .then(unwrap)
      .then((attempts) => {
        if (!active || requestRef.current !== request) return;
        setState({ attempts, loading: false, error: null });
      })
      .catch((cause: unknown) => {
        if (!active || requestRef.current !== request) return;
        setState({
          attempts: [],
          loading: false,
          error: cause instanceof Error ? cause.message : 'Could not load Agent attempt history.',
        });
      });

    return () => {
      active = false;
    };
  }, [nodeId, projectId, refreshKey, revision]);

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  return { ...state, refresh };
}
