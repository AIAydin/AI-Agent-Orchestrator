import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';

import {
  FileDocumentSchema,
  FileSearchResultSchema,
  type FileDocument,
  type FileReadInput,
  type FileSearchInput,
  type FileSearchMatch,
  type FileSearchResult,
} from '../../../../../shared/files/contracts.js';
import { fileBrowserError } from '../browser/useProjectFileBrowser.js';
import './ProjectContentSearch.css';

export interface ProjectContentSearchOperations {
  readonly search: (input: FileSearchInput) => Promise<FileSearchResult>;
  readonly read: (input: FileReadInput) => Promise<FileDocument>;
}

export interface ProjectContentSearchSelection {
  readonly projectId: string;
  readonly relativePath: string;
  readonly document: FileDocument;
  readonly line: number;
  readonly column: number;
}

export function ProjectContentSearch({
  projectId,
  operations,
  onOpen,
}: {
  readonly projectId: string;
  readonly operations: ProjectContentSearchOperations;
  readonly onOpen: (selection: ProjectContentSearchSelection) => void;
}) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<FileSearchResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'searching' | 'opening' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    requestVersionRef.current += 1;
    setQuery('');
    setResult(null);
    setStatus('idle');
    setMessage(null);
  }, [projectId]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const normalized = query.trim();
    if (normalized.length < 2) return;
    const requestVersion = ++requestVersionRef.current;
    setStatus('searching');
    setMessage(null);
    try {
      const candidate = FileSearchResultSchema.parse(
        await operations.search({ projectId, query: normalized }),
      );
      if (candidate.projectId !== projectId || candidate.query !== normalized) {
        throw new Error('The file search returned data for a different project or query.');
      }
      if (requestVersionRef.current !== requestVersion) return;
      setResult(candidate);
      setStatus('idle');
    } catch (cause) {
      if (requestVersionRef.current !== requestVersion) return;
      setStatus('error');
      setMessage(fileBrowserError(cause, "Artemis couldn't search this project. Try again."));
    }
  };

  const openMatch = async (match: FileSearchMatch): Promise<void> => {
    const requestVersion = ++requestVersionRef.current;
    setStatus('opening');
    setMessage(null);
    try {
      const document = FileDocumentSchema.parse(
        await operations.read({ projectId, relativePath: match.relativePath }),
      );
      if (document.projectId !== projectId || document.relativePath !== match.relativePath) {
        throw new Error('The selected search match resolved to a different project file.');
      }
      if (requestVersionRef.current !== requestVersion) return;
      setStatus('idle');
      onOpen({
        projectId,
        relativePath: match.relativePath,
        document,
        line: match.line,
        column: match.column,
      });
    } catch (cause) {
      if (requestVersionRef.current !== requestVersion) return;
      setStatus('error');
      setMessage(
        fileBrowserError(cause, 'This match is no longer available. Try searching again.'),
      );
    }
  };

  return (
    <section className="project-content-search" aria-label="Search project contents">
      <form onSubmit={(event) => void submit(event)}>
        <Search size={13} aria-hidden="true" />
        <label>
          <span className="sr-only">Search text in project files</span>
          <input
            name="project-content-search-query"
            value={query}
            aria-label="Search text in project files"
            placeholder="Search file contents…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="submit" disabled={query.trim().length < 2 || status !== 'idle'}>
          {status === 'searching' ? 'Searching…' : 'Search contents'}
        </button>
      </form>

      {message !== null ? (
        <p className="project-content-search-error" role="alert">
          {message}
        </p>
      ) : null}
      {result !== null ? (
        <div className="project-content-results">
          <p role="status">
            {result.matches.length} matches · {result.scannedFiles} files scanned
            {result.skippedFiles > 0 ? ` · ${String(result.skippedFiles)} skipped` : ''}
            {result.truncated ? ' · results limited' : ''}
          </p>
          <ol>
            {result.matches.map((match, index) => (
              <li key={`${match.relativePath}:${match.line}:${match.column}:${index}`}>
                <button
                  type="button"
                  disabled={status !== 'idle'}
                  aria-label={`Open ${match.relativePath} at ${String(match.line)}:${String(match.column)}`}
                  onClick={() => void openMatch(match)}
                >
                  <span>
                    <code>{match.relativePath}</code>
                    <em>
                      {match.line}:{match.column}
                    </em>
                  </span>
                  <small>{match.preview}</small>
                </button>
              </li>
            ))}
          </ol>
          {result.matches.length === 0 ? <p>No matches found.</p> : null}
        </div>
      ) : null}
    </section>
  );
}
