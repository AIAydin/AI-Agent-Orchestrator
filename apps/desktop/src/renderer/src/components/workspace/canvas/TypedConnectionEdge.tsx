import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

import type { WorkshopEdge } from '../model/types.js';
import { EdgeConfigPopover } from './EdgeConfigPopover.js';
import { useEdgeConfig } from './EdgeConfigContext.js';
import { canEditEdge } from './interactions/lock-protection.js';

/**
 * Custom edge that renders the same smooth-step path as the built-in
 * `smoothstep` edge, plus — when the edge is selected — an on-canvas popover
 * for editing the connection type and its typed data. It is registered under
 * the `smoothstep` key so every existing edge (which is created with
 * `type: 'smoothstep'`) gains the popover without changing edge creation,
 * persistence, or routing.
 */
export function TypedConnectionEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
  data,
}: EdgeProps<WorkshopEdge>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const config = useEdgeConfig();

  const edge: WorkshopEdge = { id, source, target, ...(data === undefined ? {} : { data }) };
  const readOnly = config === null || config.graphReadOnly || !canEditEdge(edge, config.nodes);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        {...(style === undefined ? {} : { style })}
      />
      {selected && config !== null ? (
        <EdgeLabelRenderer>
          <div
            className="edge-config-popover-anchor"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <EdgeConfigPopover
              edge={edge}
              nodes={config.nodes}
              readOnly={readOnly}
              onUpdateType={config.onUpdateEdgeType}
              onUpdateData={config.onUpdateEdgeData}
            />
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
