import { useEffect, useRef, useState, type JSX } from 'react';

import { FileDocumentSchema, type FileDocument } from '../../../../../../shared/files/contracts.js';
import { minimumNodeDimensionsForKind } from '../../../../../../shared/canvas/node-dimensions.js';
import { fileBrowserError } from '../../../file-editor/browser/useProjectFileBrowser.js';
import { languageForFile } from '../../../file-editor/language.js';
import { MonacoTextEditor } from '../../../file-editor/MonacoTextEditor.js';
import { useAboveMinSize } from '../../../../lib/use-above-min-size.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';

const FILE_FACE_MINIMUM = minimumNodeDimensionsForKind('file');

type FileViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly document: FileDocument };

/**
 * Minimal file node: the file name in the strip and the file's code below —
 * read-only, scrollable, nothing else. Clicking a file in the project tree is
 * what creates these nodes; a node without a file only shows a hint.
 */
export function FileNodeFace({ data }: NodeFaceProps): JSX.Element {
  const reference = data.file;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const large = useAboveMinSize(bodyRef, FILE_FACE_MINIMUM);
  const [view, setView] = useState<FileViewState>({ status: 'loading' });
  const readable = reference !== undefined && !reference.missing && reference.kind === 'file';

  useEffect(() => {
    if (!readable || reference === undefined) return;
    let active = true;
    setView({ status: 'loading' });
    void window.forgeboard.files
      .read({ projectId: reference.projectId, relativePath: reference.relativePath })
      .then((document) => {
        if (!active) return;
        setView({ status: 'ready', document: FileDocumentSchema.parse(document) });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setView({
          status: 'error',
          message: fileBrowserError(cause, "This file couldn't be opened."),
        });
      });
    return () => {
      active = false;
    };
  }, [readable, reference?.projectId, reference?.relativePath]);

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

      <div className="node-face-body nowheel nodrag" ref={bodyRef}>
        {!readable ? (
          <p className="node-face-hint">
            {reference?.missing === true
              ? 'This file is missing on disk.'
              : 'Click a file in the project tree to open it here.'}
          </p>
        ) : !large ? (
          <p className="node-face-hint">Make this node larger to read the file.</p>
        ) : view.status === 'loading' ? (
          <p className="node-face-hint" role="status">
            Opening file…
          </p>
        ) : view.status === 'error' ? (
          <p className="node-face-hint" role="alert">
            {view.message}
          </p>
        ) : view.document.contentKind === 'text' ? (
          <MonacoTextEditor
            value={view.document.content ?? ''}
            language={languageForFile(view.document.relativePath)}
            readOnly
            ariaLabel={`Reading ${view.document.relativePath}`}
            onChange={() => undefined}
            onSave={() => undefined}
          />
        ) : (
          <p className="node-face-hint" role="status">
            {view.document.readOnlyReason ?? 'Not a text file.'}
          </p>
        )}
      </div>
    </section>
  );
}

function fileName(relativePath: string): string {
  return relativePath.split('/').at(-1) ?? relativePath;
}
