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
    <div className="git-diff-toolbar" role="group" aria-label="Change display options">
      <div role="group" aria-label="Layout">
        <button
          type="button"
          aria-pressed={viewMode === 'unified'}
          onClick={() => onViewModeChange('unified')}
        >
          One column
        </button>
        <button
          type="button"
          aria-pressed={viewMode === 'split'}
          onClick={() => onViewModeChange('split')}
        >
          Side by side
        </button>
      </div>
      <label>
        <input
          type="checkbox"
          name="git-diff-show-whitespace"
          aria-label="Show spaces and tabs"
          checked={showWhitespace}
          onChange={(event) => onShowWhitespaceChange(event.currentTarget.checked)}
        />
        Show spaces and tabs
      </label>
    </div>
  );
}
