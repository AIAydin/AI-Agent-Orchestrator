import { Fragment, useState } from 'react';

import type { GitDiffHunkView, GitDiffLineView } from '../../../../../shared/git/contracts.js';
import type {
  GitReviewAnchorInput,
  GitReviewNoteView,
  GitReviewRevisionView,
} from '../../../../../shared/git/reviews/contracts.js';
import {
  GitReviewThreadTableRow,
  type LineReviewActions,
} from '../review-notes/GitLineReviewThread.js';

export type GitDiffViewMode = 'unified' | 'split';

interface SplitDiffRow {
  readonly oldLine: GitDiffLineView | null;
  readonly newLine: GitDiffLineView | null;
}

export function GitDiffRows({
  hunk,
  path,
  viewMode,
  showWhitespace,
  review,
}: {
  hunk: GitDiffHunkView;
  path: string;
  viewMode: GitDiffViewMode;
  showWhitespace: boolean;
  review?: GitDiffRowsReview;
}) {
  const [composingAnchor, setComposingAnchor] = useState<string | null>(null);
  return viewMode === 'split' ? (
    <SplitDiffTable
      hunk={hunk}
      path={path}
      showWhitespace={showWhitespace}
      review={review}
      composingAnchor={composingAnchor}
      onToggleComposer={(anchor) => setComposingAnchor(toggleAnchor(composingAnchor, anchor))}
      onCloseComposer={() => setComposingAnchor(null)}
    />
  ) : (
    <UnifiedDiffTable
      hunk={hunk}
      path={path}
      showWhitespace={showWhitespace}
      review={review}
      composingAnchor={composingAnchor}
      onToggleComposer={(anchor) => setComposingAnchor(toggleAnchor(composingAnchor, anchor))}
      onCloseComposer={() => setComposingAnchor(null)}
    />
  );
}

export interface GitDiffRowsReview {
  readonly revision: GitReviewRevisionView;
  readonly notes: readonly GitReviewNoteView[];
  readonly actions: LineReviewActions;
}

interface ReviewRowState {
  readonly review: GitDiffRowsReview | undefined;
  readonly composingAnchor: string | null;
  readonly onToggleComposer: (anchor: GitReviewAnchorInput) => void;
  readonly onCloseComposer: () => void;
}

function UnifiedDiffTable({
  hunk,
  path,
  showWhitespace,
  review,
  composingAnchor,
  onToggleComposer,
  onCloseComposer,
}: {
  hunk: GitDiffHunkView;
  path: string;
  showWhitespace: boolean;
} & ReviewRowState) {
  return (
    <table className="git-unified-diff">
      <caption className="git-visually-hidden">Unified diff for {path}</caption>
      <tbody>
        {hunk.lines.map((line, index) => {
          const oldAnchor = makeAnchor(review?.revision, hunk.id, path, line, 'old');
          const newAnchor = makeAnchor(review?.revision, hunk.id, path, line, 'new');
          return (
            <Fragment key={`${index}-${line.oldLine}-${line.newLine}`}>
              <tr className={line.kind}>
                <ReviewLineNumber
                  label="Old line"
                  line={line.oldLine}
                  anchor={oldAnchor}
                  notes={review?.notes ?? []}
                  onToggleComposer={onToggleComposer}
                />
                <ReviewLineNumber
                  label="New line"
                  line={line.newLine}
                  anchor={newAnchor}
                  notes={review?.notes ?? []}
                  onToggleComposer={onToggleComposer}
                />
                <td aria-hidden="true">{linePrefix(line)}</td>
                <td>
                  <DiffCode line={line} showWhitespace={showWhitespace} />
                </td>
              </tr>
              {review &&
                [oldAnchor, newAnchor].map((anchor) =>
                  anchor === undefined ? null : (
                    <ReviewThreadRow
                      key={anchorKey(anchor)}
                      anchor={anchor}
                      review={review}
                      composing={composingAnchor === anchorKey(anchor)}
                      columnCount={4}
                      onCloseComposer={onCloseComposer}
                    />
                  ),
                )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function SplitDiffTable({
  hunk,
  path,
  showWhitespace,
  review,
  composingAnchor,
  onToggleComposer,
  onCloseComposer,
}: {
  hunk: GitDiffHunkView;
  path: string;
  showWhitespace: boolean;
} & ReviewRowState) {
  return (
    <table className="git-split-diff">
      <caption className="git-visually-hidden">Split diff for {path}</caption>
      <tbody>
        {buildSplitRows(hunk.lines).map((row, index) => {
          const oldAnchor = makeAnchor(review?.revision, hunk.id, path, row.oldLine, 'old');
          const newAnchor = makeAnchor(review?.revision, hunk.id, path, row.newLine, 'new');
          return (
            <Fragment key={`${index}-${row.oldLine?.oldLine}-${row.newLine?.newLine}`}>
              <tr>
                <SplitDiffCell
                  line={row.oldLine}
                  side="old"
                  showWhitespace={showWhitespace}
                  anchor={oldAnchor}
                  notes={review?.notes ?? []}
                  onToggleComposer={onToggleComposer}
                />
                <SplitDiffCell
                  line={row.newLine}
                  side="new"
                  showWhitespace={showWhitespace}
                  anchor={newAnchor}
                  notes={review?.notes ?? []}
                  onToggleComposer={onToggleComposer}
                />
              </tr>
              {review &&
                [oldAnchor, newAnchor].map((anchor) =>
                  anchor === undefined ? null : (
                    <ReviewThreadRow
                      key={anchorKey(anchor)}
                      anchor={anchor}
                      review={review}
                      composing={composingAnchor === anchorKey(anchor)}
                      columnCount={4}
                      onCloseComposer={onCloseComposer}
                    />
                  ),
                )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function SplitDiffCell({
  line,
  side,
  showWhitespace,
  anchor,
  notes,
  onToggleComposer,
}: {
  line: GitDiffLineView | null;
  side: 'old' | 'new';
  showWhitespace: boolean;
  anchor: GitReviewAnchorInput | undefined;
  notes: readonly GitReviewNoteView[];
  onToggleComposer: (anchor: GitReviewAnchorInput) => void;
}) {
  if (line === null) {
    return (
      <>
        <td
          className={`git-split-line-number ${side} empty`}
          aria-label={side === 'old' ? 'Old line' : 'New line'}
        />
        <td className={`git-split-content ${side} empty`} />
      </>
    );
  }
  const lineNumber = side === 'old' ? line.oldLine : line.newLine;
  return (
    <>
      <td
        className={`git-split-line-number ${side} ${line.kind}`}
        aria-label={side === 'old' ? 'Old line' : 'New line'}
      >
        <LineNumberButton
          label={side === 'old' ? 'old' : 'new'}
          line={lineNumber}
          anchor={anchor}
          notes={notes}
          onToggleComposer={onToggleComposer}
        />
      </td>
      <td className={`git-split-content ${side} ${line.kind}`}>
        <span aria-hidden="true">{linePrefix(line)}</span>
        <DiffCode line={line} showWhitespace={showWhitespace} />
      </td>
    </>
  );
}

function ReviewLineNumber({
  label,
  line,
  anchor,
  notes,
  onToggleComposer,
}: {
  label: string;
  line: number | null;
  anchor: GitReviewAnchorInput | undefined;
  notes: readonly GitReviewNoteView[];
  onToggleComposer: (anchor: GitReviewAnchorInput) => void;
}) {
  return (
    <td aria-label={label}>
      <LineNumberButton
        label={label.toLowerCase().startsWith('old') ? 'old' : 'new'}
        line={line}
        anchor={anchor}
        notes={notes}
        onToggleComposer={onToggleComposer}
      />
    </td>
  );
}

function LineNumberButton({
  label,
  line,
  anchor,
  notes,
  onToggleComposer,
}: {
  label: 'old' | 'new';
  line: number | null;
  anchor: GitReviewAnchorInput | undefined;
  notes: readonly GitReviewNoteView[];
  onToggleComposer: (anchor: GitReviewAnchorInput) => void;
}) {
  if (line === null || anchor === undefined) return line ?? '';
  const count = notesForAnchor(notes, anchor).length;
  return (
    <button
      className={`git-line-comment-button ${count > 0 ? 'has-notes' : ''}`}
      type="button"
      aria-label={`Comment on ${label} line ${line}${count > 0 ? `, ${count} existing` : ''}`}
      onClick={() => onToggleComposer(anchor)}
    >
      {line}
    </button>
  );
}

function ReviewThreadRow({
  anchor,
  review,
  composing,
  columnCount,
  onCloseComposer,
}: {
  anchor: GitReviewAnchorInput;
  review: GitDiffRowsReview;
  composing: boolean;
  columnCount: number;
  onCloseComposer: () => void;
}) {
  const notes = notesForAnchor(review.notes, anchor);
  return notes.length === 0 && !composing ? null : (
    <GitReviewThreadTableRow
      anchor={anchor}
      notes={notes}
      composing={composing}
      actions={review.actions}
      columnCount={columnCount}
      onCloseComposer={onCloseComposer}
    />
  );
}

function makeAnchor(
  revision: GitReviewRevisionView | undefined,
  hunkId: string,
  path: string,
  line: GitDiffLineView | null,
  side: 'old' | 'new',
): GitReviewAnchorInput | undefined {
  const lineNumber = side === 'old' ? line?.oldLine : line?.newLine;
  if (revision === undefined || lineNumber === null || lineNumber === undefined) return undefined;
  return {
    area: revision.area,
    revisionId: revision.revisionId,
    path,
    hunkId,
    side,
    line: lineNumber,
  };
}

function notesForAnchor(
  notes: readonly GitReviewNoteView[],
  anchor: GitReviewAnchorInput,
): GitReviewNoteView[] {
  return notes.filter(
    (note) =>
      note.anchorState === 'current' &&
      note.anchor.revisionId === anchor.revisionId &&
      note.anchor.path === anchor.path &&
      note.anchor.hunkId === anchor.hunkId &&
      note.anchor.side === anchor.side &&
      note.anchor.line === anchor.line,
  );
}

function anchorKey(anchor: GitReviewAnchorInput): string {
  return `${anchor.area}:${anchor.revisionId}:${anchor.path}:${anchor.hunkId}:${anchor.side}:${anchor.line}`;
}

function toggleAnchor(current: string | null, anchor: GitReviewAnchorInput): string | null {
  const next = anchorKey(anchor);
  return current === next ? null : next;
}

function DiffCode({ line, showWhitespace }: { line: GitDiffLineView; showWhitespace: boolean }) {
  const content = showWhitespace ? visibleWhitespace(line.content) : line.content;
  return (
    <code aria-label={showWhitespace ? line.content || 'Empty line' : undefined}>
      {content || ' '}
    </code>
  );
}

function linePrefix(line: GitDiffLineView): string {
  if (line.kind === 'addition') return '+';
  if (line.kind === 'deletion') return '−';
  return ' ';
}

function visibleWhitespace(content: string): string {
  return content.replaceAll(' ', '·').replaceAll('\t', '→\t');
}

export function buildSplitRows(lines: readonly GitDiffLineView[]): readonly SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.kind !== 'addition' && line.kind !== 'deletion') {
      rows.push({ oldLine: line, newLine: line });
      index += 1;
      continue;
    }

    const deletions: GitDiffLineView[] = [];
    const additions: GitDiffLineView[] = [];
    while (index < lines.length) {
      const change = lines[index];
      if (change?.kind === 'deletion') deletions.push(change);
      else if (change?.kind === 'addition') additions.push(change);
      else break;
      index += 1;
    }
    const rowCount = Math.max(deletions.length, additions.length);
    for (let changeIndex = 0; changeIndex < rowCount; changeIndex += 1) {
      rows.push({
        oldLine: deletions[changeIndex] ?? null,
        newLine: additions[changeIndex] ?? null,
      });
    }
  }
  return rows;
}
