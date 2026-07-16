import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, File, Folder, RefreshCw, Search, ShieldAlert } from 'lucide-react';

import {
  FileDocumentSchema,
  FileDomainErrorCodeSchema,
  type FileDocument,
  type FileTreeEntry,
} from '../../../../../shared/files/contracts.js';
import {
  fileBrowserBreadcrumbs,
  policyLabel,
  QUICK_OPEN_VISIBLE_RESULTS,
  visibleTreeEntries,
} from './tree-model.js';
import {
  fileBrowserError,
  useProjectFileBrowser,
  type ProjectFileBrowserOperations,
} from './useProjectFileBrowser.js';
import './ProjectFileBrowser.css';

export interface ProjectFileSelection {
  readonly projectId: string;
  readonly relativePath: string;
  readonly document: FileDocument;
}

export interface ProjectFileBrowserProps {
  readonly projectId: string;
  readonly operations: ProjectFileBrowserOperations;
  readonly selectedRelativePath?: string;
  readonly assignmentDisabled?: boolean;
  readonly onSelect: (selection: ProjectFileSelection) => void;
  readonly onCancel?: () => void;
}

type CandidateStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error';

export function ProjectFileBrowser({
  projectId,
  operations,
  selectedRelativePath,
  assignmentDisabled = false,
  onSelect,
  onCancel,
}: ProjectFileBrowserProps) {
  const browser = useProjectFileBrowser(projectId, operations);
  const [currentDirectory, setCurrentDirectory] = useState('.');
  const [query, setQuery] = useState('');
  const [candidate, setCandidate] = useState<FileTreeEntry | null>(null);
  const [candidateDocument, setCandidateDocument] = useState<FileDocument | null>(null);
  const [candidateStatus, setCandidateStatus] = useState<CandidateStatus>('idle');
  const [candidateMessage, setCandidateMessage] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    setCurrentDirectory('.');
    setQuery('');
    setCandidate(null);
    setCandidateDocument(null);
    setCandidateStatus('idle');
    setCandidateMessage(null);
    return () => {
      requestVersionRef.current += 1;
    };
  }, [projectId]);

  const matches = useMemo(
    () => visibleTreeEntries(browser.entries, currentDirectory, query),
    [browser.entries, currentDirectory, query],
  );
  const shownEntries = matches.slice(0, QUICK_OPEN_VISIBLE_RESULTS);
  const breadcrumbs = fileBrowserBreadcrumbs(currentDirectory);

  const refreshBrowser = (): void => {
    requestVersionRef.current += 1;
    setCandidate(null);
    setCandidateDocument(null);
    setCandidateStatus('idle');
    setCandidateMessage(null);
    browser.refresh();
  };

  const inspectEntry = async (entry: FileTreeEntry): Promise<void> => {
    if (entry.kind === 'directory' && entry.canOpen) {
      requestVersionRef.current += 1;
      setCurrentDirectory(entry.relativePath);
      setQuery('');
      setCandidate(null);
      setCandidateDocument(null);
      setCandidateStatus('idle');
      setCandidateMessage(null);
      return;
    }
    if (entry.kind !== 'file' || !entry.canOpen || entry.policy.status !== 'normal') return;

    const requestVersion = ++requestVersionRef.current;
    setCandidate(entry);
    setCandidateDocument(null);
    setCandidateStatus('loading');
    setCandidateMessage(null);
    try {
      const document = FileDocumentSchema.parse(
        await operations.read({ projectId, relativePath: entry.relativePath }),
      );
      if (document.projectId !== projectId || document.relativePath !== entry.relativePath) {
        throw new Error('The file read returned data for a different project location.');
      }
      if (requestVersionRef.current !== requestVersion) return;
      setCandidateDocument(document);
      setCandidateStatus('ready');
    } catch (cause) {
      if (requestVersionRef.current !== requestVersion) return;
      const parsedCode = FileDomainErrorCodeSchema.safeParse(
        (cause as { code?: unknown } | null)?.code,
      );
      setCandidateStatus(
        parsedCode.success && parsedCode.data === 'FILE_NOT_FOUND' ? 'missing' : 'error',
      );
      setCandidateMessage(
        fileBrowserError(cause, 'Forgeboard could not safely inspect this file.'),
      );
    }
  };

  const firstQuickOpenFile = shownEntries.find(
    (entry) => entry.kind === 'file' && entry.canOpen && entry.policy.status === 'normal',
  );

  return (
    <section className="project-file-browser" aria-label="Project file browser">
      <header className="project-file-browser-header">
        <div>
          <strong>Project files</strong>
          <span>Project-relative paths only</span>
        </div>
        <div className="project-file-browser-header-actions">
          {onCancel !== undefined ? (
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          <button type="button" onClick={refreshBrowser} aria-label="Refresh project files">
            <RefreshCw size={13} />
          </button>
        </div>
      </header>

      <label className="project-file-search">
        <Search size={13} aria-hidden="true" />
        <span className="sr-only">Quick open project file</span>
        <input
          name="project-file-quick-open"
          value={query}
          placeholder="Quick open by project-relative path…"
          aria-label="Quick open project file"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || firstQuickOpenFile === undefined) return;
            event.preventDefault();
            void inspectEntry(firstQuickOpenFile);
          }}
        />
      </label>

      <nav className="project-file-breadcrumbs" aria-label="Project file directory">
        {breadcrumbs.map((breadcrumb, index) => (
          <span key={breadcrumb.directory}>
            {index > 0 ? <ChevronRight size={11} aria-hidden="true" /> : null}
            <button
              type="button"
              disabled={breadcrumb.directory === currentDirectory}
              onClick={() => {
                requestVersionRef.current += 1;
                setCurrentDirectory(breadcrumb.directory);
                setQuery('');
                setCandidate(null);
                setCandidateDocument(null);
                setCandidateStatus('idle');
                setCandidateMessage(null);
              }}
            >
              {breadcrumb.label}
            </button>
          </span>
        ))}
      </nav>

      <div className="project-file-browser-summary" role="status">
        <span>
          {query.trim() === '' ? `${matches.length} entries` : `${matches.length} matches`}
          {matches.length > shownEntries.length ? ` · showing ${shownEntries.length}` : ''}
        </span>
        {browser.status === 'loading' ? <span>Indexing safe entries…</span> : null}
        {browser.bounded ? <span>Bounded results</span> : null}
      </div>

      {browser.status === 'error' ? (
        <div className="project-file-browser-error" role="alert">
          <ShieldAlert size={14} />
          <span>{browser.error}</span>
          <button type="button" onClick={refreshBrowser}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="project-file-list" role="list" aria-label="Project file results">
        {shownEntries.map((entry) => {
          const blocked = !entry.canOpen || entry.policy.status !== 'normal';
          const selected = candidate?.relativePath === entry.relativePath;
          const current = selectedRelativePath === entry.relativePath;
          return (
            <div
              className={`project-file-row${selected ? ' selected' : ''}${current ? ' current' : ''}`}
              role="listitem"
              key={entry.relativePath}
            >
              <button
                type="button"
                disabled={blocked || (entry.kind !== 'file' && entry.kind !== 'directory')}
                aria-label={`${entry.kind === 'directory' ? 'Open folder' : 'Inspect file'} ${entry.relativePath}`}
                onClick={() => void inspectEntry(entry)}
              >
                {entry.kind === 'directory' ? (
                  <Folder size={14} aria-hidden="true" />
                ) : (
                  <File size={14} aria-hidden="true" />
                )}
                <span>{query.trim() === '' ? entry.name : entry.relativePath}</span>
                <em className={`policy-${entry.policy.status}`}>{policyLabel(entry)}</em>
              </button>
              {entry.policy.reason !== null ? <small>{entry.policy.reason}</small> : null}
            </div>
          );
        })}
        {shownEntries.length === 0 && browser.status !== 'error' ? (
          <p className="project-file-empty">
            {browser.status === 'loading' ? 'Loading project files…' : 'No matching entries.'}
          </p>
        ) : null}
      </div>

      <CandidateDetails
        projectId={projectId}
        entry={candidate}
        document={candidateDocument}
        status={candidateStatus}
        message={candidateMessage}
        assignmentDisabled={assignmentDisabled}
        onSelect={onSelect}
      />
    </section>
  );
}

function CandidateDetails({
  projectId,
  entry,
  document,
  status,
  message,
  assignmentDisabled,
  onSelect,
}: {
  readonly projectId: string;
  readonly entry: FileTreeEntry | null;
  readonly document: FileDocument | null;
  readonly status: CandidateStatus;
  readonly message: string | null;
  readonly assignmentDisabled: boolean;
  readonly onSelect: (selection: ProjectFileSelection) => void;
}) {
  if (entry === null) return null;
  const contentLabel =
    document?.contentKind === 'binary'
      ? 'Binary file'
      : document?.contentKind === 'too-large'
        ? 'Oversized file'
        : document?.contentKind === 'text'
          ? 'UTF-8 text'
          : null;
  return (
    <section className="project-file-candidate" aria-label="Selected file details">
      <code>{entry.relativePath}</code>
      {status === 'loading' ? <p role="status">Inspecting file safely…</p> : null}
      {status === 'missing' ? (
        <p className="project-file-candidate-error" role="alert">
          Missing · {message}
        </p>
      ) : null}
      {status === 'error' ? (
        <p className="project-file-candidate-error" role="alert">
          Unavailable · {message}
        </p>
      ) : null}
      {status === 'ready' && document !== null ? (
        <>
          <div className="project-file-candidate-state" role="status">
            <strong>{contentLabel}</strong>
            <span>{document.readOnly ? 'Read-only' : 'Editable'}</span>
            <span>{formatBytes(document.sizeBytes)}</span>
          </div>
          {document.readOnlyReason !== null ? <p>{document.readOnlyReason}</p> : null}
          {assignmentDisabled ? <p>Unlock this node to change its file reference.</p> : null}
          <button
            type="button"
            className="button primary"
            disabled={assignmentDisabled}
            onClick={() => onSelect({ projectId, relativePath: entry.relativePath, document })}
          >
            {document.readOnly ? 'Use read-only reference' : 'Open in editor'}
          </button>
        </>
      ) : null}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
