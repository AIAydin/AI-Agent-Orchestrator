import { Boxes } from 'lucide-react';

import type { WorkshopNode } from './CanvasNode.js';

interface GroupFrameInspectorProps {
  readonly node: WorkshopNode;
  readonly nodes: readonly WorkshopNode[];
  readonly onRecord: () => void;
  readonly onUpdate: (data: Partial<WorkshopNode['data']>) => void;
  readonly onFit: () => void;
  readonly onArrange: (layout: FrameLayout) => void;
}

type FrameLayout = NonNullable<WorkshopNode['data']['layout']>;
type FramePurpose = NonNullable<WorkshopNode['data']['purpose']>;

export function GroupFrameInspector({
  node,
  nodes,
  onRecord,
  onUpdate,
  onFit,
  onArrange,
}: GroupFrameInspectorProps) {
  const childIds = new Set(stringIds(node.data.childNodeIds));
  const purpose = node.data.purpose ?? 'custom';
  const layout = node.data.layout ?? 'freeform';
  const hasMembers = childIds.size > 0;
  const canArrange = hasMembers && layout !== 'freeform';
  const protectedChildIds = new Set(
    nodes
      .filter(
        (candidate) =>
          candidate.id !== node.id &&
          candidate.data.kind === 'group-frame' &&
          candidate.data.locked,
      )
      .flatMap((candidate) => stringIds(candidate.data.childNodeIds)),
  );
  const candidates = nodes.filter(
    (candidate) => candidate.id !== node.id && candidate.data.kind !== 'group-frame',
  );
  const updateConfiguration = (data: Partial<WorkshopNode['data']>) => {
    onRecord();
    onUpdate(data);
  };
  return (
    <section className="workflow-node-config" aria-label="Group settings">
      <header>
        <div>
          <Boxes size={14} aria-hidden="true" />
          <h3>Group</h3>
        </div>
        <span>
          {childIds.size} {childIds.size === 1 ? 'member' : 'members'}
        </span>
      </header>
      <p>
        Choose how this group organizes its members. Run selected runs only the members that can
        run.
      </p>
      <fieldset className="workflow-command-editor">
        <legend>Group behavior</legend>
        <div className="workflow-retry-grid">
          <label>
            Group purpose
            <select
              name={`group-${node.id}-purpose`}
              value={purpose}
              onChange={(event) =>
                updateConfiguration({ purpose: event.currentTarget.value as FramePurpose })
              }
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
              name={`group-${node.id}-layout`}
              value={layout}
              onChange={(event) =>
                updateConfiguration({ layout: event.currentTarget.value as FrameLayout })
              }
            >
              <option value="freeform">Freeform</option>
              <option value="horizontal">Horizontal</option>
              <option value="vertical">Vertical</option>
              <option value="grid">Grid</option>
            </select>
          </label>
        </div>
        <label className="workflow-toggle">
          <input
            type="checkbox"
            name={`group-${node.id}-auto-fit`}
            checked={node.data.autoFit ?? false}
            onChange={(event) => updateConfiguration({ autoFit: event.currentTarget.checked })}
          />
          <span>
            <strong>Automatically fit the group to its members</strong>
            <small>Resize the group when its members change, move, or resize.</small>
          </span>
        </label>
        <div className="workflow-retry-grid" role="group" aria-label="Group layout actions">
          <button className="button" type="button" disabled={!hasMembers} onClick={onFit}>
            Fit to members
          </button>
          <button
            className="button"
            type="button"
            disabled={!canArrange}
            onClick={() => {
              if (!canArrange) return;
              onArrange(layout);
            }}
          >
            Arrange members
          </button>
        </div>
        <small>{layoutActionExplanation(layout, hasMembers)}</small>
      </fieldset>
      <fieldset className="workflow-check-list">
        <legend>Group members</legend>
        {candidates.length === 0 ? (
          <p>Add nodes to the canvas before choosing members for this group.</p>
        ) : (
          candidates.map((candidate) => {
            const membershipLocked = candidate.data.locked || protectedChildIds.has(candidate.id);
            return (
              <label
                key={candidate.id}
                title={
                  membershipLocked ? 'Unlock this node or its current group first.' : undefined
                }
              >
                <input
                  type="checkbox"
                  name={`group-${node.id}-member-${candidate.id}`}
                  checked={childIds.has(candidate.id)}
                  disabled={membershipLocked}
                  onChange={(event) => {
                    const next = new Set(childIds);
                    if (event.target.checked) next.add(candidate.id);
                    else next.delete(candidate.id);
                    updateConfiguration({ childNodeIds: [...next].sort() });
                  }}
                />
                <span>
                  <strong>{candidate.data.title}</strong>
                  <small>
                    {membershipLocked ? `${candidate.data.kind} · locked` : candidate.data.kind}
                  </small>
                </span>
              </label>
            );
          })
        )}
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
