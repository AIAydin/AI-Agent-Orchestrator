import { CheckCircle2, FileCode2, GitCommitHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { GitAgentBaseComparisonView } from '../../../../shared/git/contracts.js';
import { GitDiffViewer, type GitDiffDisplayPreferences } from './diff/GitDiffViewer.js';
import { GitFilePageControls, useGitFilePage } from './diff/GitFilePagination.js';
import type { GitDiffDisplayFile } from './git-review-model.js';
import { fileDiffStats } from './git-review-model.js';
import { GIT_BASE_PANEL_ID, GIT_BASE_TAB_ID } from './GitReviewModeTabs.js';
import type { GitReviewNotesController } from './review-notes/useGitReviewNotes.js';

export function GitBaseComparisonPanel({
  comparison,
  footer,
  reviewNotes,
  displayPreferences,
  onDisplayPreferencesChange,
}: {
  comparison: GitAgentBaseComparisonView;
  footer?: React.ReactNode;
  reviewNotes?: GitReviewNotesController;
  displayPreferences?: GitDiffDisplayPreferences;
  onDisplayPreferencesChange?: (preferences: GitDiffDisplayPreferences) => void;
}) {
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
      id={GIT_BASE_PANEL_ID}
      className="git-base-comparison"
      role="tabpanel"
      aria-labelledby={GIT_BASE_TAB_ID}
    >
      <header className="git-base-comparison-summary">
        <ComparisonStat label="Starting point" value={comparison.baseCommit} code />
        <ComparisonStat label="Agent's latest commit" value={comparison.headCommit} code />
        <ComparisonStat
          label="Compared to starting point"
          value={commitDistance(comparison.ahead, comparison.behind)}
        />
        <ComparisonStat
          label="Committed changes"
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
          <dt>Starting point</dt>
          <dd>
            <code>{comparison.baseCommit}</code>
          </dd>
          <dt>Agent's latest commit</dt>
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
                  {commit.relation === 'ahead'
                    ? 'Only in agent workspace'
                    : 'Only at starting point'}
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
          <p>
            The agent's latest commit matches its starting point. Anything not committed yet is in
            the other tab.
          </p>
        </div>
      ) : (
        <div className="git-review-workspace git-base-comparison-workspace">
          <nav className="git-file-sidebar" aria-label="Files changed since the starting point">
            <section className="git-file-group" aria-labelledby="git-base-files-heading">
              <header>
                <h3 id="git-base-files-heading">Committed changes</h3>
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
                label="Committed changes"
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
        <code title={value} aria-label={`${label}: ${value}`}>
          {value.slice(0, 12)}
        </code>
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
