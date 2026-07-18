import { useRef, type KeyboardEvent } from 'react';

export type GitReviewMode = 'base-comparison' | 'working-tree';

export const GIT_BASE_TAB_ID = 'git-review-base-tab';
export const GIT_BASE_PANEL_ID = 'git-review-base-panel';
export const GIT_WORKING_TREE_TAB_ID = 'git-review-working-tree-tab';
export const GIT_WORKING_TREE_PANEL_ID = 'git-review-working-tree-panel';

const modes: readonly GitReviewMode[] = ['base-comparison', 'working-tree'];

export function GitReviewModeTabs({
  mode,
  onChange,
}: {
  mode: GitReviewMode;
  onChange: (mode: GitReviewMode) => void;
}) {
  const baseTab = useRef<HTMLButtonElement>(null);
  const workingTreeTab = useRef<HTMLButtonElement>(null);

  const selectFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, current: GitReviewMode) => {
    const currentIndex = modes.indexOf(current);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? modes.length - 1
          : event.key === 'ArrowRight'
            ? (currentIndex + 1) % modes.length
            : event.key === 'ArrowLeft'
              ? (currentIndex - 1 + modes.length) % modes.length
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextMode = modes[nextIndex]!;
    onChange(nextMode);
    (nextMode === 'base-comparison' ? baseTab : workingTreeTab).current?.focus();
  };

  return (
    <div className="git-review-mode-tabs" role="tablist" aria-label="Agent review views">
      <button
        ref={baseTab}
        id={GIT_BASE_TAB_ID}
        type="button"
        role="tab"
        aria-controls={GIT_BASE_PANEL_ID}
        aria-selected={mode === 'base-comparison'}
        tabIndex={mode === 'base-comparison' ? 0 : -1}
        onClick={() => onChange('base-comparison')}
        onKeyDown={(event) => selectFromKeyboard(event, 'base-comparison')}
      >
        Committed changes
      </button>
      <button
        ref={workingTreeTab}
        id={GIT_WORKING_TREE_TAB_ID}
        type="button"
        role="tab"
        aria-controls={GIT_WORKING_TREE_PANEL_ID}
        aria-selected={mode === 'working-tree'}
        tabIndex={mode === 'working-tree' ? 0 : -1}
        onClick={() => onChange('working-tree')}
        onKeyDown={(event) => selectFromKeyboard(event, 'working-tree')}
      >
        Uncommitted changes
      </button>
    </div>
  );
}
