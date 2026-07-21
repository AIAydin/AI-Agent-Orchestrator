import { useMemo, useState, type JSX } from 'react';
import { ArrowRight, Circle, Diamond, Shapes, Square, Trash2, Type } from 'lucide-react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import {
  createWhiteboardElement,
  parseWhiteboardDocument,
  type WhiteboardDocument,
  type WhiteboardElementType,
} from './model.js';
import { WhiteboardPreview } from './WhiteboardPreview.js';

/**
 * Whiteboard face: the interactive inert-SVG preview fills the node body; the
 * shape toolbar lives in a small node-anchored popover. Element editing,
 * export, and agent-context sharing stay in the inspector panel until 2d.
 */
export function WhiteboardNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const document = useMemo(() => parseWhiteboardDocument(data.excalidraw), [data.excalidraw]);
  const activeElements = document.elements.filter((element) => !element.isDeleted);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [annotation, setAnnotation] = useState('');
  const selected = activeElements.find((element) => element.id === selectedId) ?? null;

  const persist = (
    next: WhiteboardDocument,
    annotationIds: readonly string[] | undefined,
  ): void => {
    session.updateNodeData(id, {
      excalidraw: next,
      annotationIds: annotationIds === undefined ? (data.annotationIds ?? []) : [...annotationIds],
    });
  };

  const addElement = (type: WhiteboardElementType, text = ''): void => {
    if (readOnly) return;
    session.recordHistory();
    const element = createWhiteboardElement(type, activeElements.length, text);
    persist(
      { ...document, elements: [...document.elements, element] },
      type === 'text' ? [...(data.annotationIds ?? []), element.id] : undefined,
    );
    setSelectedId(element.id);
    setAnnotation('');
  };

  const deleteSelected = (): void => {
    if (readOnly || selected === null) return;
    session.recordHistory();
    persist(
      {
        ...document,
        elements: document.elements.map((element) =>
          element.id === selected.id
            ? { ...element, isDeleted: true, version: element.version + 1, updated: Date.now() }
            : element,
        ),
      },
      (data.annotationIds ?? []).filter((annotationId) => annotationId !== selected.id),
    );
    setSelectedId(null);
  };

  return (
    <section className="node-face whiteboard-node-face" aria-label="Whiteboard">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          {activeElements.length} element{activeElements.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          aria-label="Whiteboard tools"
          aria-expanded={toolsOpen}
          disabled={readOnly}
          onClick={() => setToolsOpen((open) => !open)}
        >
          <Shapes size={12} aria-hidden="true" /> Tools
        </button>
      </div>
      <div className="node-face-body nowheel nodrag">
        <WhiteboardPreview
          document={document}
          selectedId={selectedId}
          onSelect={setSelectedId}
          className="whiteboard-face-preview"
        />
        {toolsOpen && !readOnly ? (
          <div className="node-face-popover" role="dialog" aria-label="Whiteboard tools">
            <div className="whiteboard-face-tools">
              <button type="button" aria-label="Add rectangle" onClick={() => addElement('rectangle')}>
                <Square size={13} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Add ellipse" onClick={() => addElement('ellipse')}>
                <Circle size={13} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Add diamond" onClick={() => addElement('diamond')}>
                <Diamond size={13} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Add arrow" onClick={() => addElement('arrow')}>
                <ArrowRight size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Delete selected element"
                disabled={selected === null}
                onClick={deleteSelected}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </div>
            <label>
              Annotation
              <input
                name={`node-${id}-whiteboard-face-annotation`}
                value={annotation}
                maxLength={20_000}
                placeholder="Describe a screen or interaction"
                onChange={(event) => setAnnotation(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={annotation.trim() === ''}
              onClick={() => addElement('text', annotation.trim())}
            >
              <Type size={13} aria-hidden="true" /> Add annotation
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
