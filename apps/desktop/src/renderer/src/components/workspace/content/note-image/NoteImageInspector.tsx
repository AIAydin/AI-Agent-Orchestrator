import { useState } from 'react';
import { ImagePlus, Link2, RotateCcw, Trash2 } from 'lucide-react';

import { MarkdownComposer } from '../../../content/markdown/MarkdownComposer.js';
import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import {
  addOrReplaceImageReference,
  moveAltText,
  removeImageReference,
  type NoteImageReference,
} from './reference-updates.js';
import { useNoteImagePreviews } from './use-note-image-previews.js';
import './note-image-inspector.css';

interface NoteImageInspectorProps {
  readonly projectId: string;
  readonly node: WorkshopNode;
  readonly nodes: readonly WorkshopNode[];
  readonly readOnly: boolean;
  readonly onRecord: () => void;
  readonly onUpdate: (data: Partial<WorkshopNode['data']>) => void;
  readonly onError: (message: string) => void;
}

export function NoteImageInspector({
  projectId,
  node,
  nodes,
  readOnly,
  onRecord,
  onUpdate,
  onError,
}: NoteImageInspectorProps) {
  const images = node.data.images ?? [];
  const altText = node.data.altText ?? {};
  const previews = useNoteImagePreviews(
    projectId,
    images,
    readOnly ? undefined : (reconciled) => onUpdate({ images: reconciled }),
  );
  const [choosing, setChoosing] = useState(false);

  const imageNodes = nodes.filter(
    (candidate) =>
      candidate.data.kind === 'file' &&
      candidate.data.file?.kind === 'image' &&
      candidate.data.file.projectId === projectId,
  );

  const choose = async (replacedPath?: string): Promise<void> => {
    if (readOnly || choosing) return;
    setChoosing(true);
    try {
      const reference = await window.forgeboard.files.chooseImage({ projectId });
      if (reference === null) return;
      const normalized: NoteImageReference = {
        projectId: reference.projectId,
        relativePath: reference.relativePath,
        kind: 'image',
        missing: reference.missing,
        ...(reference.lastKnownHash === undefined
          ? {}
          : { lastKnownHash: reference.lastKnownHash }),
      };
      onRecord();
      onUpdate({
        images: addOrReplaceImageReference(images, normalized, replacedPath),
        altText: moveAltText(altText, reference.relativePath, replacedPath),
      });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not choose this project image.');
    } finally {
      setChoosing(false);
    }
  };

  const includeCanvasImage = (reference: NoteImageReference, checked: boolean): void => {
    if (readOnly) return;
    onRecord();
    if (checked) {
      const normalized: NoteImageReference = {
        projectId: reference.projectId,
        relativePath: reference.relativePath,
        kind: 'image',
        missing: reference.missing,
        ...(reference.lastKnownHash === undefined
          ? {}
          : { lastKnownHash: reference.lastKnownHash }),
      };
      onUpdate({ images: addOrReplaceImageReference(images, normalized) });
      return;
    }
    onUpdate(removeImageReference(images, altText, reference.relativePath));
  };

  return (
    <section
      className="content-node-inspector note-image-inspector"
      aria-label="Note and image settings"
    >
      <header>
        <div>
          <ImagePlus size={14} />
          <h3>Note & images</h3>
        </div>
        <span>{images.length} images</span>
      </header>
      <MarkdownComposer
        label="Note"
        value={node.data.markdown ?? ''}
        readOnly={readOnly}
        emptyLabel="Write a note that stays on this device."
        onBeginEdit={onRecord}
        onChange={(markdown) => onUpdate({ markdown })}
      />

      <section className="note-image-picker" aria-label="Local image references">
        <div>
          <strong>Project images</strong>
          <p>Only images inside this project. Image bytes stay on this device.</p>
        </div>
        <button type="button" disabled={readOnly || choosing} onClick={() => void choose()}>
          <ImagePlus size={13} /> {choosing ? 'Choosing…' : 'Choose image'}
        </button>
      </section>

      {imageNodes.length > 0 ? (
        <details className="note-image-canvas-references">
          <summary>Use an image already on this canvas</summary>
          {imageNodes.map((candidate) => {
            const reference = candidate.data.file;
            if (reference === undefined) return null;
            return (
              <label key={candidate.id}>
                <input
                  type="checkbox"
                  name={`note-image-${candidate.id}`}
                  aria-label={`Include image ${candidate.data.title}`}
                  checked={images.some((image) => image.relativePath === reference.relativePath)}
                  disabled={readOnly}
                  onChange={(event) => includeCanvasImage(reference, event.target.checked)}
                />
                <span>{candidate.data.title}</span>
                <small>{reference.relativePath}</small>
              </label>
            );
          })}
        </details>
      ) : null}

      {images.length === 0 ? (
        <p className="note-image-empty" role="status">
          No image linked yet. Use Choose image above.
        </p>
      ) : (
        <ol className="note-image-list">
          {images.map((image, index) => {
            const preview = previews[image.relativePath];
            const missing = preview?.status === 'missing' || image.missing;
            const unavailable = preview?.status === 'unavailable';
            return (
              <li key={`${image.projectId}:${image.relativePath}`}>
                <div className="note-image-preview">
                  {preview?.status === 'available' ? (
                    <img
                      src={preview.dataUrl}
                      alt={altText[image.relativePath] ?? ''}
                      draggable={false}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span>{preview?.status === 'loading' ? 'Loading preview…' : 'No preview'}</span>
                  )}
                </div>
                <div className="note-image-reference-heading">
                  <code>{image.relativePath}</code>
                </div>
                <label>
                  Alternative text
                  <input
                    name="note-image-alt-text"
                    value={altText[image.relativePath] ?? ''}
                    aria-label={`Alt text for image ${index + 1}`}
                    readOnly={readOnly}
                    onFocus={onRecord}
                    onChange={(event) =>
                      onUpdate({
                        altText: {
                          ...altText,
                          [image.relativePath]: event.target.value.slice(0, 10_000),
                        },
                      })
                    }
                  />
                </label>
                {missing || unavailable ? (
                  <div className="missing-local-reference" role="alert">
                    <strong>{missing ? 'Image missing or moved' : 'Preview unavailable'}</strong>
                    <span>
                      {preview?.status === 'missing' || preview?.status === 'unavailable'
                        ? preview.message
                        : 'Choose the image at its new location to reconnect it.'}
                    </span>
                    <button
                      type="button"
                      disabled={readOnly || choosing}
                      onClick={() => void choose(image.relativePath)}
                    >
                      <RotateCcw size={12} /> Find image
                    </button>
                  </div>
                ) : null}
                <div className="note-image-actions">
                  <button
                    type="button"
                    disabled={readOnly || choosing}
                    onClick={() => void choose(image.relativePath)}
                  >
                    <Link2 size={12} /> Relink
                  </button>
                  <button
                    type="button"
                    className="danger-text"
                    disabled={readOnly}
                    onClick={() => {
                      onRecord();
                      onUpdate(removeImageReference(images, altText, image.relativePath));
                    }}
                  >
                    <Trash2 size={12} /> Clear
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p className="note-image-context-disclosure">
        As agent context, Forgeboard sends the note text, image count, and alt text. It never sends
        image paths or bytes — attach a File node to share file contents.
      </p>
    </section>
  );
}
