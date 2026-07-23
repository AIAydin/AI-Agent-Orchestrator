import { useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react';

import type { FileTreeEntry } from '../../../../../shared/files/contracts.js';
import {
  parentDirectory,
  policyLabel,
  QUICK_OPEN_VISIBLE_RESULTS,
  visibleTreeEntries,
} from '../../file-editor/browser/tree-model.js';
import {
  useProjectFileBrowser,
  type ProjectFileBrowserOperations,
} from '../../file-editor/browser/useProjectFileBrowser.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { WorkspaceTooltip } from '../shell/tooltips/WorkspaceTooltip.js';
import { writeWorkspaceContextDrag, type WorkspaceContextDragPayload } from './contracts.js';
import './WorkspaceProjectTree.css';

interface WorkspaceProjectTreeProps {
  readonly projectId: string;
  readonly operations: ProjectFileBrowserOperations;
  readonly agentTargets?: readonly WorkshopNode[];
  readonly readOnly?: boolean;
  readonly onAttach?: (targetNodeId: string, payload: WorkspaceContextDragPayload) => Promise<void>;
}

interface ProjectTreeRow {
  readonly entry: FileTreeEntry;
  readonly depth: number;
}

export function WorkspaceProjectTree({
  projectId,
  operations,
  agentTargets = [],
  readOnly = false,
  onAttach,
}: WorkspaceProjectTreeProps) {
  const browser = useProjectFileBrowser(projectId, operations);
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [query, setQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<FileTreeEntry | null>(null);
  const [targetNodeId, setTargetNodeId] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [attachMessage, setAttachMessage] = useState<string | null>(null);
  const agents = useMemo(
    () => agentTargets.filter((node) => node.data.kind === 'agent' && !node.data.locked),
    [agentTargets],
  );
  const searching = query.trim() !== '';
  const rows = useMemo<readonly ProjectTreeRow[]>(
    () =>
      searching
        ? visibleTreeEntries(browser.entries, '.', query)
            .slice(0, QUICK_OPEN_VISIBLE_RESULTS)
            .map((entry) => ({ entry, depth: 0 }))
        : projectTreeRows(browser.entries, expandedDirectories).slice(
            0,
            QUICK_OPEN_VISIBLE_RESULTS,
          ),
    [browser.entries, expandedDirectories, query, searching],
  );
  useEffect(() => {
    if (!agents.some((agent) => agent.id === targetNodeId)) setTargetNodeId(agents[0]?.id ?? '');
  }, [agents, targetNodeId]);

  const toggleDirectory = (relativePath: string) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(relativePath)) next.delete(relativePath);
      else next.add(relativePath);
      return next;
    });
  };
  const revealDirectory = (relativePath: string) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      let directory = relativePath;
      while (directory !== '.') {
        next.add(directory);
        directory = parentDirectory(directory);
      }
      return next;
    });
    setQuery('');
  };

  return (
    <section className="workspace-project-tree" aria-label="Project file tree">
      <header>
        <div>
          <strong>Project files</strong>
          <span title="Share files with an agent by dragging or selecting.">
            Share files with an agent by dragging or selecting.
          </span>
        </div>
        <button type="button" aria-label="Refresh project files" onClick={browser.refresh}>
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </header>
      <label className="workspace-project-tree-search">
        <Search size={12} aria-hidden="true" />
        <span className="sr-only">Search project files</span>
        <input
          name="workspace-project-file-search"
          value={query}
          aria-label="Search project files"
          placeholder="Find a project file"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {browser.status === 'error' ? (
        <div className="workspace-project-tree-error" role="alert">
          <ShieldAlert size={13} aria-hidden="true" />
          <span>{browser.error}</span>
        </div>
      ) : null}
      <div className="workspace-project-tree-list" role="tree" aria-label="Project files">
        {rows.map(({ entry, depth }) => (
          <ProjectTreeEntry
            key={entry.relativePath}
            projectId={projectId}
            entry={entry}
            depth={depth}
            searching={searching}
            expanded={expandedDirectories.has(entry.relativePath)}
            selected={selectedFile?.relativePath === entry.relativePath}
            onSelectFile={setSelectedFile}
            onToggleDirectory={searching ? revealDirectory : toggleDirectory}
          />
        ))}
        {rows.length === 0 ? (
          <p>
            {browser.status === 'loading'
              ? 'Loading project files…'
              : 'No files match your search.'}
          </p>
        ) : null}
      </div>
      {selectedFile !== null && onAttach !== undefined ? (
        <div
          className="workspace-project-tree-attach"
          aria-label="Attach the selected file to an agent"
        >
          {agents.length === 0 ? (
            <p>Add and unlock an agent on the canvas to attach files.</p>
          ) : (
            <>
              <label>
                Attach to agent
                <select
                  name="workspace-project-tree-agent-context-target"
                  value={targetNodeId}
                  disabled={readOnly || attaching}
                  onChange={(event) => setTargetNodeId(event.target.value)}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.data.title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={readOnly || attaching || targetNodeId.length === 0}
                onClick={() => {
                  if (targetNodeId.length === 0) return;
                  setAttaching(true);
                  setAttachMessage(null);
                  void onAttach(targetNodeId, {
                    schemaVersion: 1,
                    kind: 'project-file',
                    projectId,
                    relativePath: selectedFile.relativePath,
                  })
                    .then(() => setAttachMessage('Attached — this agent can now use the file.'))
                    .catch((cause: unknown) =>
                      setAttachMessage(
                        cause instanceof Error
                          ? cause.message
                          : "The selected file couldn't be attached. Try again.",
                      ),
                    )
                    .finally(() => setAttaching(false));
                }}
              >
                {attaching ? 'Checking…' : 'Attach selected file'}
              </button>
            </>
          )}
          {attachMessage !== null ? (
            <p role={attachMessage.startsWith('Attached') ? 'status' : 'alert'}>{attachMessage}</p>
          ) : null}
        </div>
      ) : null}
      <footer role="status">
        <span>{browser.entries.length} items</span>
        {browser.bounded ? <span>Not all files shown</span> : null}
      </footer>
    </section>
  );
}

/** Depth-first rows of every entry whose ancestor directories are all expanded. */
function projectTreeRows(
  entries: readonly FileTreeEntry[],
  expanded: ReadonlySet<string>,
): ProjectTreeRow[] {
  const children = new Map<string, FileTreeEntry[]>();
  for (const entry of entries) {
    const parent = parentDirectory(entry.relativePath);
    const group = children.get(parent);
    if (group === undefined) children.set(parent, [entry]);
    else group.push(entry);
  }
  for (const group of children.values()) group.sort(compareSiblings);
  const rows: ProjectTreeRow[] = [];
  const visit = (directory: string, depth: number) => {
    for (const entry of children.get(directory) ?? []) {
      rows.push({ entry, depth });
      if (entry.kind === 'directory' && expanded.has(entry.relativePath)) {
        visit(entry.relativePath, depth + 1);
      }
    }
  };
  visit('.', 0);
  return rows;
}

function compareSiblings(left: FileTreeEntry, right: FileTreeEntry): number {
  const leftRank = left.kind === 'directory' ? 0 : 1;
  const rightRank = right.kind === 'directory' ? 0 : 1;
  return leftRank - rightRank || left.name.localeCompare(right.name);
}

function ProjectTreeEntry({
  projectId,
  entry,
  depth,
  searching,
  expanded,
  selected,
  onSelectFile,
  onToggleDirectory,
}: {
  readonly projectId: string;
  readonly entry: FileTreeEntry;
  readonly depth: number;
  readonly searching: boolean;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly onSelectFile: (entry: FileTreeEntry) => void;
  readonly onToggleDirectory: (relativePath: string) => void;
}) {
  const safe = entry.canOpen && entry.policy.status === 'normal';
  const draggable = safe && entry.kind === 'file';
  const protectedPolicy = entry.policy.status !== 'normal';
  const label = searching ? entry.relativePath : entry.name;
  const indent = { paddingInlineStart: 4 + depth * 12 };
  if (entry.kind === 'directory') {
    if (!safe) {
      return (
        <WorkspaceTooltip content={entry.policy.reason ?? policyLabel(entry)}>
          <div
            role="treeitem"
            className="workspace-project-tree-row"
            style={indent}
            aria-level={depth + 1}
            aria-disabled="true"
            aria-label={`Folder ${entry.relativePath} (${policyLabel(entry)})`}
          >
            <span className="workspace-project-tree-gutter" aria-hidden="true" />
            <Folder size={13} aria-hidden="true" />
            <span>{label}</span>
            <ShieldAlert size={12} aria-hidden="true" />
          </div>
        </WorkspaceTooltip>
      );
    }
    const open = !searching && expanded;
    return (
      <button
        type="button"
        role="treeitem"
        className="workspace-project-tree-row"
        style={indent}
        title={entry.relativePath}
        aria-level={depth + 1}
        {...(searching ? {} : { 'aria-expanded': open })}
        aria-label={`${open ? 'Collapse' : 'Expand'} folder ${entry.relativePath}`}
        onClick={() => onToggleDirectory(entry.relativePath)}
        onKeyDown={(event) => {
          if (searching) return;
          if ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open)) {
            event.preventDefault();
            onToggleDirectory(entry.relativePath);
          }
        }}
      >
        {searching ? (
          <span className="workspace-project-tree-gutter" aria-hidden="true" />
        ) : (
          <ChevronRight
            size={13}
            aria-hidden="true"
            className={`workspace-project-tree-chevron${open ? ' open' : ''}`}
          />
        )}
        {open ? (
          <FolderOpen size={13} aria-hidden="true" />
        ) : (
          <Folder size={13} aria-hidden="true" />
        )}
        <span>{label}</span>
      </button>
    );
  }
  const guidance = draggable
    ? `Drag ${entry.relativePath} onto an agent to share it`
    : (entry.policy.reason ?? "This file can't be attached.");
  return (
    <WorkspaceTooltip content={guidance}>
      <button
        type="button"
        role="treeitem"
        className="workspace-project-tree-row"
        style={indent}
        disabled={!draggable}
        draggable={draggable}
        aria-level={depth + 1}
        aria-label={
          draggable
            ? `File ${entry.relativePath}`
            : `Protected file ${entry.relativePath}${protectedPolicy ? ` (${policyLabel(entry)})` : ''}`
        }
        aria-disabled={!draggable}
        aria-selected={selected}
        onDragStart={(event) => {
          if (!draggable) {
            event.preventDefault();
            return;
          }
          writeWorkspaceContextDrag(event.dataTransfer, {
            schemaVersion: 1,
            kind: 'project-file',
            projectId,
            relativePath: entry.relativePath,
          });
        }}
        onClick={() => onSelectFile(entry)}
      >
        <span className="workspace-project-tree-gutter" aria-hidden="true" />
        <File size={13} aria-hidden="true" />
        <span>{label}</span>
        {draggable ? null : <ShieldAlert size={12} aria-hidden="true" />}
      </button>
    </WorkspaceTooltip>
  );
}
