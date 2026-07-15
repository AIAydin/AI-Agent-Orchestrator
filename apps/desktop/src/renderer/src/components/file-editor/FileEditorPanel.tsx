import type { MonacoLoader } from './monaco-loader.js';
import { languageForFile } from './language.js';
import { MonacoTextEditor } from './MonacoTextEditor.js';
import type { FileEditorOperations } from './operations.js';
import { useFileEditor } from './useFileEditor.js';
import './FileEditorPanel.css';

export interface FileEditorPanelProps {
  readonly projectId: string;
  readonly relativePath: string;
  readonly operations: FileEditorOperations;
  readonly readOnly?: boolean;
  readonly monacoLoader?: MonacoLoader;
  readonly theme?: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
}

export function FileEditorPanel({
  projectId,
  relativePath,
  operations,
  readOnly = false,
  monacoLoader,
  theme,
}: FileEditorPanelProps) {
  const editor = useFileEditor(projectId, relativePath, operations, readOnly);
  const effectiveReadOnly = readOnly || editor.document?.readOnly === true;
  const pathSegments = relativePath.split('/');
  const statusLabel = statusText(editor.status, editor.dirty, effectiveReadOnly);

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
            <span className="sr-only">File history</span>
            <select
              name="file-history"
              aria-label="File history"
              value=""
              disabled={
                effectiveReadOnly || editor.history.length === 0 || editor.activity !== null
              }
              onChange={(event) => editor.restoreHistory(event.target.value)}
            >
              <option value="">History</option>
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
            {editor.activity === 'revert' ? 'Reverting…' : 'Revert'}
          </button>
          <button
            type="button"
            disabled={editor.status === 'loading' || editor.activity !== null}
            onClick={() => void editor.reveal()}
          >
            {editor.activity === 'reveal' ? 'Revealing…' : 'Reveal'}
          </button>
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
            title="File missing"
            detail="The file no longer exists at this project-relative path."
            onRetry={editor.retry}
          />
        ) : null}
        {editor.status === 'error' ? (
          <FileEditorFailure
            title="File unavailable"
            detail="Forgeboard could not safely open this project file."
            onRetry={editor.retry}
          />
        ) : null}
        {editor.status === 'ready' && editor.document?.contentKind === 'text' ? (
          <MonacoTextEditor
            value={editor.buffer}
            language={languageForFile(relativePath)}
            readOnly={effectiveReadOnly}
            ariaLabel={`Editing ${relativePath}`}
            onChange={editor.setBuffer}
            onSave={effectiveReadOnly ? () => undefined : () => void editor.save()}
            loader={monacoLoader}
            theme={theme}
          />
        ) : null}
        {editor.status === 'ready' && editor.document?.contentKind !== 'text' ? (
          <div className="file-editor-placeholder file-editor-read-only">
            <strong>
              {editor.document?.contentKind === 'binary' ? 'Binary file' : 'File too large'}
            </strong>
            <p>{editor.document?.readOnlyReason}</p>
            <button
              type="button"
              disabled={editor.activity !== null}
              onClick={() => void editor.reveal()}
            >
              {editor.activity === 'reveal' ? 'Revealing…' : 'Reveal in file manager'}
            </button>
          </div>
        ) : null}
      </div>

      {editor.status === 'ready' && editor.document !== null ? (
        <footer className="file-editor-footer">
          <span>{formatBytes(editor.document.sizeBytes)}</span>
          <span>{editor.document.encoding ?? editor.document.contentKind}</span>
          <span>{new Date(editor.document.modifiedAt).toLocaleString()}</span>
          {editor.document.sha256 !== null ? (
            <code title={editor.document.sha256}>{editor.document.sha256.slice(0, 12)}</code>
          ) : null}
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
    <div className="file-editor-placeholder">
      <strong>{title}</strong>
      <p>{detail}</p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function statusText(
  status: 'loading' | 'ready' | 'missing' | 'error',
  dirty: boolean,
  readOnly: boolean,
): string {
  if (status === 'loading') return 'Loading';
  if (status === 'missing') return 'Missing';
  if (status === 'error') return 'Error';
  if (readOnly) return 'Read-only';
  return dirty ? 'Unsaved' : 'Saved';
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
