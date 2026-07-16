import type { DiffReviewTarget } from '@forgeboard/core/domain';
import { FileDiff, GitBranch, GitCompareArrows, Lock, TriangleAlert } from 'lucide-react';

import {
  GitTargetInputSchema,
  type GitReviewView,
  type GitTargetInput,
} from '../../../../../shared/git/contracts.js';
import type { GitDiffDisplayPreferences } from '../../git-review/diff/GitDiffViewer.js';

import './DiffReviewNodeInspector.css';

export type DiffReviewTerminalRunStatus =
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'terminated'
  | 'lost';

/**
 * A renderer-safe choice derived from a persisted terminal agent run. The main process remains
 * responsible for resolving the opaque run id back to an owned worktree.
 */
export interface DiffReviewAgentRunOption {
  readonly runId: string;
  readonly nodeLabel: string;
  readonly agentLabel: string;
  readonly status: DiffReviewTerminalRunStatus;
  readonly branch: string | null;
  readonly endedAt: string;
}

export type DiffReviewDisplayPreferences = GitDiffDisplayPreferences;

export type DiffReviewAuthorityAvailability =
  | { readonly state: 'ready' }
  | { readonly state: 'loading'; readonly message?: string }
  | { readonly state: 'unavailable'; readonly reason: string };

export interface DiffReviewGitSummary {
  readonly target: GitTargetInput;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly conflicted: boolean;
  readonly changedFileCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly ahead: number;
  readonly behind: number;
  readonly refreshedAt: string;
  readonly baseComparison?: {
    readonly ahead: number;
    readonly behind: number;
    readonly commitCount: number;
    readonly changedFileCount: number;
    readonly additions: number;
    readonly deletions: number;
  };
}

export interface DiffReviewOpenRequest {
  readonly target: GitTargetInput;
  readonly preferences: DiffReviewDisplayPreferences;
}

export interface DiffReviewNodeInspectorProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly nodeId: string;
  readonly locked: boolean;
  readonly configurationReadOnly: boolean;
  /** Undefined means this is a legacy node whose primary target has not been persisted yet. */
  readonly selectedTarget: DiffReviewTarget | undefined;
  readonly agentRuns: readonly DiffReviewAgentRunOption[];
  readonly agentRunsLoaded: boolean;
  readonly agentRunsError: string | null;
  readonly preferences: DiffReviewDisplayPreferences;
  readonly authority: DiffReviewAuthorityAvailability;
  readonly summary?: DiffReviewGitSummary | null;
  readonly onRecord: () => void;
  readonly onTargetChange: (target: DiffReviewTarget) => void;
  readonly onPreferencesChange: (preferences: DiffReviewDisplayPreferences) => void;
  readonly onRefreshAgentRuns: () => void;
  readonly onRefreshSummary: () => void;
  readonly onOpenReview: (request: DiffReviewOpenRequest) => void;
}

const PRIMARY_TARGET_VALUE = 'primary';
const AGENT_TARGET_PREFIX = 'agent:';
const DEFAULT_TARGET: DiffReviewTarget = { kind: 'primary' };

export function DiffReviewNodeInspector(props: DiffReviewNodeInspectorProps) {
  const selectedTarget = props.selectedTarget ?? DEFAULT_TARGET;
  const targetIsLegacyDefault = props.selectedTarget === undefined;
  const runs = uniqueRuns(props.agentRuns);
  const selectedRun =
    selectedTarget.kind === 'primary'
      ? null
      : (runs.find((run) => run.runId === selectedTarget.runId) ?? null);
  const targetIsUnlisted = selectedTarget.kind === 'agent-run' && selectedRun === null;
  const parsedTarget = parseTarget(
    props.projectId,
    selectedTarget.kind === 'primary' ? null : selectedTarget.runId,
  );
  const targetIsInvalid = parsedTarget === null;
  // This picker is deliberately bounded. Absence from it is never proof that an older persisted
  // run is stale; the exact opaque id is revalidated by the main-process Git resolver.
  const target = parsedTarget;
  const summaryMatches = target !== null && targetMatches(props.summary?.target, target);
  const configurationDisabled = props.locked || props.configurationReadOnly;
  const canOpen = target !== null && props.authority.state === 'ready';
  const targetValue =
    selectedTarget.kind === 'primary'
      ? PRIMARY_TARGET_VALUE
      : `${AGENT_TARGET_PREFIX}${selectedTarget.runId}`;

  const selectTarget = (value: string): void => {
    if (value === PRIMARY_TARGET_VALUE) {
      props.onTargetChange({ kind: 'primary' });
      return;
    }
    if (!value.startsWith(AGENT_TARGET_PREFIX)) return;
    const runId = value.slice(AGENT_TARGET_PREFIX.length);
    if (runs.some((run) => run.runId === runId)) {
      props.onTargetChange({ kind: 'agent-run', runId });
    }
  };

  return (
    <section className="diff-review-node-inspector" aria-label="Diff review configuration">
      <header>
        <span>
          <GitCompareArrows size={15} aria-hidden="true" />
          <strong>Authoritative Git review</strong>
        </span>
        <span className={`status-chip ${canOpen && !targetIsLegacyDefault ? 'ok' : 'warning'}`}>
          {authorityLabel(props.authority, targetIsInvalid, targetIsLegacyDefault)}
        </span>
      </header>

      {props.locked && (
        <p className="node-lock-notice" role="status">
          <Lock size={13} aria-hidden="true" />
          This node is locked. Its target and display preferences cannot change, but an available
          authoritative review can still be opened. Any mutating Git action requires its own
          authoritative approval.
        </p>
      )}

      {!props.locked && props.configurationReadOnly && (
        <p className="node-lock-notice" role="status">
          <Lock size={13} aria-hidden="true" />
          Your collaboration role can inspect this review, but it cannot change the shared target or
          display preferences. Dialog-only display changes remain local to this session.
        </p>
      )}

      {targetIsLegacyDefault && (
        <p className="diff-review-state warning diff-review-legacy-state" role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>
            This legacy node has no persisted review target. Primary checkout is only the current
            default until you bind it in the UI.
            <button
              className="button ghost"
              type="button"
              disabled={configurationDisabled}
              onClick={() => {
                props.onRecord();
                props.onTargetChange({ kind: 'primary' });
              }}
            >
              Bind primary target
            </button>
          </span>
        </p>
      )}

      <fieldset disabled={configurationDisabled}>
        <label>
          Review target
          <select
            name={`node-${props.nodeId}-diff-review-target`}
            aria-label="Review target"
            aria-describedby={`node-${props.nodeId}-diff-review-target-description`}
            disabled={configurationDisabled}
            value={targetValue}
            onFocus={props.onRecord}
            onChange={(event) => selectTarget(event.currentTarget.value)}
          >
            <option value={PRIMARY_TARGET_VALUE}>Primary checkout · {props.projectName}</option>
            {targetIsUnlisted && selectedTarget.kind === 'agent-run' && (
              <option value={`${AGENT_TARGET_PREFIX}${selectedTarget.runId}`}>
                {props.agentRunsLoaded
                  ? 'Prior agent run · outside recent picker; verifying exact run'
                  : 'Prior agent run · loading recent history'}
              </option>
            )}
            {runs.map((run) => (
              <option key={run.runId} value={`${AGENT_TARGET_PREFIX}${run.runId}`}>
                {runOptionLabel(run)}
              </option>
            ))}
          </select>
          <small id={`node-${props.nodeId}-diff-review-target-description`}>
            Agent choices are finished persisted runs. Forgeboard resolves the selected run to its
            owned worktree in the main process when the review opens.
          </small>
        </label>

        <div className="diff-review-display-preferences" role="group" aria-label="Diff display">
          <label>
            Layout
            <select
              name={`node-${props.nodeId}-diff-view-mode`}
              disabled={configurationDisabled}
              value={props.preferences.viewMode}
              onFocus={props.onRecord}
              onChange={(event) =>
                props.onPreferencesChange({
                  ...props.preferences,
                  viewMode: event.currentTarget.value as DiffReviewDisplayPreferences['viewMode'],
                })
              }
            >
              <option value="unified">Unified</option>
              <option value="split">Split</option>
            </select>
          </label>
          <label className="diff-review-whitespace-preference">
            <input
              type="checkbox"
              name={`node-${props.nodeId}-diff-show-whitespace`}
              disabled={configurationDisabled}
              checked={props.preferences.showWhitespace}
              onFocus={props.onRecord}
              onChange={(event) =>
                props.onPreferencesChange({
                  ...props.preferences,
                  showWhitespace: event.currentTarget.checked,
                })
              }
            />
            <span>
              Show whitespace characters
              <small>This changes display only; it never hides or discards Git changes.</small>
            </span>
          </label>
        </div>
      </fieldset>

      <button
        className="button ghost diff-review-refresh-runs"
        type="button"
        disabled={!props.agentRunsLoaded}
        onClick={props.onRefreshAgentRuns}
      >
        Refresh persisted runs
      </button>

      <DiffReviewState authority={props.authority} targetIsInvalid={targetIsInvalid} />

      {props.agentRunsError !== null && (
        <p className="diff-review-state warning" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          Recent agent runs could not be loaded: {props.agentRunsError}
        </p>
      )}

      {props.summary !== null &&
        props.summary !== undefined &&
        target !== null &&
        !summaryMatches && (
          <p className="diff-review-state warning" role="status">
            <TriangleAlert size={14} aria-hidden="true" />
            The available summary belongs to a previous target and is not shown. Open this target to
            refresh authoritative Git state.
          </p>
        )}

      {summaryMatches && props.summary !== null && props.summary !== undefined && (
        <DiffReviewSummary summary={props.summary} />
      )}

      {props.agentRunsLoaded &&
        props.agentRunsError === null &&
        runs.length === 0 &&
        !targetIsUnlisted && (
          <p className="diff-review-empty-state">
            No recent writable agent runs are available in the picker. The primary checkout remains
            available, and older pinned runs are always verified by exact run ID.
          </p>
        )}

      <button
        className="button primary diff-review-open-button"
        type="button"
        disabled={!canOpen}
        onClick={() => {
          if (target === null) return;
          props.onOpenReview({ target, preferences: props.preferences });
        }}
      >
        <FileDiff size={14} aria-hidden="true" /> Open authoritative review
      </button>
      <button
        className="button ghost diff-review-refresh-summary"
        type="button"
        disabled={props.authority.state === 'loading'}
        onClick={props.onRefreshSummary}
      >
        Refresh Git summary
      </button>
      <small className="diff-review-boundary-note">
        This node stores only an opaque target choice and display preferences. Repository and
        worktree paths are resolved and revalidated outside the renderer.
      </small>
    </section>
  );
}

export function diffReviewGitSummary(review: GitReviewView): DiffReviewGitSummary {
  const target: GitTargetInput =
    review.target.kind === 'primary'
      ? { kind: 'primary', projectId: review.target.projectId }
      : {
          kind: 'agent-worktree',
          projectId: review.target.projectId,
          runId: review.target.runId,
        };
  return {
    target,
    branch: review.branch,
    dirty: review.dirty,
    conflicted: review.conflicted,
    changedFileCount: review.entries.length,
    additions: review.staged.additions + review.unstaged.additions,
    deletions: review.staged.deletions + review.unstaged.deletions,
    ahead: review.ahead,
    behind: review.behind,
    refreshedAt: review.refreshedAt,
    ...(review.baseComparison === undefined
      ? {}
      : {
          baseComparison: {
            ahead: review.baseComparison.ahead,
            behind: review.baseComparison.behind,
            commitCount: review.baseComparison.commitCount,
            changedFileCount: review.baseComparison.diff.files.length,
            additions: review.baseComparison.diff.additions,
            deletions: review.baseComparison.diff.deletions,
          },
        }),
  };
}

function DiffReviewState({
  authority,
  targetIsInvalid,
}: {
  authority: DiffReviewAuthorityAvailability;
  targetIsInvalid: boolean;
}) {
  if (targetIsInvalid) {
    return (
      <p className="diff-review-state warning" role="alert">
        <TriangleAlert size={14} aria-hidden="true" />
        The selected project or run identity is invalid. Refresh the project before opening review.
      </p>
    );
  }
  if (authority.state === 'unavailable') {
    return (
      <p className="diff-review-state warning" role="alert">
        <TriangleAlert size={14} aria-hidden="true" />
        {authority.reason}
      </p>
    );
  }
  if (authority.state === 'loading') {
    return (
      <p className="diff-review-state" role="status">
        <GitCompareArrows size={14} aria-hidden="true" />
        {authority.message ?? 'Checking whether authoritative Git review is available…'}
      </p>
    );
  }
  return null;
}

function DiffReviewSummary({ summary }: { summary: DiffReviewGitSummary }) {
  return (
    <section className="diff-review-summary" aria-label="Bound Git summary">
      <header>
        <GitBranch size={14} aria-hidden="true" />
        <span>
          <small>Bound Git summary</small>
          <strong>{summary.branch ?? 'Detached or unborn branch'}</strong>
        </span>
      </header>
      <dl>
        <div>
          <dt>Working tree</dt>
          <dd>
            {summary.conflicted ? 'Conflicts' : summary.dirty ? 'Changed' : 'Clean'} ·{' '}
            {summary.changedFileCount} {summary.changedFileCount === 1 ? 'path' : 'paths'}
          </dd>
        </div>
        <div>
          <dt>Tracked text</dt>
          <dd>
            +{summary.additions} −{summary.deletions}
          </dd>
        </div>
        <div>
          <dt>Upstream</dt>
          <dd>
            {summary.ahead} ahead · {summary.behind} behind
          </dd>
        </div>
        {summary.baseComparison !== undefined && (
          <div>
            <dt>Agent vs base</dt>
            <dd>
              {summary.baseComparison.changedFileCount}{' '}
              {summary.baseComparison.changedFileCount === 1 ? 'path' : 'paths'} · +
              {summary.baseComparison.additions} −{summary.baseComparison.deletions} ·{' '}
              {summary.baseComparison.commitCount} commits · {summary.baseComparison.ahead} ahead ·{' '}
              {summary.baseComparison.behind} behind
            </dd>
          </div>
        )}
      </dl>
      <small>Refreshed {formatTimestamp(summary.refreshedAt)}</small>
    </section>
  );
}

function parseTarget(projectId: string, runId: string | null): GitTargetInput | null {
  const result = GitTargetInputSchema.safeParse(
    runId === null ? { kind: 'primary', projectId } : { kind: 'agent-worktree', projectId, runId },
  );
  return result.success ? result.data : null;
}

function targetMatches(left: GitTargetInput | undefined, right: GitTargetInput): boolean {
  if (left === undefined || left.kind !== right.kind || left.projectId !== right.projectId) {
    return false;
  }
  return left.kind === 'primary' || (right.kind === 'agent-worktree' && left.runId === right.runId);
}

function uniqueRuns(runs: readonly DiffReviewAgentRunOption[]): DiffReviewAgentRunOption[] {
  const seen = new Set<string>();
  return runs.filter((run) => {
    if (seen.has(run.runId)) return false;
    seen.add(run.runId);
    return true;
  });
}

function runOptionLabel(run: DiffReviewAgentRunOption): string {
  const branch = run.branch === null ? 'detached branch' : run.branch;
  return `${run.nodeLabel} · ${run.agentLabel} · ${run.status} · ${branch}`;
}

function authorityLabel(
  authority: DiffReviewAuthorityAvailability,
  targetIsInvalid: boolean,
  targetIsLegacyDefault: boolean,
): string {
  if (targetIsInvalid) return 'Invalid target';
  if (authority.state === 'unavailable') return 'Unavailable';
  if (authority.state === 'loading') return 'Checking';
  return targetIsLegacyDefault ? 'Default target' : 'Ready';
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'at an unknown time' : parsed.toLocaleString();
}
