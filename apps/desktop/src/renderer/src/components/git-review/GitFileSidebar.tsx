import { FileCode2, Minus, Plus } from 'lucide-react';

import type {
  GitFileSelection,
  GitReviewArea,
  GitReviewFile,
  GitReviewGroups,
} from './git-review-model.js';
import { selectionKey, statusLabel } from './git-review-model.js';

interface GitFileSidebarProps {
  groups: GitReviewGroups;
  selection: GitFileSelection | null;
  busy: boolean;
  onSelect: (selection: GitFileSelection) => void;
  onStagePath: (path: string) => void;
  onUnstagePath: (path: string) => void;
}

const groupLabels: Readonly<Record<GitReviewArea, string>> = {
  staged: 'Staged changes',
  unstaged: 'Unstaged changes',
  untracked: 'Untracked files',
};

export function GitFileSidebar({
  groups,
  selection,
  busy,
  onSelect,
  onStagePath,
  onUnstagePath,
}: GitFileSidebarProps) {
  return (
    <nav className="git-file-sidebar" aria-label="Changed files">
      {(['staged', 'unstaged', 'untracked'] as const).map((area) => (
        <GitFileGroup
          key={area}
          area={area}
          files={groups[area]}
          selection={selection}
          busy={busy}
          onSelect={onSelect}
          onStagePath={onStagePath}
          onUnstagePath={onUnstagePath}
        />
      ))}
    </nav>
  );
}

function GitFileGroup({
  area,
  files,
  selection,
  busy,
  onSelect,
  onStagePath,
  onUnstagePath,
}: Omit<GitFileSidebarProps, 'groups'> & {
  area: GitReviewArea;
  files: readonly GitReviewFile[];
}) {
  return (
    <section className="git-file-group" aria-labelledby={`git-${area}-heading`}>
      <header>
        <h3 id={`git-${area}-heading`}>{groupLabels[area]}</h3>
        <span>{files.length}</span>
      </header>
      {files.length === 0 ? (
        <p>None</p>
      ) : (
        <ul>
          {files.map((file) => {
            const active = selection !== null && selectionKey(selection) === selectionKey(file);
            const action = area === 'staged' ? 'Unstage' : 'Stage';
            return (
              <li key={selectionKey(file)}>
                <button
                  className={`git-file-select ${active ? 'active' : ''}`}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelect({ area, path: file.path })}
                >
                  <FileCode2 size={13} aria-hidden="true" />
                  <span>
                    <strong>{file.path}</strong>
                    <small>{statusLabel(file)}</small>
                  </span>
                </button>
                <button
                  className="git-file-action"
                  type="button"
                  disabled={busy}
                  aria-label={`${action} ${file.path}`}
                  title={`${action} whole file`}
                  onClick={() =>
                    area === 'staged' ? onUnstagePath(file.path) : onStagePath(file.path)
                  }
                >
                  {area === 'staged' ? (
                    <Minus size={13} aria-hidden="true" />
                  ) : (
                    <Plus size={13} aria-hidden="true" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
