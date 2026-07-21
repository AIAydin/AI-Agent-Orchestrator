import { CheckCircle2, FileCode2, GitCommitHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { GitAgentBaseComparisonView } from '../../../../shared/git/contracts.js';
import { GitDiffViewer, type GitDiffDisplayPreferences } from './diff/GitDiffViewer.js';
import { GitFilePageControls, useGitFilePage } from './diff/GitFilePagination.js';
import type { GitDiffDisplayFile } from './git-review-model.js';
import { fileDiffStats } from './git-review-model.js';
import { GIT_BASE_PANEL_ID, GIT_BASE_TAB_ID } from './GitReviewModeTabs.js';
import type { GitReviewNotesController } from './review-notes/useGitReviewNotes.js';
import { WorkspaceTooltip } from '../workspace/shell/tooltips/WorkspaceTooltip.js';

interface GitComparisonPresentation {
  readonly panelId?: string;
  readonly tabId?: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly distanceLabel: string;
  readonly aheadLabel: string;
  readonly behindLabel: string;
  readonly filesLabel: string;
  readonly emptyDescription: string;
}

interface GitComparisonPanelProps {
  comparison: GitAgentBaseComparisonView;
  presentation: GitComparisonPresentation;
  footer?: React.ReactNode;
  reviewNotes?: GitReviewNotesController;
  displayPreferences?: GitDiffDisplayPreferences;
  onDisplayPreferencesChange?: (preferences: GitDiffDisplayPreferences) => void;
}

const basePresentation: GitComparisonPresentation = {
  panelId: GIT_BASE_PANEL_ID,
  tabId: GIT_BASE_TAB_ID,
  leftLabel: 'Starting point',
  rightLabel: "Agent's latest commit",
  distanceLabel: 'Compared to starting point',
  aheadLabel: 'Only in agent workspace',
  behindLabel: 'Only at starting point',
  filesLabel: 'Committed changes',
  emptyDescription:
    "The agent's latest commit matches its starting point. Uncommitted work is in the other tab.",
};

export function GitBaseComparisonPanel(props: Omit<GitComparisonPanelProps, 'presentation'>) {
  return <GitComparisonPanel {...props} presentation={basePresentation} />;
}

export function GitComparisonPanel({
  comparison,
  presentation,
  footer,
  reviewNotes,
  displayPreferences,
  onDisplayPreferencesChange,
}: GitComparisonPanelProps) {
  const files = useMemo(() => comparisonFiles(comparison), [comparison]);
  const [selectedPath, setSelectedPath] = useState<string | null>(files[0]?.path ?? null);
  const selected = files.find((file) => file.path === selectedPath) ?? null;
  const selectedIndex = files.findIndex((file) => file.path === selectedPath);
  const filePage = useGitFilePage(files.length, selectedIndex);

  useEffect(() => {
    setSelectedPath((current) =>
      current !== null && files.some((file) => file.path === current)
        ? current
        : (files[0]?.path ?? null),
    );
  }, [files]);

  return (
    <section
      {...(presentation.panelId === undefined ? {} : { id: presentation.panelId })}
      className="git-base-comparison"
      {...(presentation.tabId === undefined
        ? {}
        : { role: 'tabpanel', 'aria-labelledby': presentation.tabId })}
    >
      <header className="git-base-comparison-summary">
        <ComparisonStat label={presentation.leftLabel} value={comparison.baseCommit} code />
        <ComparisonStat label={presentation.rightLabel} value={comparison.headCommit} code />
        <ComparisonStat
          label={presentation.distanceLabel}
          value={commitDistance(comparison.ahead, comparison.behind)}
        />
        <ComparisonStat
          label={presentation.filesLabel}
          value={`${files.length} ${files.length === 1 ? 'file' : 'files'} · +${comparison.diff.additions} −${comparison.diff.deletions}`}
        />
      </header>
      <details className="git-base-commit-list">
        <summary>
          <GitCommitHorizontal size={13} aria-hidden="true" /> {comparison.commitCount} commit
          {comparison.commitCount === 1 ? '' : 's'} compared
          {comparison.commitIdsTruncated ? ' · not all shown' : ''}
        </summary>
        <dl className="git-base-binding-list">
          <dt>{presentation.leftLabel}</dt>
          <dd>
            <code>{comparison.baseCommit}</code>
          </dd>
          <dt>{presentation.rightLabel}</dt>
          <dd>
            <code>{comparison.headCommit}</code>
          </dd>
        </dl>
        {comparison.commits.length === 0 ? (
          <p>Both sides contain the same commits.</p>
        ) : (
          <ol>
            {comparison.commits.map((commit) => (
              <li key={`${commit.relation}:${commit.oid}`}>
                <code>{commit.oid}</code>
                <span>
                  {commit.relation === 'ahead' ? presentation.aheadLabel : presentation.behindLabel}
                </span>
              </li>
            ))}
          </ol>
        )}
      </details>
      {files.length === 0 ? (
        <div className="git-base-comparison-empty" role="status">
          <CheckCircle2 size={28} aria-hidden="true" />
          <strong>No committed changes to compare</strong>
          <p>{presentation.emptyDescription}</p>
        </div>
      ) : (
        <div className="git-review-workspace git-base-comparison-workspace">
          <nav className="git-file-sidebar" aria-label={presentation.filesLabel}>
            <section className="git-file-group">
              <header>
                <h3>{presentation.filesLabel}</h3>
                <span>{files.length}</span>
              </header>
              <ul>
                {files.slice(filePage.start, filePage.end).map((file) => {
                  const active = file.path === selectedPath;
                  const stats = fileDiffStats(file);
                  return (
                    <li className="git-base-file" key={file.path}>
                      <button
                        className={`git-file-select ${active ? 'active' : ''}`}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSelectedPath(file.path)}
                      >
                        <FileCode2 size={13} aria-hidden="true" />
                        <span>
                          <strong>{file.path}</strong>
                          <small>
                            {comparisonStatus(file)} · +{stats.additions} −{stats.deletions}
                          </small>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <GitFilePageControls
                label={presentation.filesLabel}
                fileCount={files.length}
                page={filePage}
              />
            </section>
          </nav>
          <GitDiffViewer
            file={selected}
            busy={false}
            readOnly
            {...(displayPreferences === undefined ? {} : { displayPreferences })}
            {...(onDisplayPreferencesChange === undefined ? {} : { onDisplayPreferencesChange })}
            {...(reviewNotes === undefined ? {} : { reviewNotes })}
            {...(selectedIndex < 0
              ? {}
              : {
                  navigation: {
                    index: selectedIndex,
                    count: files.length,
                    onPrevious: () => setSelectedPath(files[selectedIndex - 1]?.path ?? null),
                    onNext: () => setSelectedPath(files[selectedIndex + 1]?.path ?? null),
                  },
                })}
            onStageHunk={() => undefined}
            onUnstageHunk={() => undefined}
            onPrepareDiscard={() => undefined}
          />
        </div>
      )}
      {footer}
    </section>
  );
}

function ComparisonStat({
  label,
  value,
  code = false,
}: {
  label: string;
  value: string;
  code?: boolean;
}) {
  return (
    <div>
      <small>{label}</small>
      {code ? (
        <WorkspaceTooltip content={value}>
          <code tabIndex={0} aria-label={`${label}: ${value}`}>
            {value.slice(0, 12)}
          </code>
        </WorkspaceTooltip>
      ) : (
        <strong>{value}</strong>
      )}
    </div>
  );
}

function comparisonFiles(comparison: GitAgentBaseComparisonView): GitDiffDisplayFile[] {
  return comparison.diff.files
    .flatMap((diff) => {
      const path = diff.newPath ?? diff.oldPath;
      return path === null ? [] : [{ area: 'base' as const, path, diff }];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function commitDistance(ahead: number, behind: number): string {
  return `${ahead} ${ahead === 1 ? 'commit' : 'commits'} ahead · ${behind} ${behind === 1 ? 'commit' : 'commits'} behind`;
}

function comparisonStatus(file: GitDiffDisplayFile): string {
  if (file.diff?.binary === true) return 'Binary';
  const status = file.diff?.status ?? 'unknown';
  return status === 'unknown' ? 'Changed' : `${status[0]?.toUpperCase() ?? ''}${status.slice(1)}`;
}
