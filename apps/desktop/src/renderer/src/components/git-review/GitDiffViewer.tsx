import { FileQuestion, Minus, Plus, RotateCcw } from 'lucide-react';

import type { GitDiffHunkView, GitDiffLineView } from '../../../../shared/git-contracts.js';
import type { GitDiffDisplayArea, GitDiffDisplayFile } from './git-review-model.js';

interface GitDiffViewerProps {
  file: GitDiffDisplayFile | null;
  busy: boolean;
  readOnly?: boolean;
  onStageHunk: (hunkId: string) => void;
  onUnstageHunk: (hunkId: string) => void;
  onPrepareDiscard: (hunkId: string) => void;
}

function linePrefix(line: GitDiffLineView): string {
  if (line.kind === 'addition') return '+';
  if (line.kind === 'deletion') return '−';
  return ' ';
}

export function GitDiffViewer({
  file,
  busy,
  readOnly = false,
  onStageHunk,
  onUnstageHunk,
  onPrepareDiscard,
}: GitDiffViewerProps) {
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
  return (
    <section className="git-diff-viewer" aria-label={`Diff for ${file.path}`}>
      <header>
        <span>
          <strong>{file.path}</strong>
          {diff?.oldPath !== null && diff?.oldPath !== undefined && diff.oldPath !== file.path && (
            <small>renamed from {diff.oldPath}</small>
          )}
        </span>
        {diff && (
          <span className="git-diff-totals">
            <b>+{diff.hunks.reduce(countAdditions, 0)}</b>
            <i>−{diff.hunks.reduce(countDeletions, 0)}</i>
          </span>
        )}
      </header>
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
  onStage,
  onUnstage,
  onDiscard,
}: {
  hunk: GitDiffHunkView;
  area: GitDiffDisplayArea;
  path: string;
  busy: boolean;
  readOnly: boolean;
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
      <table>
        <caption className="git-visually-hidden">Unified diff for {path}</caption>
        <tbody>
          {hunk.lines.map((line, index) => (
            <tr className={line.kind} key={`${index}-${line.oldLine}-${line.newLine}`}>
              <td aria-label="Old line">{line.oldLine ?? ''}</td>
              <td aria-label="New line">{line.newLine ?? ''}</td>
              <td aria-hidden="true">{linePrefix(line)}</td>
              <td>
                <code>{line.content || ' '}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

function GitDiffNotice({ children }: { children: string }) {
  return <p className="git-diff-notice">{children}</p>;
}

function countAdditions(total: number, hunk: GitDiffHunkView): number {
  return total + hunk.lines.filter((line) => line.kind === 'addition').length;
}

function countDeletions(total: number, hunk: GitDiffHunkView): number {
  return total + hunk.lines.filter((line) => line.kind === 'deletion').length;
}
