import { CheckCircle2, FileCode2, GitCommitHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { GitAgentBaseComparisonView } from '../../../../shared/git/contracts.js';
import { GitDiffViewer } from './diff/GitDiffViewer.js';
import { GitFilePageControls, useGitFilePage } from './diff/GitFilePagination.js';
import type { GitDiffDisplayFile } from './git-review-model.js';
import { fileDiffStats } from './git-review-model.js';
import { GIT_BASE_PANEL_ID, GIT_BASE_TAB_ID } from './GitReviewModeTabs.js';
import type { GitReviewNotesController } from './review-notes/useGitReviewNotes.js';

export function GitBaseComparisonPanel({
  comparison,
  footer,
  reviewNotes,
}: {
  comparison: GitAgentBaseComparisonView;
  footer?: React.ReactNode;
  reviewNotes?: GitReviewNotesController;
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
        <ComparisonStat label="Immutable base" value={comparison.baseCommit} code />
        <ComparisonStat label="Owned worktree HEAD" value={comparison.headCommit} code />
        <ComparisonStat
          label="Commit distance"
          value={`${comparison.ahead} ahead · ${comparison.behind} behind`}
        />
        <ComparisonStat
          label="Committed diff"
          value={`${files.length} files · +${comparison.diff.additions} −${comparison.diff.deletions}`}
        />
      </header>
      <details className="git-base-commit-list">
        <summary>
          <GitCommitHorizontal size={13} aria-hidden="true" /> {comparison.commitCount} comparison
          commit{comparison.commitCount === 1 ? '' : 's'}
          {comparison.commitIdsTruncated ? ' · identifiers truncated' : ''}
        </summary>
        <dl className="git-base-binding-list">
          <dt>Immutable base</dt>
          <dd>
            <code>{comparison.baseCommit}</code>
          </dd>
          <dt>Owned HEAD</dt>
          <dd>
            <code>{comparison.headCommit}</code>
          </dd>
        </dl>
        {comparison.commits.length === 0 ? (
          <p>Base and worktree HEAD contain no commits unique to either side.</p>
        ) : (
          <ol>
            {comparison.commits.map((commit) => (
              <li key={`${commit.relation}:${commit.oid}`}>
                <code>{commit.oid}</code>
                <span>{commit.relation === 'ahead' ? 'Worktree-only' : 'Base-only'}</span>
              </li>
            ))}
          </ol>
        )}
      </details>
      {files.length === 0 ? (
        <div className="git-base-comparison-empty" role="status">
          <CheckCircle2 size={28} aria-hidden="true" />
          <strong>No committed changes vs base</strong>
          <p>
            The owned worktree HEAD has no file difference from its persisted immutable base. Staged
            or unstaged edits remain available in the other view.
          </p>
        </div>
      ) : (
        <div className="git-review-workspace git-base-comparison-workspace">
          <nav className="git-file-sidebar" aria-label="Files changed vs base">
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

function comparisonStatus(file: GitDiffDisplayFile): string {
  if (file.diff?.binary === true) return 'Binary';
  const status = file.diff?.status ?? 'unknown';
  return status === 'unknown' ? 'Changed' : `${status[0]?.toUpperCase() ?? ''}${status.slice(1)}`;
}
