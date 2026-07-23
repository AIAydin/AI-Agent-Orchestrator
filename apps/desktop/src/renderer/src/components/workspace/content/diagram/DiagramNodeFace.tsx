import { useState, type JSX } from 'react';
import { Eye, FilePenLine } from 'lucide-react';

import { SafeSvgImage } from '../../../content/svg/SafeSvgImage.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { useMermaidDiagram } from './use-mermaid-diagram.js';
import './mermaid-diagram.css';

/** Diagram face: rendered Mermaid SVG with a source editor that toggles in place. */
export function DiagramNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const source = data.mermaidSource ?? '';
  const diagram = useMermaidDiagram(source);
  const [editing, setEditing] = useState(source.trim() === '');

  return (
    <section className="node-face diagram-node-face" aria-label="Mermaid diagram">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">Mermaid</span>
        <button
          type="button"
          aria-label="Edit Mermaid source"
          aria-pressed={editing}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? (
            <Eye size={12} aria-hidden="true" />
          ) : (
            <FilePenLine size={12} aria-hidden="true" />
          )}
          {editing ? 'Preview' : 'Edit'}
        </button>
        <span
          className={`node-face-status ${diagram.error === null ? '' : 'failed'}`}
          role="status"
        >
          {source.trim() === ''
            ? 'empty'
            : diagram.error !== null
              ? 'invalid'
              : diagram.rendering
                ? 'rendering'
                : 'rendered'}
        </span>
      </div>
      <div className="node-face-body nowheel nodrag">
        {editing ? (
          <textarea
            className="diagram-face-editor"
            aria-label="Mermaid source"
            name={`node-${id}-mermaid-face-source`}
            value={source}
            readOnly={readOnly}
            placeholder={'flowchart LR\n  Brief --> Agent\n  Agent --> Review'}
            onFocus={() => {
              session.recordHistory();
            }}
            onChange={
              readOnly
                ? undefined
                : (event) => session.updateNodeData(id, { mermaidSource: event.target.value })
            }
          />
        ) : (
          <div
            className="diagram-face-preview"
            role="region"
            aria-label="Mermaid preview"
            aria-busy={diagram.rendering}
          >
            {source.trim() === '' ? (
              <p className="node-face-hint">Add Mermaid source to see a diagram.</p>
            ) : null}
            {diagram.error !== null ? <p role="alert">{diagram.error}</p> : null}
            {diagram.svg !== null ? (
              <SafeSvgImage source={diagram.svg} alt={`${data.title} diagram`} />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
