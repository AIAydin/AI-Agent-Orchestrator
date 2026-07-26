import { useRef, type JSX } from 'react';

import { minimumNodeDimensionsForKind } from '../../../../../../shared/canvas/node-dimensions.js';
import { languageForFile } from '../../../file-editor/language.js';
import { MonacoTextEditor } from '../../../file-editor/MonacoTextEditor.js';
import type { FileEditorOperations } from '../../../file-editor/operations.js';
import { useFileEditor } from '../../../file-editor/useFileEditor.js';
import { useAboveMinSize } from '../../../../lib/use-above-min-size.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';

const FILE_FACE_MINIMUM = minimumNodeDimensionsForKind('file');

const FILE_NODE_OPERATIONS: FileEditorOperations = {
  read: (input) => window.forgeboard.files.read(input),
  save: (input) => window.forgeboard.files.save(input),
  revert: (input) => window.forgeboard.files.revert(input),
  reveal: (input) => window.forgeboard.files.reveal(input),
  openExternal: (input) => window.forgeboard.files.openExternal(input),
};

/**
 * Minimal file node: the file name in the strip and the file's code below —
 * editable for normal text files, saved back to disk with the Save button or
 * Cmd/Ctrl+S. Clicking a file in the project tree is what creates these nodes;
 * a node without a file only shows a hint.
 */
export function FileNodeFace({ data }: NodeFaceProps): JSX.Element {
  const reference = data.file;
  if (reference !== undefined && !reference.missing && reference.kind === 'file') {
    return <FileNodeEditor projectId={reference.projectId} relativePath={reference.relativePath} />;
  }
  return (
    <section className="node-face file-node-face" aria-label="File view">
      <div className="node-face-strip nodrag">
        <span
          className="node-face-strip-label"
          title={reference === undefined ? undefined : reference.relativePath}
        >
          {reference === undefined ? 'No file' : fileName(reference.relativePath)}
        </span>
      </div>
      <div className="node-face-body nowheel nodrag">
        <p className="node-face-hint">
          {reference?.missing === true
            ? 'This file is missing on disk.'
            : 'Click a file in the project tree to open it here.'}
        </p>
      </div>
    </section>
  );
}

function FileNodeEditor({
  projectId,
  relativePath,
}: {
  readonly projectId: string;
  readonly relativePath: string;
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const large = useAboveMinSize(bodyRef, FILE_FACE_MINIMUM);
  const editor = useFileEditor(projectId, relativePath, FILE_NODE_OPERATIONS);
  const document = editor.document;
  const editable = document?.contentKind === 'text' && !document.readOnly;
  const failure = editor.message?.kind === 'error' ? editor.message.text : null;

  return (
    <section className="node-face file-node-face" aria-label="File view">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label" title={relativePath}>
          {fileName(relativePath)}
        </span>
        {failure !== null && editor.status === 'ready' ? (
          <span className="node-face-status failed" role="alert" title={failure}>
            {failure}
          </span>
        ) : editor.dirty ? (
          <span className="node-face-status">Unsaved</span>
        ) : null}
        {failure !== null && editor.status === 'ready' ? (
          <button
            type="button"
            disabled={editor.activity !== null}
            onClick={() => void editor.revert()}
            title="Reload the saved file, discarding this node's changes"
          >
            Reload
          </button>
        ) : null}
        {editable && editor.dirty ? (
          <button
            type="button"
            disabled={editor.activity !== null}
            onClick={() => void editor.save()}
          >
            {editor.activity === 'save' ? 'Saving…' : 'Save'}
          </button>
        ) : null}
      </div>

      <div className="node-face-body nowheel nodrag" ref={bodyRef}>
        {!large ? (
          <p className="node-face-hint">Make this node larger to read the file.</p>
        ) : editor.status === 'loading' ? (
          <p className="node-face-hint" role="status">
            Opening file…
          </p>
        ) : editor.status !== 'ready' ? (
          <p className="node-face-hint" role="alert">
            {failure ?? "This file couldn't be opened."}
          </p>
        ) : document?.contentKind === 'text' ? (
          <MonacoTextEditor
            value={editor.buffer}
            language={languageForFile(document.relativePath)}
            readOnly={!editable}
            ariaLabel={`${editable ? 'Editing' : 'Reading'} ${document.relativePath}`}
            onChange={editor.setBuffer}
            onSave={() => void editor.save()}
          />
        ) : (
          <p className="node-face-hint" role="status">
            {document?.readOnlyReason ?? 'Not a text file.'}
          </p>
        )}
      </div>
    </section>
  );
}

function fileName(relativePath: string): string {
  return relativePath.split('/').at(-1) ?? relativePath;
}
