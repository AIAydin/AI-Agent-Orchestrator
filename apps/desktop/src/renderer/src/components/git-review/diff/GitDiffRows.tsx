import type { GitDiffHunkView, GitDiffLineView } from '../../../../../shared/git/contracts.js';

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
}: {
  hunk: GitDiffHunkView;
  path: string;
  viewMode: GitDiffViewMode;
  showWhitespace: boolean;
}) {
  return viewMode === 'split' ? (
    <SplitDiffTable hunk={hunk} path={path} showWhitespace={showWhitespace} />
  ) : (
    <UnifiedDiffTable hunk={hunk} path={path} showWhitespace={showWhitespace} />
  );
}

function UnifiedDiffTable({
  hunk,
  path,
  showWhitespace,
}: {
  hunk: GitDiffHunkView;
  path: string;
  showWhitespace: boolean;
}) {
  return (
    <table className="git-unified-diff">
      <caption className="git-visually-hidden">Unified diff for {path}</caption>
      <tbody>
        {hunk.lines.map((line, index) => (
          <tr className={line.kind} key={`${index}-${line.oldLine}-${line.newLine}`}>
            <td aria-label="Old line">{line.oldLine ?? ''}</td>
            <td aria-label="New line">{line.newLine ?? ''}</td>
            <td aria-hidden="true">{linePrefix(line)}</td>
            <td>
              <DiffCode line={line} showWhitespace={showWhitespace} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SplitDiffTable({
  hunk,
  path,
  showWhitespace,
}: {
  hunk: GitDiffHunkView;
  path: string;
  showWhitespace: boolean;
}) {
  return (
    <table className="git-split-diff">
      <caption className="git-visually-hidden">Split diff for {path}</caption>
      <tbody>
        {buildSplitRows(hunk.lines).map((row, index) => (
          <tr key={`${index}-${row.oldLine?.oldLine}-${row.newLine?.newLine}`}>
            <SplitDiffCell line={row.oldLine} side="old" showWhitespace={showWhitespace} />
            <SplitDiffCell line={row.newLine} side="new" showWhitespace={showWhitespace} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SplitDiffCell({
  line,
  side,
  showWhitespace,
}: {
  line: GitDiffLineView | null;
  side: 'old' | 'new';
  showWhitespace: boolean;
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
        {lineNumber ?? ''}
      </td>
      <td className={`git-split-content ${side} ${line.kind}`}>
        <span aria-hidden="true">{linePrefix(line)}</span>
        <DiffCode line={line} showWhitespace={showWhitespace} />
      </td>
    </>
  );
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
