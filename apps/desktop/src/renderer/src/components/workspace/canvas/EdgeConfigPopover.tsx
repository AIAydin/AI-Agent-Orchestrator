import { Lock } from 'lucide-react';

import type { WorkshopNode } from './CanvasNode.js';
import type { EdgeKind, WorkshopEdge } from '../model/types.js';
import { createEdgeData, type WorkshopEdgeData } from '../model/edge-config.js';
import { EdgeConfiguration, EdgeTypeField } from './edge-config-controls.js';

interface EdgeConfigPopoverProps {
  edge: WorkshopEdge;
  nodes: readonly WorkshopNode[];
  readOnly?: boolean;
  onUpdateType: (edgeType: EdgeKind) => void;
  onUpdateData: (data: WorkshopEdgeData) => void;
}

/**
 * On-canvas counterpart to `TypedEdgeInspector`: the same edge type selector
 * and typed-edge-data fields, rendered in a small popover anchored on the
 * selected edge. `nowheel nodrag` keep scroll and pointer interactions inside
 * the popover instead of panning/dragging the canvas.
 */
export function EdgeConfigPopover({
  edge,
  nodes,
  readOnly = false,
  onUpdateType,
  onUpdateData,
}: EdgeConfigPopoverProps) {
  const data = edge.data ?? createEdgeData('context', edge.source);
  return (
    <div
      className="edge-config-popover nowheel nodrag"
      // Stop canvas selection/drag handlers from stealing clicks inside the popover.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {readOnly ? (
        <p className="node-lock-notice" role="status">
          <Lock size={13} />
          This connection is linked to a locked node. Unlock both nodes to change it.
        </p>
      ) : null}
      <fieldset className="node-edit-fields" disabled={readOnly} aria-label="Connection settings">
        <EdgeTypeField edge={edge} data={data} onUpdateType={onUpdateType} />
        <EdgeConfiguration data={data} edge={edge} nodes={nodes} onChange={onUpdateData} />
      </fieldset>
    </div>
  );
}
