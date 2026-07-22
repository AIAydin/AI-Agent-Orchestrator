import { useState, type JSX } from 'react';
import { ImagePlus, Link2, RotateCcw, Sliders, Trash2 } from 'lucide-react';

import { MarkdownComposer } from '../../../content/markdown/MarkdownComposer.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import {
  addOrReplaceImageReference,
  moveAltText,
  removeImageReference,
  type NoteImageReference,
} from './reference-updates.js';
import { useNoteImagePreviews } from './use-note-image-previews.js';
import './note-image-inspector.css';

/**
 * Note & image face: markdown plus an image grid; images are added through the
 * existing project chooser. Alt text, relinking, and reuse of canvas images edit
 * in a config popover anchored to the face.
 */
export function NoteImageNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const images = data.images ?? [];
  const altText = data.altText ?? {};
  const previews = useNoteImagePreviews(session.project.id, images);
  const [choosing, setChoosing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const canvasImages = session.canvasImageNodes.filter(
    (entry) => entry.projectId === session.project.id,
  );

  const choose = async (replacedPath?: string): Promise<void> => {
    if (readOnly || choosing) return;
    setChoosing(true);
    try {
      const reference = await window.forgeboard.files.chooseImage({
        projectId: session.project.id,
      });
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
      session.recordHistory();
      session.updateNodeData(id, {
        images: addOrReplaceImageReference(images, normalized, replacedPath),
        altText: moveAltText(altText, reference.relativePath, replacedPath),
      });
    } catch (cause) {
      session.reportError(
        cause instanceof Error ? cause.message : 'Could not choose this project image.',
      );
    } finally {
      setChoosing(false);
    }
  };

  const includeCanvasImage = (entry: (typeof canvasImages)[number], checked: boolean): void => {
    if (readOnly) return;
    session.recordHistory();
    if (checked) {
      const normalized: NoteImageReference = {
        projectId: entry.projectId,
        relativePath: entry.relativePath,
        kind: 'image',
        missing: entry.missing,
        ...(entry.lastKnownHash === undefined ? {} : { lastKnownHash: entry.lastKnownHash }),
      };
      session.updateNodeData(id, { images: addOrReplaceImageReference(images, normalized) });
      return;
    }
    session.updateNodeData(id, removeImageReference(images, altText, entry.relativePath));
  };

  return (
    <section className="node-face note-image-node-face" aria-label="Note and images">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          {images.length} image{images.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          aria-label="Image settings"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Sliders size={12} aria-hidden="true" /> Settings
        </button>
        <button
          type="button"
          aria-label="Choose image"
          disabled={readOnly || choosing}
          onClick={() => void choose()}
        >
          <ImagePlus size={12} aria-hidden="true" /> {choosing ? 'Choosing…' : 'Choose image'}
        </button>
      </div>
      <div className="node-face-body nowheel nodrag">
        <MarkdownComposer
          label="Note"
          value={data.markdown ?? ''}
          readOnly={readOnly}
          emptyLabel="Write a note that stays on this device."
          onBeginEdit={() => session.recordHistory()}
          onChange={(markdown) => session.updateNodeData(id, { markdown })}
        />
        {images.length > 0 ? (
          <ul className="note-image-face-grid" aria-label="Linked images">
            {images.map((image) => {
              const preview = previews[image.relativePath];
              return (
                <li key={`${image.projectId}:${image.relativePath}`}>
                  {preview?.status === 'available' ? (
                    <img
                      src={preview.dataUrl}
                      alt={altText[image.relativePath] ?? image.relativePath}
                      draggable={false}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span role="status">
                      {preview?.status === 'loading' || preview === undefined
                        ? 'Loading…'
                        : preview.status === 'missing' || image.missing
                          ? 'Missing'
                          : 'No preview'}
                    </span>
                  )}
                  <code>{image.relativePath}</code>
                </li>
              );
            })}
          </ul>
        ) : null}

        {settingsOpen ? (
          <div className="node-face-popover" role="dialog" aria-label="Image settings">
            {canvasImages.length > 0 ? (
              <section className="note-image-face-reuse" aria-label="Reuse a canvas image">
                <strong>Use an image already on this canvas</strong>
                {canvasImages.map((entry) => (
                  <label key={entry.id}>
                    <input
                      type="checkbox"
                      name={`note-image-face-reuse-${entry.id}`}
                      aria-label={`Include image ${entry.title}`}
                      checked={images.some((image) => image.relativePath === entry.relativePath)}
                      disabled={readOnly}
                      onChange={(event) => includeCanvasImage(entry, event.target.checked)}
                    />
                    <span>{entry.title}</span>
                    <small>{entry.relativePath}</small>
                  </label>
                ))}
              </section>
            ) : null}

            {images.length === 0 ? (
              <p className="node-face-hint">No image linked yet. Use Choose image above.</p>
            ) : (
              <ol className="note-image-face-editors">
                {images.map((image, index) => {
                  const preview = previews[image.relativePath];
                  const missing = preview?.status === 'missing' || image.missing;
                  return (
                    <li key={`${image.projectId}:${image.relativePath}`}>
                      <code>{image.relativePath}</code>
                      <label>
                        Alternative text
                        <input
                          name="note-image-face-alt-text"
                          value={altText[image.relativePath] ?? ''}
                          aria-label={`Alt text for image ${index + 1}`}
                          readOnly={readOnly}
                          onFocus={() => session.recordHistory()}
                          onChange={(event) =>
                            session.updateNodeData(id, {
                              altText: {
                                ...altText,
                                [image.relativePath]: event.target.value.slice(0, 10_000),
                              },
                            })
                          }
                        />
                      </label>
                      {missing ? (
                        <span className="note-image-face-missing" role="alert">
                          Image missing or moved — relink it below.
                        </span>
                      ) : null}
                      <div className="note-image-face-actions">
                        <button
                          type="button"
                          aria-label={`Relink image ${index + 1}`}
                          disabled={readOnly || choosing}
                          onClick={() => void choose(image.relativePath)}
                        >
                          <Link2 size={12} aria-hidden="true" /> {missing ? 'Find image' : 'Relink'}
                          {missing ? <RotateCcw size={11} aria-hidden="true" /> : null}
                        </button>
                        <button
                          type="button"
                          className="danger-text"
                          aria-label={`Clear image ${index + 1}`}
                          disabled={readOnly}
                          onClick={() => {
                            session.recordHistory();
                            session.updateNodeData(
                              id,
                              removeImageReference(images, altText, image.relativePath),
                            );
                          }}
                        >
                          <Trash2 size={12} aria-hidden="true" /> Clear
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
