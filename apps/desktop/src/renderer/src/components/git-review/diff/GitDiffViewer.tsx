import { ChevronLeft, ChevronRight, FileQuestion, Minus, Plus, RotateCcw } from 'lucide-react';
import { useState } from 'react';

import type { GitDiffHunkView } from '../../../../../shared/git/contracts.js';
import type { GitDiffDisplayArea, GitDiffDisplayFile } from '../git-review-model.js';
import type { GitReviewNotesController } from '../review-notes/useGitReviewNotes.js';
import { fileDiffStats } from '../git-review-model.js';
import { GitDiffRows, type GitDiffRowsReview, type GitDiffViewMode } from './GitDiffRows.js';
import { GitDiffToolbar } from './GitDiffToolbar.js';

interface GitDiffNavigation {
  readonly index: number;
  readonly count: number;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}

interface GitDiffViewerProps {
  file: GitDiffDisplayFile | null;
  busy: boolean;
  readOnly?: boolean;
  navigation?: GitDiffNavigation;
  reviewNotes?: GitReviewNotesController;
  onStageHunk: (hunkId: string) => void;
  onUnstageHunk: (hunkId: string) => void;
  onPrepareDiscard: (hunkId: string) => void;
}

export function GitDiffViewer({
  file,
  busy,
  readOnly = false,
  navigation,
  reviewNotes,
  onStageHunk,
  onUnstageHunk,
  onPrepareDiscard,
}: GitDiffViewerProps) {
  const [viewMode, setViewMode] = useState<GitDiffViewMode>('unified');
  const [showWhitespace, setShowWhitespace] = useState(false);

  if (file === null) {
    return (
      <section className="git-diff-empty" aria-label="Change preview">
        <FileQuestion size={30} aria-hidden="true" />
        <strong>Select a changed file</strong>
        <p>Forgeboard renders only the selected file so large reviews stay responsive.</p>
      </section>
    );
  }

  const diff = file.diff;
  const stats = fileDiffStats(file);
  const hasTextDiff = diff !== undefined && !diff.binary && diff.hunks.length > 0;
  const revision = reviewNotes?.context?.revisions.find(
    (candidate) => candidate.area === file.area,
  );
  const currentNotes =
    reviewNotes?.context?.notes.filter(
      (note) =>
        note.anchorState === 'current' &&
        note.anchor.area === file.area &&
        note.anchor.path === file.path,
    ) ?? [];
  const diffReview: GitDiffRowsReview | undefined =
    reviewNotes === undefined || revision === undefined
      ? undefined
      : {
          revision,
          notes: currentNotes,
          actions: {
            busy: reviewNotes.busy,
            onCreate: reviewNotes.create,
            onUpdate: reviewNotes.update,
            onDelete: reviewNotes.remove,
          },
        };
  return (
    <section className="git-diff-viewer" aria-label={`Diff for ${file.path}`}>
      <header>
        <span>
          <strong>{file.path}</strong>
          {diff?.oldPath !== null && diff?.oldPath !== undefined && diff.oldPath !== file.path && (
            <small>renamed from {diff.oldPath}</small>
          )}
        </span>
        {navigation && (
          <span className="git-diff-navigation">
            <button
              type="button"
              aria-label="Previous changed file"
              disabled={navigation.index <= 0}
              onClick={navigation.onPrevious}
            >
              <ChevronLeft size={13} aria-hidden="true" />
            </button>
            <small>
              File {navigation.index + 1} of {navigation.count}
            </small>
            <button
              type="button"
              aria-label="Next changed file"
              disabled={navigation.index >= navigation.count - 1}
              onClick={navigation.onNext}
            >
              <ChevronRight size={13} aria-hidden="true" />
            </button>
          </span>
        )}
        {diff && (
          <span
            className="git-diff-totals"
            role="group"
            aria-label={`${stats.additions} additions and ${stats.deletions} deletions in ${file.path}`}
          >
            <b>+{stats.additions}</b>
            <i>−{stats.deletions}</i>
          </span>
        )}
      </header>
      {hasTextDiff && (
        <GitDiffToolbar
          viewMode={viewMode}
          showWhitespace={showWhitespace}
          onViewModeChange={setViewMode}
          onShowWhitespaceChange={setShowWhitespace}
        />
      )}
      {file.area === 'untracked' ? (
        <GitDiffNotice>
          This file is not tracked yet. Stage the whole file to include it in the index.
        </GitDiffNotice>
      ) : diff?.binary === true ? (
        <GitDiffNotice>
          {readOnly
            ? 'Binary content cannot be shown in this read-only committed comparison.'
            : 'Binary content cannot be shown or selected by hunk. Use the whole-file action.'}
        </GitDiffNotice>
      ) : diff === undefined || diff.hunks.length === 0 ? (
        <GitDiffNotice>No textual hunks are available for this change.</GitDiffNotice>
      ) : (
        <div className="git-hunk-list">
          {diff.hunks.map((hunk) => (
            <GitDiffHunk
              key={hunk.id}
              hunk={hunk}
              area={file.area}
              path={file.path}
              busy={busy}
              readOnly={readOnly}
              viewMode={viewMode}
              showWhitespace={showWhitespace}
              review={diffReview}
              onStage={() => onStageHunk(hunk.id)}
              onUnstage={() => onUnstageHunk(hunk.id)}
              onDiscard={() => onPrepareDiscard(hunk.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function GitDiffHunk({
  hunk,
  area,
  path,
  busy,
  readOnly,
  viewMode,
  showWhitespace,
  review,
  onStage,
  onUnstage,
  onDiscard,
}: {
  hunk: GitDiffHunkView;
  area: GitDiffDisplayArea;
  path: string;
  busy: boolean;
  readOnly: boolean;
  viewMode: GitDiffViewMode;
  showWhitespace: boolean;
  review: GitDiffRowsReview | undefined;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}) {
  return (
    <article className="git-hunk">
      <header>
        <code>{hunk.header}</code>
        <span>
          {readOnly ? (
            <small className="git-hunk-read-only">Committed comparison</small>
          ) : area === 'staged' ? (
            <button type="button" disabled={busy} onClick={onUnstage}>
              <Minus size={12} aria-hidden="true" /> Unstage hunk
            </button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={onStage}>
                <Plus size={12} aria-hidden="true" /> Stage hunk
              </button>
              <button
                className="danger-text"
                type="button"
                disabled={busy}
                aria-label={`Review discard for hunk in ${path}`}
                onClick={onDiscard}
              >
                <RotateCcw size={12} aria-hidden="true" /> Discard hunk…
              </button>
            </>
          )}
        </span>
      </header>
      <GitDiffRows
        hunk={hunk}
        path={path}
        viewMode={viewMode}
        showWhitespace={showWhitespace}
        {...(review === undefined ? {} : { review })}
      />
    </article>
  );
}

function GitDiffNotice({ children }: { children: string }) {
  return <p className="git-diff-notice">{children}</p>;
}
