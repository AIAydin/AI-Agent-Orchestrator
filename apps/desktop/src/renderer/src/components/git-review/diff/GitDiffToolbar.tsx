import type { GitDiffViewMode } from './GitDiffRows.js';

export function GitDiffToolbar({
  viewMode,
  showWhitespace,
  onViewModeChange,
  onShowWhitespaceChange,
}: {
  viewMode: GitDiffViewMode;
  showWhitespace: boolean;
  onViewModeChange: (viewMode: GitDiffViewMode) => void;
  onShowWhitespaceChange: (showWhitespace: boolean) => void;
}) {
  return (
    <div className="git-diff-toolbar" role="group" aria-label="Diff display controls">
      <div role="group" aria-label="Diff layout">
        <button
          type="button"
          aria-pressed={viewMode === 'unified'}
          onClick={() => onViewModeChange('unified')}
        >
          Unified
        </button>
        <button
          type="button"
          aria-pressed={viewMode === 'split'}
          onClick={() => onViewModeChange('split')}
        >
          Split
        </button>
      </div>
      <label>
        <input
          type="checkbox"
          name="git-diff-show-whitespace"
          aria-label="Show whitespace characters"
          checked={showWhitespace}
          onChange={(event) => onShowWhitespaceChange(event.currentTarget.checked)}
        />
        Show whitespace
      </label>
    </div>
  );
}
