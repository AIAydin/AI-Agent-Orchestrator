import { Boxes } from 'lucide-react';

import type { WorkshopNode } from './CanvasNode.js';

interface GroupFrameInspectorProps {
  readonly node: WorkshopNode;
  readonly nodes: readonly WorkshopNode[];
  readonly onRecord: () => void;
  readonly onUpdate: (data: Partial<WorkshopNode['data']>) => void;
}

export function GroupFrameInspector({ node, nodes, onRecord, onUpdate }: GroupFrameInspectorProps) {
  const childIds = new Set(stringIds(node.data.childNodeIds));
  const candidates = nodes.filter(
    (candidate) => candidate.id !== node.id && candidate.data.kind !== 'group-frame',
  );
  return (
    <section className="workflow-node-config" aria-label="Group run configuration">
      <header>
        <div>
          <Boxes size={14} aria-hidden="true" />
          <h3>Group members</h3>
        </div>
        <span>{childIds.size}</span>
      </header>
      <p>Select the nodes this frame owns. Run selected will execute its runnable members.</p>
      <fieldset className="workflow-check-list">
        <legend>Canvas nodes</legend>
        {candidates.length === 0 ? (
          <p>Add nodes to the canvas before configuring this group.</p>
        ) : (
          candidates.map((candidate) => (
            <label key={candidate.id}>
              <input
                type="checkbox"
                name={`group-${node.id}-member-${candidate.id}`}
                checked={childIds.has(candidate.id)}
                onFocus={onRecord}
                onChange={(event) => {
                  const next = new Set(childIds);
                  if (event.target.checked) next.add(candidate.id);
                  else next.delete(candidate.id);
                  onUpdate({ childNodeIds: [...next].sort() });
                }}
              />
              <span>
                <strong>{candidate.data.title}</strong>
                <small>{candidate.data.kind}</small>
              </span>
            </label>
          ))
        )}
      </fieldset>
    </section>
  );
}

function stringIds(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}
