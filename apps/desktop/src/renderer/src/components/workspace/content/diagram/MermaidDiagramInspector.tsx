import { Download, Eye, FilePenLine, PanelsTopLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { SafeSvgImage } from '../../../content/svg/SafeSvgImage.js';
import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { renderMermaidDiagram } from './mermaid-renderer.js';
import './mermaid-diagram.css';

type DiagramMode = 'edit' | 'split' | 'preview';
type DiagramRenderState =
  | { readonly source: string; readonly status: 'rendered'; readonly svg: string }
  | { readonly source: string; readonly status: 'error'; readonly message: string };

interface MermaidDiagramInspectorProps {
  readonly node: WorkshopNode;
  readonly readOnly: boolean;
  readonly onRecord: () => void;
  readonly onUpdate: (data: Partial<WorkshopNode['data']>) => void;
}

export function MermaidDiagramInspector({
  node,
  readOnly,
  onRecord,
  onUpdate,
}: MermaidDiagramInspectorProps) {
  const source = node.data.mermaidSource ?? '';
  const [mode, setMode] = useState<DiagramMode>('split');
  const [renderState, setRenderState] = useState<DiagramRenderState | null>(null);
  const [exportState, setExportState] = useState<'idle' | 'saving'>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const renderSequence = useRef(0);
  const currentRender = renderState?.source === source ? renderState : null;
  const renderedSvg = currentRender?.status === 'rendered' ? currentRender.svg : null;
  const renderError = currentRender?.status === 'error' ? currentRender.message : null;

  useEffect(() => {
    const sequence = ++renderSequence.current;
    setRenderState(null);
    if (source.trim() === '') {
      return;
    }
    const timeout = window.setTimeout(() => {
      void renderMermaidDiagram(source)
        .then((svg) => {
          if (sequence !== renderSequence.current) return;
          setRenderState({ source, status: 'rendered', svg });
        })
        .catch((error: unknown) => {
          if (sequence !== renderSequence.current) return;
          setRenderState({
            source,
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'This Mermaid diagram could not be rendered.',
          });
        });
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [source]);

  const exportSvg = async (): Promise<void> => {
    if (renderedSvg === null || exportState === 'saving') return;
    setExportState('saving');
    setNotice(null);
    try {
      const result = await window.forgeboard.diagram.exportSvg({
        fileName: diagramFileName(node.data.title),
        svg: renderedSvg,
      });
      if (!result.ok) throw new Error(result.error.message);
      setNotice(result.value === null ? 'Export cancelled.' : `Exported ${result.value.fileName}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The diagram could not be exported.');
    } finally {
      setExportState('idle');
    }
  };

  return (
    <section className={`mermaid-diagram mode-${mode}`} aria-label="Mermaid diagram settings">
      <header>
        <strong>Mermaid diagram</strong>
        <div role="tablist" aria-label="Diagram view">
          <ModeButton
            mode="edit"
            current={mode}
            label="Edit"
            onSelect={setMode}
            icon={<FilePenLine size={13} />}
          />
          <ModeButton
            mode="split"
            current={mode}
            label="Split"
            onSelect={setMode}
            icon={<PanelsTopLeft size={13} />}
          />
          <ModeButton
            mode="preview"
            current={mode}
            label="Preview"
            onSelect={setMode}
            icon={<Eye size={13} />}
          />
        </div>
      </header>
      <div className="mermaid-diagram-body">
        {mode === 'preview' ? null : (
          <label>
            Mermaid source
            <textarea
              name={`node-${node.id}-mermaid-source`}
              rows={14}
              value={source}
              readOnly={readOnly}
              placeholder={'flowchart LR\n  Brief --> Agent\n  Agent --> Review'}
              onFocus={onRecord}
              onChange={
                readOnly ? undefined : (event) => onUpdate({ mermaidSource: event.target.value })
              }
            />
          </label>
        )}
        {mode === 'edit' ? null : (
          <div
            className="mermaid-diagram-preview"
            role="region"
            aria-label="Mermaid preview"
            aria-busy={source.trim() !== '' && renderedSvg === null && renderError === null}
          >
            {source.trim() === '' ? <p>Add Mermaid source to see a preview.</p> : null}
            {renderError !== null ? <p role="alert">{renderError}</p> : null}
            {renderedSvg !== null ? (
              <SafeSvgImage source={renderedSvg} alt={`${node.data.title} diagram`} />
            ) : null}
          </div>
        )}
      </div>
      <footer>
        <button
          type="button"
          disabled={renderedSvg === null || exportState === 'saving'}
          onClick={() => void exportSvg()}
        >
          <Download size={13} /> {exportState === 'saving' ? 'Exporting…' : 'Export SVG'}
        </button>
        {notice !== null ? <small role="status">{notice}</small> : null}
      </footer>
    </section>
  );
}

function ModeButton({
  mode,
  current,
  label,
  icon,
  onSelect,
}: {
  readonly mode: DiagramMode;
  readonly current: DiagramMode;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly onSelect: (mode: DiagramMode) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={mode === current}
      onClick={() => onSelect(mode)}
    >
      {icon}
      {label}
    </button>
  );
}

function diagramFileName(title: string): string {
  const safe = title
    .trim()
    .replace(/[^A-Za-z0-9._ -]/gu, '-')
    .slice(0, 150);
  return `${safe === '' ? 'diagram' : safe}.svg`;
}
