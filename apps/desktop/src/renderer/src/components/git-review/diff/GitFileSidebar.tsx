import { FileCode2, Minus, Plus } from 'lucide-react';

import type {
  GitFileSelection,
  GitReviewArea,
  GitReviewFile,
  GitReviewGroups,
} from '../git-review-model.js';
import { fileDiffStats, selectionKey, statusLabel } from '../git-review-model.js';
import { WorkspaceTooltip } from '../../workspace/shell/tooltips/WorkspaceTooltip.js';
import { GitFilePageControls, useGitFilePage } from './GitFilePagination.js';

interface GitFileSidebarProps {
  groups: GitReviewGroups;
  selection: GitFileSelection | null;
  busy: boolean;
  onSelect: (selection: GitFileSelection) => void;
  onStagePath: (path: string) => void;
  onUnstagePath: (path: string) => void;
}

const groupLabels: Readonly<Record<GitReviewArea, string>> = {
  staged: 'Ready to commit',
  unstaged: 'Not ready to commit',
  untracked: 'New files',
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
  const selectedIndex =
    selection?.area === area ? files.findIndex((file) => file.path === selection.path) : -1;
  const page = useGitFilePage(files.length, selectedIndex);
  const visibleFiles = files.slice(page.start, page.end);

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
          {visibleFiles.map((file) => {
            const active = selection !== null && selectionKey(selection) === selectionKey(file);
            const action =
              area === 'staged'
                ? {
                    aria: `Remove ${file.path} from commit`,
                    title: 'Remove whole file from commit',
                  }
                : {
                    aria: `Add ${file.path} to commit`,
                    title: 'Add whole file to commit',
                  };
            const stats = fileDiffStats(file);
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
                    <strong title={file.path}>{file.path}</strong>
                    <small>
                      {statusLabel(file)}
                      {file.diff && ` · +${stats.additions} −${stats.deletions}`}
                    </small>
                  </span>
                </button>
                <WorkspaceTooltip
                  content={
                    busy ? `${action.title} after the current Git action finishes` : action.title
                  }
                >
                  <button
                    className="git-file-action"
                    type="button"
                    disabled={busy}
                    aria-label={action.aria}
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
                </WorkspaceTooltip>
              </li>
            );
          })}
        </ul>
      )}
      <GitFilePageControls label={groupLabels[area]} fileCount={files.length} page={page} />
    </section>
  );
}
