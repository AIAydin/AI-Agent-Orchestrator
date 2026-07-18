import { ArrowRight, Circle, Diamond, Download, Link2, Square, Trash2, Type } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import {
  createWhiteboardElement,
  parseWhiteboardDocument,
  updateWhiteboardElement,
  type WhiteboardDocument,
  type WhiteboardElement,
  type WhiteboardElementType,
} from './model.js';
import { whiteboardSvg } from './svg.js';
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
          Create an explicit Context connection. Forgeboard discloses a normalized visual
          specification before the selected agent starts. Embedded files, data URLs, links,
          bindings, and opaque custom fields are excluded.
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

function WhiteboardPreview({
  document,
  selectedId,
  onSelect,
}: {
  readonly document: WhiteboardDocument;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <svg
      className="whiteboard-preview"
      role="img"
      aria-label="Inert whiteboard preview"
      viewBox="0 0 960 640"
      style={{ background: document.appState.viewBackgroundColor }}
    >
      {document.elements
        .filter((element) => !element.isDeleted)
        .map((element) => (
          <PreviewElement
            key={element.id}
            element={element}
            selected={selectedId === element.id}
            onSelect={() => onSelect(element.id)}
          />
        ))}
    </svg>
  );
}

function PreviewElement({
  element,
  selected,
  onSelect,
}: {
  readonly element: WhiteboardElement;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const common = {
    fill: element.backgroundColor,
    stroke: element.strokeColor,
    strokeWidth: element.strokeWidth,
    opacity: element.opacity / 100,
    strokeDasharray: selected ? '6 4' : undefined,
    onClick: onSelect,
  };
  if (element.type === 'rectangle') {
    return (
      <rect
        {...common}
        x={element.x}
        y={element.y}
        width={element.width}
        height={element.height}
        rx={6}
      />
    );
  }
  if (element.type === 'ellipse') {
    return (
      <ellipse
        {...common}
        cx={element.x + element.width / 2}
        cy={element.y + element.height / 2}
        rx={element.width / 2}
        ry={element.height / 2}
      />
    );
  }
  if (element.type === 'diamond') {
    return <polygon {...common} points={diamondPoints(element)} />;
  }
  if (element.type === 'arrow') {
    return <ArrowElement element={element} selected={selected} onSelect={onSelect} />;
  }
  return (
    <text
      x={element.x}
      y={element.y + (element.fontSize ?? 20)}
      fill={element.strokeColor}
      fontFamily="system-ui, sans-serif"
      fontSize={element.fontSize ?? 20}
      opacity={element.opacity / 100}
      stroke={selected ? element.strokeColor : 'none'}
      strokeDasharray={selected ? '6 4' : undefined}
      onClick={onSelect}
    >
      {element.text ?? ''}
    </text>
  );
}

function ArrowElement({
  element,
  selected,
  onSelect,
}: {
  readonly element: WhiteboardElement;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const endX = element.x + element.width;
  const endY = element.y + element.height;
  const angle = Math.atan2(element.height, element.width);
  const arrowPoint = (offset: number): string =>
    `${String(endX - 14 * Math.cos(angle + offset))},${String(endY - 14 * Math.sin(angle + offset))}`;
  return (
    <g
      fill="none"
      stroke={element.strokeColor}
      strokeWidth={element.strokeWidth}
      opacity={element.opacity / 100}
      strokeDasharray={selected ? '6 4' : undefined}
      onClick={onSelect}
    >
      <line x1={element.x} y1={element.y} x2={endX} y2={endY} />
      <polyline
        points={`${arrowPoint(-Math.PI / 6)} ${String(endX)},${String(endY)} ${arrowPoint(Math.PI / 6)}`}
      />
    </g>
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
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {icon}
    </button>
  );
}

function diamondPoints(element: WhiteboardElement): string {
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  return `${String(cx)},${String(element.y)} ${String(element.x + element.width)},${String(cy)} ${String(cx)},${String(element.y + element.height)} ${String(element.x)},${String(cy)}`;
}

function exportFileName(title: string): string {
  const safe = title
    .trim()
    .replace(/[^A-Za-z0-9._ -]/gu, '-')
    .slice(0, 150);
  return `${safe === '' ? 'whiteboard' : safe}.svg`;
}
