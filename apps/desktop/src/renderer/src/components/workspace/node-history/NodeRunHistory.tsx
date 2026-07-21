import { History, RefreshCw } from 'lucide-react';

import type { WorkflowExecutionView } from '../../../../../shared/workflow/contracts.js';

interface NodeRunHistoryProps {
  readonly nodeId: string;
  readonly executions: readonly WorkflowExecutionView[];
}

interface NodeRunEntry {
  readonly executionId: string;
  readonly executionCreatedAt: string;
  readonly executionUpdatedAt: string;
  readonly attempt: number;
  readonly status: WorkflowExecutionView['nodeRuns'][number]['status'];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly statusReason?: string;
}

/** Shared workflow history shown for every built-in and extension node. */
export function NodeRunHistory({ nodeId, executions }: NodeRunHistoryProps) {
  const entries = nodeRunHistoryEntries(nodeId, executions);
  return (
    <section className="node-run-history" aria-labelledby={`node-run-history-${nodeId}`}>
      <header>
        <div>
          <History size={14} aria-hidden="true" />
          <h3 id={`node-run-history-${nodeId}`}>Workflow run history</h3>
        </div>
        <span>{entries.length}</span>
      </header>
      {entries.length === 0 ? (
        <p className="node-run-history-empty" role="status">
          No saved workflow runs for this node yet.
        </p>
      ) : (
        <ol>
          {entries.map((entry) => (
            <li key={`${entry.executionId}:${String(entry.attempt)}`}>
              <span className={`run-status ${entry.status}`} aria-hidden="true" />
              <div>
                <strong>{statusLabel(entry.status)}</strong>
                <small>
                  Attempt {entry.attempt} · {timeLabel(entry)}
                </small>
                {entry.statusReason !== undefined && <p>{entry.statusReason}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="node-run-history-note">
        <RefreshCw size={12} aria-hidden="true" />
        Saved locally and restored when this project is reopened.
      </p>
    </section>
  );
}

export function nodeRunHistoryEntries(
  nodeId: string,
  executions: readonly WorkflowExecutionView[],
): readonly NodeRunEntry[] {
  return executions
    .flatMap((execution) =>
      execution.nodeRuns
        .filter((run) => run.nodeId === nodeId)
        .map((run) => ({
          executionId: execution.id,
          executionCreatedAt: execution.createdAt,
          executionUpdatedAt: execution.updatedAt,
          attempt: run.attempt,
          status: run.status,
          ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
          ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
          ...(run.statusReason === undefined ? {} : { statusReason: run.statusReason }),
        })),
    )
    .sort((left, right) => {
      const time = Date.parse(right.executionUpdatedAt) - Date.parse(left.executionUpdatedAt);
      return time === 0 ? right.attempt - left.attempt : time;
    })
    .slice(0, 20);
}

function statusLabel(status: NodeRunEntry['status']): string {
  return status
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function timeLabel(entry: NodeRunEntry): string {
  const timestamp = entry.endedAt ?? entry.startedAt ?? entry.executionCreatedAt;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}
