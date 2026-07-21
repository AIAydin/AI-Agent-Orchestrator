import type { JSX } from 'react';
import { Boxes } from 'lucide-react';

import type { WorkshopNodeData } from './CanvasNode.js';
import type { NodeFaceProps } from './faces/node-face-registry.js';
import { useCanvasNodeInteractions } from './interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../runs/agent-session/AgentSessionContext.js';

type FrameLayout = NonNullable<WorkshopNodeData['layout']>;
type FramePurpose = NonNullable<WorkshopNodeData['purpose']>;

/**
 * Group-frame face: the fit/arrange/layout controls that used to live in the
 * inspector. Purpose, member layout, and auto-fit edit in place; fit and arrange
 * run through the session context, which applies them on the full canvas graph.
 * Member selection stays in the inspector until the graph is threaded to faces.
 */
export function GroupFrameNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const purpose = data.purpose ?? 'custom';
  const layout = data.layout ?? 'freeform';
  const memberCount = stringIds(data.childNodeIds).length;
  const hasMembers = memberCount > 0;
  const canArrange = hasMembers && layout !== 'freeform';

  const update = (patch: Partial<WorkshopNodeData>): void => {
    session.recordHistory();
    session.updateNodeData(id, patch);
  };

  return (
    <section className="node-face group-frame-node-face" aria-label="Group">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <Boxes size={12} aria-hidden="true" /> Group
        </span>
        <span className="node-face-status" role="status">
          {memberCount} {memberCount === 1 ? 'member' : 'members'}
        </span>
      </div>
      <fieldset className="node-face-body nowheel nodrag" disabled={readOnly}>
        <div className="task-face-grid">
          <label>
            Group purpose
            <select
              name={`group-${id}-face-purpose`}
              aria-label="Group purpose"
              value={purpose}
              disabled={readOnly}
              onChange={(event) => update({ purpose: event.currentTarget.value as FramePurpose })}
            >
              <option value="product-surface">Part of the product</option>
              <option value="workflow-stage">Workflow step</option>
              <option value="feature-area">Feature area</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>
            Member layout
            <select
              name={`group-${id}-face-layout`}
              aria-label="Member layout"
              value={layout}
              disabled={readOnly}
              onChange={(event) => update({ layout: event.currentTarget.value as FrameLayout })}
            >
              <option value="freeform">Freeform</option>
              <option value="horizontal">Horizontal</option>
              <option value="vertical">Vertical</option>
              <option value="grid">Grid</option>
            </select>
          </label>
        </div>
        <label className="group-frame-face-toggle">
          <input
            type="checkbox"
            name={`group-${id}-face-auto-fit`}
            checked={data.autoFit ?? false}
            disabled={readOnly}
            onChange={(event) => update({ autoFit: event.currentTarget.checked })}
          />
          <span>Automatically fit the group to its members</span>
        </label>
        <div className="node-face-row" role="group" aria-label="Group layout actions">
          <button
            type="button"
            disabled={readOnly || !hasMembers}
            onClick={() => session.fitGroupFrame(id)}
          >
            Fit to members
          </button>
          <button
            type="button"
            disabled={readOnly || !canArrange}
            onClick={() => {
              if (!canArrange) return;
              session.arrangeGroupFrame(id, layout);
            }}
          >
            Arrange members
          </button>
        </div>
        <small className="group-frame-face-hint">
          {layoutActionExplanation(layout, hasMembers)}
        </small>
      </fieldset>
    </section>
  );
}

function stringIds(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function layoutActionExplanation(layout: FrameLayout, hasMembers: boolean): string {
  if (!hasMembers) return 'Add at least one member before fitting or arranging this group.';
  if (layout === 'freeform') {
    return 'Freeform keeps members where they are. Choose another layout to line them up.';
  }
  return `Arrange members applies the ${layout} layout. Fit to members only resizes the group around its current members.`;
}
