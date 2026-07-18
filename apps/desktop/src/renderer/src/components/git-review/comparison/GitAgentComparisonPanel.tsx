import { GitCompareArrows, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { unwrap } from '../../../lib/ipc.js';
import type {
  GitAgentComparisonTarget,
  GitAgentComparisonView,
} from '../../../../../shared/git/comparison/contracts.js';
import type { RunHistorySummary } from '../../../../../shared/runs/contracts.js';
import { GitComparisonPanel } from '../GitBaseComparisonPanel.js';
import {
  GIT_AGENT_COMPARISON_PANEL_ID,
  GIT_AGENT_COMPARISON_TAB_ID,
} from '../GitReviewModeTabs.js';
import type { GitDiffDisplayPreferences } from '../diff/GitDiffViewer.js';
import './git-agent-comparison.css';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'interrupted', 'terminated', 'lost']);

export function GitAgentComparisonPanel({
  target,
  displayPreferences,
  onDisplayPreferencesChange,
  onError,
}: {
  target: GitAgentComparisonTarget;
  displayPreferences?: GitDiffDisplayPreferences;
  onDisplayPreferencesChange?: (preferences: GitDiffDisplayPreferences) => void;
  onError?: (message: string) => void;
}) {
  const [runs, setRuns] = useState<RunHistorySummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [comparison, setComparison] = useState<GitAgentComparisonView | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const candidates = useMemo(
    () =>
      runs.filter(
        (run) =>
          run.id !== target.runId &&
          run.projectId === target.projectId &&
          run.worktreeAvailable &&
          TERMINAL_STATUSES.has(run.status),
      ),
    [runs, target.projectId, target.runId],
  );

  const loadRuns = useCallback(() => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoadingRuns(true);
    setError(null);
    void window.forgeboard.runs
      .list({ projectId: target.projectId, limit: 200 })
      .then((result) => {
        if (requestRef.current !== request) return;
        setRuns(unwrap(result));
      })
      .catch((cause: unknown) => {
        if (requestRef.current !== request) return;
        const message = errorMessage(cause, 'Could not load the available agent runs.');
        setError(message);
        onError?.(message);
      })
      .finally(() => {
        if (requestRef.current === request) setLoadingRuns(false);
      });
  }, [onError, target.projectId]);

  useEffect(() => {
    setRuns([]);
    setSelectedRunId('');
    setComparison(null);
    loadRuns();
    return () => {
      requestRef.current += 1;
    };
  }, [loadRuns, target.projectId, target.runId]);

  const compare = async () => {
    if (selectedRunId === '') return;
    setComparing(true);
    setComparison(null);
    setError(null);
    try {
      const value = unwrap(
        await window.forgeboard.git.comparison.compareAgents({
          left: target,
          right: {
            kind: 'agent-worktree',
            projectId: target.projectId,
            runId: selectedRunId,
          },
        }),
      );
      setComparison(value);
    } catch (cause) {
      const message = errorMessage(
        cause,
        'Could not compare these agent worktrees. Refresh the run list and try again.',
      );
      setError(message);
      onError?.(message);
    } finally {
      setComparing(false);
    }
  };

  return (
    <section
      id={GIT_AGENT_COMPARISON_PANEL_ID}
      className="git-agent-comparison"
      role="tabpanel"
      aria-labelledby={GIT_AGENT_COMPARISON_TAB_ID}
    >
      <header className="git-agent-comparison-controls">
        <span>
          <strong>Compare committed code from two agents</strong>
          <small>
            Forgeboard resolves both saved runs to their owned worktrees. No folder or Git ref comes
            from this screen.
          </small>
        </span>
        <label>
          Other agent run
          <select
            name="git-agent-comparison-run"
            aria-label="Other agent run"
            value={selectedRunId}
            disabled={loadingRuns || comparing}
            onChange={(event) => {
              setSelectedRunId(event.target.value);
              setComparison(null);
              setError(null);
            }}
          >
            <option value="">Choose another available run</option>
            {candidates.map((run) => (
              <option key={run.id} value={run.id}>
                {run.nodeId} · {run.adapterId} · {run.branch ?? 'detached'} · {run.id.slice(0, 12)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button primary"
          disabled={selectedRunId === '' || loadingRuns || comparing}
          onClick={() => void compare()}
        >
          {comparing ? (
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
          ) : (
            <GitCompareArrows size={14} aria-hidden="true" />
          )}{' '}
          Compare committed code
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh comparable agent runs"
          disabled={loadingRuns || comparing}
          onClick={loadRuns}
        >
          <RefreshCw className={loadingRuns ? 'spin' : ''} size={14} aria-hidden="true" />
        </button>
      </header>
      {loadingRuns ? <p role="status">Loading available agent worktrees…</p> : null}
      {!loadingRuns && error === null && candidates.length === 0 ? (
        <p className="git-agent-comparison-empty" role="status">
          Run another agent for this project and keep its workspace to compare committed code.
        </p>
      ) : null}
      {error !== null ? (
        <p className="git-agent-comparison-error" role="alert">
          <TriangleAlert size={14} aria-hidden="true" /> {error}
        </p>
      ) : null}
      {comparison !== null ? (
        <GitComparisonPanel
          comparison={comparison.comparison}
          presentation={{
            leftLabel: `${comparison.left.agentId} · ${comparison.left.runId.slice(0, 12)}`,
            rightLabel: `${comparison.right.agentId} · ${comparison.right.runId.slice(0, 12)}`,
            distanceLabel: 'Right agent compared to left',
            aheadLabel: 'Only in right agent',
            behindLabel: 'Only in left agent',
            filesLabel: 'Code changed between agents',
            emptyDescription:
              'Both agent worktrees point to committed trees with the same content.',
          }}
          {...(displayPreferences === undefined ? {} : { displayPreferences })}
          {...(onDisplayPreferencesChange === undefined ? {} : { onDisplayPreferencesChange })}
        />
      ) : null}
    </section>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() !== '' ? cause.message : fallback;
}
