import { ArrowRight, Circle, Diamond, Download, Link2, Square, Trash2, Type } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { WorkspaceTooltip } from '../../shell/tooltips/WorkspaceTooltip.js';
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
import './whiteboard.css';

interface WhiteboardMockupInspectorProps {
  readonly node: WorkshopNode;
  readonly nodes: readonly WorkshopNode[];
  readonly readOnly: boolean;
  readonly onRecord: () => void;
  readonly onUpdate: (data: Partial<WorkshopNode['data']>) => void;
  readonly onAttachContext: (sourceNodeId: string, targetNodeId: string) => string;
}

export function WhiteboardMockupInspector({
  node,
  nodes,
  readOnly,
  onRecord,
  onUpdate,
  onAttachContext,
}: WhiteboardMockupInspectorProps) {
  const document = useMemo(
    () => parseWhiteboardDocument(node.data.excalidraw),
    [node.data.excalidraw],
  );
  const activeElements = document.elements.filter((element) => !element.isDeleted);
  const [selectedId, setSelectedId] = useState<string | null>(activeElements[0]?.id ?? null);
  const [annotation, setAnnotation] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const agents = nodes.filter(
    (candidate) => candidate.data.kind === 'agent' && !candidate.data.locked,
  );
  const [targetAgentId, setTargetAgentId] = useState(agents[0]?.id ?? '');
  const selected = activeElements.find((element) => element.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId !== null && !activeElements.some((element) => element.id === selectedId)) {
      setSelectedId(activeElements[0]?.id ?? null);
    }
  }, [activeElements, selectedId]);

  useEffect(() => {
    if (!agents.some((agent) => agent.id === targetAgentId)) setTargetAgentId(agents[0]?.id ?? '');
  }, [agents, targetAgentId]);

  const persist = (
    next: WhiteboardDocument,
    annotationIds = node.data.annotationIds ?? [],
  ): void => {
    onUpdate({ excalidraw: next, annotationIds });
  };

  const addElement = (type: WhiteboardElementType, text = ''): void => {
    if (readOnly) return;
    onRecord();
    const element = createWhiteboardElement(type, activeElements.length, text);
    persist(
      { ...document, elements: [...document.elements, element] },
      type === 'text' ? [...(node.data.annotationIds ?? []), element.id] : node.data.annotationIds,
    );
    setSelectedId(element.id);
    setAnnotation('');
  };

  const exportImage = async (): Promise<void> => {
    if (exporting || activeElements.length === 0) return;
    setExporting(true);
    setNotice(null);
    try {
      const result = await window.forgeboard.whiteboard.exportSvg({
        fileName: exportFileName(node.data.title),
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
    <section className="whiteboard-inspector" aria-label="Whiteboard and mockup settings">
      <header>
        <div>
          <strong>Whiteboard</strong>
          <small>Excalidraw-compatible document · {activeElements.length} elements</small>
        </div>
        <div className="whiteboard-tools" aria-label="Whiteboard tools">
          <ToolButton
            label="Add rectangle"
            icon={<Square size={13} />}
            disabled={readOnly}
            onClick={() => addElement('rectangle')}
          />
          <ToolButton
            label="Add ellipse"
            icon={<Circle size={13} />}
            disabled={readOnly}
            onClick={() => addElement('ellipse')}
          />
          <ToolButton
            label="Add diamond"
            icon={<Diamond size={13} />}
            disabled={readOnly}
            onClick={() => addElement('diamond')}
          />
          <ToolButton
            label="Add arrow"
            icon={<ArrowRight size={13} />}
            disabled={readOnly}
            onClick={() => addElement('arrow')}
          />
        </div>
      </header>

      <WhiteboardPreview document={document} selectedId={selectedId} onSelect={setSelectedId} />

      <div className="whiteboard-annotation-editor">
        <label>
          Annotation
          <input
            name={`node-${node.id}-whiteboard-annotation`}
            value={annotation}
            disabled={readOnly}
            maxLength={20_000}
            placeholder="Describe a screen, interaction, or review note"
            onChange={(event) => setAnnotation(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={readOnly || annotation.trim() === ''}
          onClick={() => addElement('text', annotation.trim())}
        >
          <Type size={13} /> Add annotation
        </button>
      </div>

      {selected !== null ? (
        <ElementEditor
          element={selected}
          readOnly={readOnly}
          onRecord={onRecord}
          onChange={(patch) => persist(updateWhiteboardElement(document, selected.id, patch))}
          onDelete={() => {
            if (readOnly) return;
            onRecord();
            persist(
              {
                ...document,
                elements: document.elements.map((element) =>
                  element.id === selected.id
                    ? {
                        ...element,
                        isDeleted: true,
                        version: element.version + 1,
                        updated: Date.now(),
                      }
                    : element,
                ),
              },
              (node.data.annotationIds ?? []).filter((id) => id !== selected.id),
            );
          }}
        />
      ) : null}

      <section className="whiteboard-context" aria-label="Share whiteboard with an agent">
        <header>
          <Link2 size={13} />
          <strong>Agent context</strong>
        </header>
        <p>
          Creates an explicit Context connection. You review the visual spec before the agent
          starts. Embedded files, data URLs, links, bindings, and custom fields are never included.
        </p>
        {agents.length === 0 ? (
          <small>Add and unlock an Agent node to share this whiteboard.</small>
        ) : (
          <div>
            <label>
              Agent
              <select
                name={`node-${node.id}-whiteboard-agent`}
                value={targetAgentId}
                disabled={readOnly}
                onChange={(event) => setTargetAgentId(event.target.value)}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.data.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={readOnly || targetAgentId === ''}
              onClick={() => setNotice(onAttachContext(node.id, targetAgentId))}
            >
              Attach specification
            </button>
          </div>
        )}
      </section>

      <footer>
        <button
          type="button"
          disabled={activeElements.length === 0 || exporting}
          onClick={() => void exportImage()}
        >
          <Download size={13} /> {exporting ? 'Exporting…' : 'Export SVG image'}
        </button>
        {notice !== null ? <small role="status">{notice}</small> : null}
      </footer>
    </section>
  );
}

function ElementEditor({
  element,
  readOnly,
  onRecord,
  onChange,
  onDelete,
}: {
  readonly element: WhiteboardElement;
  readonly readOnly: boolean;
  readonly onRecord: () => void;
  readonly onChange: (patch: Partial<WhiteboardElement>) => void;
  readonly onDelete: () => void;
}) {
  return (
    <section className="whiteboard-element-editor" aria-label="Selected whiteboard element">
      <header>
        <strong>{element.type}</strong>
        <button
          type="button"
          disabled={readOnly}
          aria-label="Delete selected element"
          onClick={onDelete}
        >
          <Trash2 size={13} />
        </button>
      </header>
      <div className="whiteboard-number-grid">
        {(['x', 'y', 'width', 'height'] as const).map((field) => (
          <label key={field}>
            {field}
            <input
              type="number"
              name={`whiteboard-${field}`}
              value={element[field]}
              readOnly={readOnly}
              min={field === 'width' || field === 'height' ? 1 : -4000}
              max={4000}
              onFocus={onRecord}
              onChange={(event) => onChange({ [field]: Number(event.target.value) })}
            />
          </label>
        ))}
      </div>
      {element.type === 'text' ? (
        <label>
          Text
          <textarea
            name="whiteboard-selected-text"
            rows={3}
            value={element.text ?? ''}
            readOnly={readOnly}
            onFocus={onRecord}
            onChange={(event) =>
              onChange({
                text: event.target.value.slice(0, 20_000),
                originalText: event.target.value.slice(0, 20_000),
              })
            }
          />
        </label>
      ) : null}
      <div className="whiteboard-color-grid">
        <label>
          Stroke
          <input
            type="color"
            name="whiteboard-stroke"
            value={element.strokeColor}
            disabled={readOnly}
            onFocus={onRecord}
            onChange={(event) => onChange({ strokeColor: event.target.value })}
          />
        </label>
        {element.type !== 'arrow' && element.type !== 'text' ? (
          <label>
            Fill
            <input
              type="color"
              name="whiteboard-fill"
              value={element.backgroundColor}
              disabled={readOnly}
              onFocus={onRecord}
              onChange={(event) => onChange({ backgroundColor: event.target.value })}
            />
          </label>
        ) : null}
      </div>
    </section>
  );
}

function ToolButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <WorkspaceTooltip content={disabled ? `${label} unavailable while editing is locked` : label}>
      <button type="button" aria-label={label} disabled={disabled} onClick={onClick}>
        {icon}
      </button>
    </WorkspaceTooltip>
  );
}

function exportFileName(title: string): string {
  const safe = title
    .trim()
    .replace(/[^A-Za-z0-9._ -]/gu, '-')
    .slice(0, 150);
  return `${safe === '' ? 'whiteboard' : safe}.svg`;
}
