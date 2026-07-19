import { useEffect, useState } from 'react';

import { DiagnosticsSummary } from './diagnostics/DiagnosticsSummary.js';
import type { FileDiagnosticsState } from './diagnostics/model.js';
import type { MonacoLoader } from './monaco-loader.js';
import { languageForFile, languageHasBundledDiagnostics } from './language.js';
import { MonacoTextEditor } from './MonacoTextEditor.js';
import type { FileEditorOperations } from './operations.js';
import { useFileEditor, type FileEditorStatus } from './useFileEditor.js';
import { WorkspaceTooltip } from '../workspace/shell/tooltips/WorkspaceTooltip.js';
import './FileEditorPanel.css';

export interface FileEditorPanelProps {
  readonly projectId: string;
  readonly relativePath: string;
  readonly operations: FileEditorOperations;
  readonly readOnly?: boolean;
  readonly monacoLoader?: MonacoLoader;
  readonly theme?: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  readonly onRevealInTree?: () => void;
  readonly onSessionStateChange?: (state: FileEditorSessionState) => void;
  readonly initialPosition?: {
    readonly requestId: number;
    readonly line: number;
    readonly column: number;
  };
}

export interface FileEditorSessionState {
  readonly status: FileEditorStatus;
  readonly dirty: boolean;
}

export function FileEditorPanel({
  projectId,
  relativePath,
  operations,
  readOnly = false,
  monacoLoader,
  theme,
  onRevealInTree,
  onSessionStateChange,
  initialPosition,
}: FileEditorPanelProps) {
  const editor = useFileEditor(projectId, relativePath, operations, readOnly);
  const [diagnostics, setDiagnostics] = useState<FileDiagnosticsState>({
    availability: 'loading',
    items: [],
  });
  const effectiveReadOnly = readOnly || editor.document?.readOnly === true;
  const pathSegments = relativePath.split('/');
  const statusLabel = statusText(editor.status, editor.dirty, effectiveReadOnly);
  const language = languageForFile(relativePath);

  useEffect(() => {
    setDiagnostics({ availability: 'loading', items: [] });
  }, [projectId, relativePath]);

  useEffect(() => {
    onSessionStateChange?.({ status: editor.status, dirty: editor.dirty });
  }, [editor.dirty, editor.status, onSessionStateChange]);

  return (
    <section className="file-editor-panel" aria-label={`File editor: ${relativePath}`}>
      <header className="file-editor-header">
        <div className="file-editor-title">
          <nav aria-label="File path">
            {pathSegments.map((segment, index) => (
              <span key={`${segment}:${index}`}>
                {index > 0 ? <span aria-hidden="true"> / </span> : null}
                {segment}
              </span>
            ))}
          </nav>
          <span className={`file-editor-state file-editor-state-${editor.status}`} role="status">
            {statusLabel}
          </span>
        </div>
        <div className="file-editor-actions">
          <label>
            <span className="sr-only">Past versions of this file</span>
            <select
              name="file-history"
              aria-label="Past versions of this file"
              value=""
              disabled={
                effectiveReadOnly || editor.history.length === 0 || editor.activity !== null
              }
              onChange={(event) => editor.restoreHistory(event.target.value)}
            >
              <option value="">Past versions</option>
              {editor.history.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label} · {new Date(entry.capturedAt).toLocaleTimeString()}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={editor.status !== 'ready' || editor.activity !== null}
            onClick={() => void editor.revert()}
          >
            {editor.activity === 'revert' ? 'Discarding…' : 'Discard changes'}
          </button>
          <button
            type="button"
            disabled={editor.status === 'loading' || editor.activity !== null}
            onClick={() => void editor.reveal()}
          >
            {editor.activity === 'reveal' ? 'Showing…' : 'Show in file manager'}
          </button>
          {onRevealInTree !== undefined ? (
            <button
              type="button"
              disabled={editor.status === 'loading' || editor.activity !== null}
              onClick={onRevealInTree}
            >
              Show in file list
            </button>
          ) : null}
          <WorkspaceTooltip
            content={
              editor.dirty
                ? 'Save or discard your changes before opening this file in another app'
                : editor.activity !== null
                  ? 'Wait for the current file action to finish'
                  : 'Open this file in its default desktop app'
            }
          >
            <button
              type="button"
              aria-label="Open in default app"
              disabled={editor.status !== 'ready' || editor.activity !== null || editor.dirty}
              onClick={() => void editor.openExternal()}
            >
              {editor.activity === 'external' ? 'Opening…' : 'Open in default app'}
            </button>
          </WorkspaceTooltip>
          <button
            type="button"
            className="file-editor-save"
            disabled={
              editor.status !== 'ready' ||
              effectiveReadOnly ||
              !editor.dirty ||
              editor.activity !== null
            }
            onClick={() => void editor.save()}
          >
            {editor.activity === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      {editor.message !== null ? (
        <div
          className={`file-editor-message file-editor-message-${editor.message.kind}`}
          role={editor.message.kind === 'error' ? 'alert' : 'status'}
        >
          {editor.message.text}
        </div>
      ) : null}

      <div className="file-editor-body">
        {editor.status === 'loading' ? (
          <div className="file-editor-placeholder" role="status">
            Opening file…
          </div>
        ) : null}
        {editor.status === 'missing' ? (
          <FileEditorFailure
            title="File not found"
            detail="This file no longer exists in the project folder. It may have been moved or deleted."
            onRetry={editor.retry}
          />
        ) : null}
        {editor.status === 'error' ? (
          <FileEditorFailure
            title="Couldn't open this file"
            detail="Something went wrong while opening this file. Try again."
            onRetry={editor.retry}
          />
        ) : null}
        {editor.status === 'ready' && editor.document?.contentKind === 'text' ? (
          <MonacoTextEditor
            value={editor.buffer}
            language={language}
            readOnly={effectiveReadOnly}
            ariaLabel={`Editing ${relativePath}`}
            onChange={editor.setBuffer}
            onSave={effectiveReadOnly ? () => undefined : () => void editor.save()}
            onDiagnosticsChange={setDiagnostics}
            diagnosticsAvailable={languageHasBundledDiagnostics(language)}
            {...(initialPosition === undefined ? {} : { position: initialPosition })}
            {...(monacoLoader === undefined ? {} : { loader: monacoLoader })}
            {...(theme === undefined ? {} : { theme })}
          />
        ) : null}
        {editor.status === 'ready' && editor.document?.contentKind !== 'text' ? (
          <div className="file-editor-placeholder file-editor-read-only" role="status">
            <strong>
              {editor.document?.contentKind === 'binary'
                ? 'Not a text file'
                : 'This file is too large to edit'}
            </strong>
            <p>{editor.document?.readOnlyReason}</p>
          </div>
        ) : null}
      </div>

      {editor.status === 'ready' && editor.document !== null ? (
        <footer className="file-editor-footer">
          <span>{formatBytes(editor.document.sizeBytes)}</span>
          <span>{editor.document.encoding ?? editor.document.contentKind}</span>
          <span>{new Date(editor.document.modifiedAt).toLocaleString()}</span>
          {editor.document.sha256 !== null ? (
            <WorkspaceTooltip content={editor.document.sha256}>
              <code aria-label={`SHA-256: ${editor.document.sha256}`} tabIndex={0}>
                {editor.document.sha256.slice(0, 12)}
              </code>
            </WorkspaceTooltip>
          ) : null}
          <DiagnosticsSummary
            state={
              editor.document.contentKind === 'text'
                ? diagnostics
                : {
                    availability: 'unavailable',
                    items: [],
                  }
            }
          />
        </footer>
      ) : null}
    </section>
  );
}

function FileEditorFailure({
  title,
  detail,
  onRetry,
}: {
  readonly title: string;
  readonly detail: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="file-editor-placeholder" role="alert">
      <strong>{title}</strong>
      <p>{detail}</p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function statusText(
  status: 'loading' | 'ready' | 'missing' | 'error',
  dirty: boolean,
  readOnly: boolean,
): string {
  if (status === 'loading') return 'Opening…';
  if (status === 'missing') return 'Not found';
  if (status === 'error') return "Couldn't open";
  if (readOnly) return 'Read-only';
  return dirty ? 'Unsaved changes' : 'Saved';
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
