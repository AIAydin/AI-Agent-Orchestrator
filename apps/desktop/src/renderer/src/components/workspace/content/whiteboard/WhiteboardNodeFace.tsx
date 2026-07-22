import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Download, Link2, Shapes, Trash2 } from 'lucide-react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { WhiteboardCanvas } from './drawing/WhiteboardCanvas.js';
import { WhiteboardTextEditor } from './drawing/WhiteboardTextEditor.js';
import { WhiteboardToolStrip } from './drawing/WhiteboardToolStrip.js';
import { useWhiteboardDrawing } from './drawing/useWhiteboardDrawing.js';
import {
  parseWhiteboardDocument,
  updateWhiteboardElement,
  type WhiteboardDocument,
  type WhiteboardElement,
} from './model.js';
import { whiteboardSvg } from './svg.js';

/**
 * Whiteboard face: the drawing canvas fills the node body and the header strip selects the
 * active tool. The Tools popover holds everything that is not a drawing gesture — the
 * per-element editor, colours, agent-context sharing, and SVG export.
 */
export function WhiteboardNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const document = useMemo(() => parseWhiteboardDocument(data.excalidraw), [data.excalidraw]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const body = useRef<HTMLDivElement | null>(null);
  const agents = session.nodeRoster.filter((entry) => entry.kind === 'agent' && !entry.locked);
  const [targetAgentId, setTargetAgentId] = useState(agents[0]?.id ?? '');
  const annotationIds = useMemo(() => data.annotationIds ?? [], [data.annotationIds]);

  useEffect(() => {
    if (!agents.some((agent) => agent.id === targetAgentId)) {
      setTargetAgentId(agents[0]?.id ?? '');
    }
  }, [agents, targetAgentId]);

  const persist = useCallback(
    (next: WhiteboardDocument, nextAnnotationIds: readonly string[] | undefined): void => {
      session.updateNodeData(id, {
        excalidraw: next,
        annotationIds:
          nextAnnotationIds === undefined ? [...annotationIds] : [...nextAnnotationIds],
      });
    },
    [annotationIds, id, session],
  );

  const recordHistory = useCallback((): void => {
    session.recordHistory();
  }, [session]);

  const drawing = useWhiteboardDrawing({
    document,
    annotationIds,
    readOnly,
    onRecordHistory: recordHistory,
    onPersist: persist,
  });

  const activeElements = document.elements.filter((element) => !element.isDeleted);
  const selected = activeElements.find((element) => element.id === drawing.selectedId) ?? null;

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
        <WhiteboardToolStrip
          tool={drawing.tool}
          readOnly={readOnly}
          onSelectTool={drawing.setTool}
        />
        <button
          type="button"
          aria-label="Whiteboard tools"
          aria-expanded={toolsOpen}
          disabled={readOnly}
          onClick={() => {
            setToolsOpen((open) => !open);
          }}
        >
          <Shapes size={12} aria-hidden="true" /> Tools
        </button>
      </div>
      <div className="node-face-body nowheel nodrag" ref={body}>
        <WhiteboardCanvas
          drawing={drawing}
          readOnly={readOnly}
          className="whiteboard-face-canvas"
        />
        {drawing.textDraft === null ? null : (
          <WhiteboardTextEditor
            draft={drawing.textDraft}
            name={`node-${id}-whiteboard-text`}
            surface={body.current}
            onChange={drawing.changeText}
            onCommit={drawing.commitText}
            onCancel={drawing.cancelText}
          />
        )}
        {toolsOpen && !readOnly ? (
          <div className="node-face-popover" role="dialog" aria-label="Whiteboard tools">
            {selected === null ? (
              <small>Select an element on the canvas to edit it precisely.</small>
            ) : (
              <section className="whiteboard-face-element" aria-label="Selected whiteboard element">
                <strong>
                  {selected.type}
                  <button
                    type="button"
                    aria-label="Delete selected element"
                    onClick={drawing.deleteSelected}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </strong>
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
                        onFocus={recordHistory}
                        onChange={(event) => {
                          changeSelected({ [field]: Number(event.target.value) });
                        }}
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
                      onFocus={recordHistory}
                      onChange={(event) => {
                        changeSelected({
                          text: event.target.value.slice(0, 20_000),
                          originalText: event.target.value.slice(0, 20_000),
                        });
                      }}
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
                      onFocus={recordHistory}
                      onChange={(event) => {
                        changeSelected({ strokeColor: event.target.value });
                      }}
                    />
                  </label>
                  {selected.type === 'rectangle' ||
                  selected.type === 'ellipse' ||
                  selected.type === 'diamond' ? (
                    <label>
                      Fill
                      <input
                        type="color"
                        name="whiteboard-face-fill"
                        value={selected.backgroundColor}
                        disabled={readOnly}
                        onFocus={recordHistory}
                        onChange={(event) => {
                          changeSelected({ backgroundColor: event.target.value });
                        }}
                      />
                    </label>
                  ) : null}
                </div>
              </section>
            )}

            <section
              className="whiteboard-face-context"
              aria-label="Share whiteboard with an agent"
            >
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
                      onChange={(event) => {
                        setTargetAgentId(event.target.value);
                      }}
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
                    onClick={() => {
                      setNotice(session.attachWhiteboardContext(id, targetAgentId));
                    }}
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
              <Download size={13} aria-hidden="true" />{' '}
              {exporting ? 'Exporting…' : 'Export SVG image'}
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
