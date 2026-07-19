import { useState } from 'react';
import { ArchiveRestore, GitBranch, History, Play, RefreshCw, RotateCcw } from 'lucide-react';

import type {
  AgentDetection,
  RunAdapterId,
} from '../../../../../../shared/application/contracts.js';
import type { RunHistorySummary } from '../../../../../../shared/runs/contracts.js';
import type { GitWorktreeRestorePlanView } from '../../../../../../shared/git/lifecycle/contracts.js';
import { unwrap } from '../../../../lib/ipc.js';
import { continuationUnavailableReason, type SelectedAgentAuthority } from './attempt-actions.js';
import { useAgentAttemptHistory } from './useAgentAttemptHistory.js';
import { tokenUsageRows } from './usage/token-usage.js';

export interface AgentAttemptActionCallbacks {
  readonly onRetryAttempt?: (attempt: RunHistorySummary) => void;
  readonly onResumeAttempt?: (attempt: RunHistorySummary) => void;
  readonly onReviewAttempt?: (attempt: RunHistorySummary) => void;
}

interface AgentAttemptHistoryProps extends AgentAttemptActionCallbacks {
  readonly projectId: string;
  readonly nodeId: string;
  readonly refreshKey: string;
  readonly agents: readonly (AgentDetection & { id: RunAdapterId })[];
  readonly selectedAuthority: SelectedAgentAuthority;
  readonly actionUnavailableReason: string | null;
}

export function AgentAttemptHistory({
  projectId,
  nodeId,
  refreshKey,
  agents,
  selectedAuthority,
  actionUnavailableReason,
  onRetryAttempt,
  onResumeAttempt,
  onReviewAttempt,
}: AgentAttemptHistoryProps) {
  const history = useAgentAttemptHistory(projectId, nodeId, refreshKey);
  const [restorePlan, setRestorePlan] = useState<{
    readonly attempt: RunHistorySummary;
    readonly plan: GitWorktreeRestorePlanView;
  } | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreStatus, setRestoreStatus] = useState<string | null>(null);

  const prepareRestore = async (attempt: RunHistorySummary) => {
    setRestoreBusy(true);
    setRestoreError(null);
    setRestoreStatus(null);
    try {
      const plan = unwrap(
        await window.forgeboard.git.lifecycle.prepareRestore({
          projectId,
          runId: attempt.id,
        }),
      );
      setRestorePlan({ attempt, plan });
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : 'Could not review this restore.');
    } finally {
      setRestoreBusy(false);
    }
  };

  const confirmRestore = async () => {
    if (restorePlan === null) return;
    setRestoreBusy(true);
    setRestoreError(null);
    setRestoreStatus(null);
    try {
      const restored = unwrap(
        await window.forgeboard.git.lifecycle.confirmRestore({
          planId: restorePlan.plan.planId,
        }),
      );
      setRestorePlan(null);
      if (restored === null) {
        setRestoreStatus('Restore cancelled. The workspace remains archived.');
      } else {
        setRestoreStatus(`Restored ${restored.branch} for active review.`);
        history.refresh();
      }
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : 'Could not restore this worktree.');
    } finally {
      setRestoreBusy(false);
    }
  };
  return (
    <section className="agent-attempt-history" aria-labelledby={`agent-history-${nodeId}`}>
      <header>
        <div>
          <History size={13} />
          <h4 id={`agent-history-${nodeId}`}>Attempt history</h4>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh Agent attempt history"
          disabled={history.loading}
          onClick={history.refresh}
        >
          <RefreshCw size={12} />
        </button>
      </header>
      {history.loading ? <p role="status">Loading attempt history…</p> : null}
      {history.error !== null ? (
        <div className="agent-history-error" role="alert">
          <p>{history.error}</p>
          <button type="button" onClick={history.refresh}>
            Try again
          </button>
        </div>
      ) : null}
      {!history.loading && history.error === null && history.attempts.length === 0 ? (
        <p>No attempts have been recorded for this Agent node.</p>
      ) : null}
      {history.attempts.length > 0 ? (
        <ol aria-label="Agent attempts">
          {history.attempts.map((attempt) => {
            const agent = agents.find((candidate) => candidate.id === attempt.adapterId);
            const retryReason =
              actionUnavailableReason ??
              continuationUnavailableReason(attempt, 'retry', selectedAuthority);
            const resumeReason =
              actionUnavailableReason ??
              continuationUnavailableReason(attempt, 'resume', selectedAuthority);
            return (
              <li key={attempt.id}>
                <article
                  aria-label={`${actionLabel(attempt.action)} attempt ${statusLabel(attempt.status)}`}
                >
                  <header>
                    <div>
                      <strong>{actionLabel(attempt.action)}</strong>
                      <span className={`agent-attempt-status status-${attempt.status}`}>
                        {statusLabel(attempt.status)}
                      </span>
                    </div>
                    <time dateTime={attempt.createdAt}>{formatTimestamp(attempt.createdAt)}</time>
                  </header>
                  <dl>
                    <Meta label="Provider" value={agent?.label ?? attempt.adapterId} />
                    <Meta label="Model" value={attempt.model ?? 'Provider default'} />
                    <Meta label="Permission" value={permissionLabel(attempt.permissionProfile)} />
                    <Meta label="Duration" value={formatDuration(attempt)} />
                    <Meta label="Branch" value={attempt.branch ?? 'Not reported'} />
                    <Meta label="Worktree" value={worktreeLabel(attempt)} />
                    <Meta
                      label="Exit"
                      value={attempt.exitCode === null ? 'Not reported' : String(attempt.exitCode)}
                    />
                    <Meta
                      label="Files"
                      value={
                        attempt.changedFileCount === null
                          ? 'Not reported'
                          : String(attempt.changedFileCount)
                      }
                    />
                    <Meta label="Output digest" value={shortDigest(attempt.outputDigest)} />
                    {attempt.tokenUsage === null ? (
                      <Meta label="Tokens" value="Not exposed by provider" />
                    ) : (
                      tokenUsageRows(attempt.tokenUsage).map((row) => (
                        <Meta key={row.label} label={row.label} value={row.value} />
                      ))
                    )}
                    <Meta label="Cost" value={costLabel(attempt.costUsd)} />
                    <Meta
                      label="Session"
                      value={
                        !attempt.providerSessionAvailable
                          ? 'Not exposed by provider'
                          : resumeReason === null
                            ? `Available for resume review (${resumeSourceLabel(attempt.resumeCapabilitySource)})`
                            : 'Recorded; resume unavailable for this attempt'
                      }
                    />
                  </dl>
                  {attempt.parentRunId !== null ? (
                    <p className="agent-attempt-lineage">
                      Based on attempt <code>{attempt.parentRunId.slice(0, 8)}</code>
                    </p>
                  ) : null}
                  {attempt.supersededByNewerAttempt ? (
                    <p className="agent-attempt-lineage" role="status">
                      Superseded by newer resume
                    </p>
                  ) : null}
                  {attempt.outputPreview.trim() !== '' ? (
                    <details>
                      <summary>Output preview</summary>
                      <pre>{attempt.outputPreview}</pre>
                    </details>
                  ) : null}
                  <div className="agent-attempt-actions">
                    <button
                      type="button"
                      disabled={retryReason !== null || onRetryAttempt === undefined}
                      title={
                        retryReason ??
                        (onRetryAttempt === undefined
                          ? 'Retry wiring is not available in this build.'
                          : undefined)
                      }
                      onClick={() => onRetryAttempt?.(attempt)}
                    >
                      <RotateCcw size={11} /> Retry review
                    </button>
                    <button
                      type="button"
                      disabled={resumeReason !== null || onResumeAttempt === undefined}
                      title={
                        resumeReason ??
                        (onResumeAttempt === undefined
                          ? 'Resume wiring is not available in this build.'
                          : undefined)
                      }
                      onClick={() => onResumeAttempt?.(attempt)}
                    >
                      <Play size={11} /> Resume review
                    </button>
                    <button
                      type="button"
                      disabled={!attempt.worktreeAvailable || onReviewAttempt === undefined}
                      title={
                        attempt.supersededByNewerAttempt
                          ? 'A newer resumed attempt owns this worktree authority.'
                          : !attempt.worktreeAvailable
                            ? 'This attempt no longer has an available worktree.'
                            : onReviewAttempt === undefined
                              ? 'Worktree review wiring is not available in this build.'
                              : undefined
                      }
                      onClick={() => onReviewAttempt?.(attempt)}
                    >
                      <GitBranch size={11} /> Review changes
                    </button>
                    {attempt.worktreeState === 'archived' && !attempt.supersededByNewerAttempt ? (
                      <button
                        type="button"
                        disabled={restoreBusy}
                        onClick={() => void prepareRestore(attempt)}
                      >
                        <ArchiveRestore size={11} /> Restore workspace
                      </button>
                    ) : null}
                  </div>
                  {restorePlan?.attempt.id === attempt.id ? (
                    <div
                      className="agent-history-restore-review"
                      role="group"
                      aria-label="Restore workspace review"
                    >
                      <strong>Restore archived workspace?</strong>
                      <p>
                        Branch <code>{restorePlan.plan.branch}</code> and all files, commits, and{' '}
                        {restorePlan.plan.dirtyPathCount} uncommitted path(s) stay unchanged.
                      </p>
                      <p>
                        A native confirmation will revalidate the exact Git state before restoring
                        access.
                      </p>
                      <div className="agent-attempt-actions">
                        <button
                          type="button"
                          disabled={restoreBusy}
                          onClick={() => setRestorePlan(null)}
                        >
                          Go back
                        </button>
                        <button
                          type="button"
                          disabled={restoreBusy}
                          onClick={() => void confirmRestore()}
                        >
                          Continue to native confirmation
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ol>
      ) : null}
      {restoreError !== null ? (
        <p className="agent-history-error" role="alert">
          {restoreError}
        </p>
      ) : null}
      {restoreStatus !== null ? <p role="status">{restoreStatus}</p> : null}
    </section>
  );
}

function Meta({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function actionLabel(action: RunHistorySummary['action']): string {
  return action === 'launch' ? 'Initial run' : action === 'resume' ? 'Resumed run' : 'Retry';
}

function statusLabel(status: RunHistorySummary['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatDuration(attempt: RunHistorySummary): string {
  if (attempt.startedAt === null) return 'Not started';
  const end = attempt.endedAt === null ? Date.now() : Date.parse(attempt.endedAt);
  const durationMs = Math.max(0, end - Date.parse(attempt.startedAt));
  const seconds = Math.floor(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function worktreeLabel(attempt: RunHistorySummary): string {
  if (attempt.worktreeAvailable) return 'Available for review';
  if (attempt.worktreeState === 'cleanup-pending') return 'Cleanup pending';
  if (attempt.worktreeState === 'archived') return 'Archived';
  if (attempt.worktreeState === 'cleaned') return 'Cleaned';
  return attempt.worktreeState === 'active' ? 'Unavailable' : 'Not created';
}

function shortDigest(digest: string | null): string {
  return digest === null ? 'Not recorded' : `${digest.slice(0, 12)}…`;
}

function costLabel(costUsd: number | null): string {
  return costUsd === null ? 'Not exposed by provider' : `$${costUsd.toFixed(4)}`;
}

function permissionLabel(profile: RunHistorySummary['permissionProfile']): string {
  if (profile === null) return 'Not recorded';
  if (profile === 'plan-read-only') return 'Plan / read only';
  if (profile === 'worktree-write') return 'Dedicated worktree';
  if (profile === 'docker-isolated') return 'Docker isolated';
  return 'Custom profile';
}

function resumeSourceLabel(source: RunHistorySummary['resumeCapabilitySource']): string {
  if (source === 'probe') return 'CLI capability probed';
  if (source === 'manifest') return 'adapter manifest';
  return 'provider capability';
}
