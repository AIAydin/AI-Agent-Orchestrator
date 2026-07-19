import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, File, Folder, RefreshCw, Search, ShieldAlert } from 'lucide-react';

import type { FileTreeEntry } from '../../../../../shared/files/contracts.js';
import {
  fileBrowserBreadcrumbs,
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

export function WorkspaceProjectTree({
  projectId,
  operations,
  agentTargets = [],
  readOnly = false,
  onAttach,
}: WorkspaceProjectTreeProps) {
  const browser = useProjectFileBrowser(projectId, operations);
  const [directory, setDirectory] = useState('.');
  const [query, setQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<FileTreeEntry | null>(null);
  const [targetNodeId, setTargetNodeId] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [attachMessage, setAttachMessage] = useState<string | null>(null);
  const agents = useMemo(
    () => agentTargets.filter((node) => node.data.kind === 'agent' && !node.data.locked),
    [agentTargets],
  );
  const entries = useMemo(
    () =>
      visibleTreeEntries(browser.entries, directory, query).slice(0, QUICK_OPEN_VISIBLE_RESULTS),
    [browser.entries, directory, query],
  );
  const breadcrumbs = fileBrowserBreadcrumbs(directory);
  useEffect(() => {
    if (!agents.some((agent) => agent.id === targetNodeId)) setTargetNodeId(agents[0]?.id ?? '');
  }, [agents, targetNodeId]);

  return (
    <section className="workspace-project-tree" aria-label="Project file tree">
      <header>
        <div>
          <strong>Project files</strong>
          <span>Drag or select files to share with an agent</span>
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
      <nav aria-label="Folder path">
        {breadcrumbs.map((breadcrumb, index) => (
          <span key={breadcrumb.directory}>
            {index > 0 ? <ChevronRight size={10} aria-hidden="true" /> : null}
            <button
              type="button"
              aria-label={`Go to folder ${breadcrumb.directory}`}
              disabled={breadcrumb.directory === directory}
              onClick={() => {
                setDirectory(breadcrumb.directory);
                setQuery('');
              }}
            >
              {breadcrumb.label}
            </button>
          </span>
        ))}
      </nav>
      {browser.status === 'error' ? (
        <div className="workspace-project-tree-error" role="alert">
          <ShieldAlert size={13} aria-hidden="true" />
          <span>{browser.error}</span>
        </div>
      ) : null}
      <div className="workspace-project-tree-list" role="tree" aria-label="Project files">
        {entries.map((entry) => (
          <ProjectTreeEntry
            key={entry.relativePath}
            projectId={projectId}
            entry={entry}
            searching={query.trim() !== ''}
            selected={selectedFile?.relativePath === entry.relativePath}
            onSelectFile={setSelectedFile}
            onOpenDirectory={(relativePath) => {
              setDirectory(relativePath);
              setQuery('');
            }}
          />
        ))}
        {entries.length === 0 ? (
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

function ProjectTreeEntry({
  projectId,
  entry,
  searching,
  selected,
  onSelectFile,
  onOpenDirectory,
}: {
  readonly projectId: string;
  readonly entry: FileTreeEntry;
  readonly searching: boolean;
  readonly selected: boolean;
  readonly onSelectFile: (entry: FileTreeEntry) => void;
  readonly onOpenDirectory: (relativePath: string) => void;
}) {
  const safe = entry.canOpen && entry.policy.status === 'normal';
  const draggable = safe && entry.kind === 'file';
  const label = searching ? entry.relativePath : entry.name;
  if (entry.kind === 'directory') {
    return (
      <button
        type="button"
        role="treeitem"
        disabled={!safe}
        aria-label={`Open folder ${entry.relativePath}`}
        onClick={() => onOpenDirectory(entry.relativePath)}
      >
        <Folder size={13} aria-hidden="true" />
        <span>{label}</span>
        <em>{policyLabel(entry)}</em>
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
        disabled={!draggable}
        draggable={draggable}
        aria-label={`${draggable ? 'File' : 'Protected file'} ${entry.relativePath}`}
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
        <File size={13} aria-hidden="true" />
        <span>{label}</span>
        <em>{policyLabel(entry)}</em>
      </button>
    </WorkspaceTooltip>
  );
}
