import { useState, type JSX } from 'react';
import { ImagePlus } from 'lucide-react';

import { MarkdownComposer } from '../../../content/markdown/MarkdownComposer.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { addOrReplaceImageReference, type NoteImageReference } from './reference-updates.js';
import { useNoteImagePreviews } from './use-note-image-previews.js';

/**
 * Note & image face: markdown plus an image grid; images are added through the
 * existing project chooser. Alt text, relinking, and canvas-image reuse stay
 * in the inspector panel until 2d.
 */
export function NoteImageNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const images = data.images ?? [];
  const altText = data.altText ?? {};
  const previews = useNoteImagePreviews(session.project.id, images);
  const [choosing, setChoosing] = useState(false);

  const choose = async (): Promise<void> => {
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
        ...(reference.lastKnownHash === undefined ? {} : { lastKnownHash: reference.lastKnownHash }),
      };
      session.recordHistory();
      session.updateNodeData(id, { images: addOrReplaceImageReference(images, normalized) });
    } catch (cause) {
      session.reportError(
        cause instanceof Error ? cause.message : 'Could not choose this project image.',
      );
    } finally {
      setChoosing(false);
    }
  };

  return (
    <section className="node-face note-image-node-face" aria-label="Note and images">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          {images.length} image{images.length === 1 ? '' : 's'}
        </span>
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
      </div>
    </section>
  );
}
