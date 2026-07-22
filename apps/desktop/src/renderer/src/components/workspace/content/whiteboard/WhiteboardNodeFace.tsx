import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  ArrowRight,
  Circle,
  Diamond,
  Download,
  Link2,
  Shapes,
  Square,
  Trash2,
  Type,
} from 'lucide-react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import {
  createWhiteboardElement,
  parseWhiteboardDocument,
  updateWhiteboardElement,
  type WhiteboardDocument,
  type WhiteboardElement,
  type WhiteboardElementType,
} from './model.js';
import { whiteboardSvg } from './svg.js';
import { WhiteboardPreview } from './WhiteboardPreview.js';

/**
 * Whiteboard face: the interactive inert-SVG preview fills the node body; the
 * shape toolbar, per-element editor, SVG export, and agent-context sharing live
 * in a node-anchored popover.
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
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const selected = activeElements.find((element) => element.id === selectedId) ?? null;
  const agents = session.nodeRoster.filter((entry) => entry.kind === 'agent' && !entry.locked);
  const [targetAgentId, setTargetAgentId] = useState(agents[0]?.id ?? '');

  useEffect(() => {
    if (!agents.some((agent) => agent.id === targetAgentId)) {
      setTargetAgentId(agents[0]?.id ?? '');
    }
  }, [agents, targetAgentId]);

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

  const changeSelected = (patch: Partial<WhiteboardElement>): void => {
    if (readOnly || selected === null) return;
    persist(updateWhiteboardElement(document, selected.id, patch), undefined);
  };

  const exportImage = async (): Promise<void> => {
    if (exporting || activeElements.length === 0) return;
    setExporting(true);
    setNotice(null);
    try {
      const result = await window.forgeboard.whiteboard.exportSvg({
        fileName: exportFileName(data.title),
        svg: whiteboardSvg(document),
      });
      if (!result.ok) throw new Error(result.error.message);
      setNotice(result.value === null ? 'Export cancelled.' : `Exported ${result.value.fileName}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The whiteboard could not be exported.');
    } finally {
      setExporting(false);
    }
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

            {selected !== null ? (
              <section className="whiteboard-face-element" aria-label="Selected whiteboard element">
                <strong>{selected.type}</strong>
                <div className="whiteboard-face-number-grid">
                  {(['x', 'y', 'width', 'height'] as const).map((field) => (
                    <label key={field}>
                      {field}
                      <input
                        type="number"
                        name={`whiteboard-face-${field}`}
                        value={selected[field]}
                        readOnly={readOnly}
                        min={field === 'width' || field === 'height' ? 1 : -4000}
                        max={4000}
                        onFocus={() => session.recordHistory()}
                        onChange={(event) => changeSelected({ [field]: Number(event.target.value) })}
                      />
                    </label>
                  ))}
                </div>
                {selected.type === 'text' ? (
                  <label>
                    Text
                    <textarea
                      name="whiteboard-face-selected-text"
                      rows={2}
                      value={selected.text ?? ''}
                      readOnly={readOnly}
                      onFocus={() => session.recordHistory()}
                      onChange={(event) =>
                        changeSelected({
                          text: event.target.value.slice(0, 20_000),
                          originalText: event.target.value.slice(0, 20_000),
                        })
                      }
                    />
                  </label>
                ) : null}
                <div className="whiteboard-face-color-grid">
                  <label>
                    Stroke
                    <input
                      type="color"
                      name="whiteboard-face-stroke"
                      value={selected.strokeColor}
                      disabled={readOnly}
                      onFocus={() => session.recordHistory()}
                      onChange={(event) => changeSelected({ strokeColor: event.target.value })}
                    />
                  </label>
                  {selected.type !== 'arrow' && selected.type !== 'text' ? (
                    <label>
                      Fill
                      <input
                        type="color"
                        name="whiteboard-face-fill"
                        value={selected.backgroundColor}
                        disabled={readOnly}
                        onFocus={() => session.recordHistory()}
                        onChange={(event) => changeSelected({ backgroundColor: event.target.value })}
                      />
                    </label>
                  ) : null}
                </div>
              </section>
            ) : null}

            <section className="whiteboard-face-context" aria-label="Share whiteboard with an agent">
              <strong>
                <Link2 size={12} aria-hidden="true" /> Agent context
              </strong>
              {agents.length === 0 ? (
                <small>Add and unlock an Agent node to share this whiteboard.</small>
              ) : (
                <>
                  <label>
                    Agent
                    <select
                      name={`node-${id}-whiteboard-face-agent`}
                      value={targetAgentId}
                      onChange={(event) => setTargetAgentId(event.target.value)}
                    >
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={targetAgentId === ''}
                    onClick={() => setNotice(session.attachWhiteboardContext(id, targetAgentId))}
                  >
                    Attach specification
                  </button>
                </>
              )}
            </section>

            <button
              type="button"
              disabled={activeElements.length === 0 || exporting}
              onClick={() => void exportImage()}
            >
              <Download size={13} aria-hidden="true" /> {exporting ? 'Exporting…' : 'Export SVG image'}
            </button>
            {notice !== null ? <small role="status">{notice}</small> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function exportFileName(title: string): string {
  const safe = title
    .trim()
    .replace(/[^A-Za-z0-9._ -]/gu, '-')
    .slice(0, 150);
  return `${safe === '' ? 'whiteboard' : safe}.svg`;
}
