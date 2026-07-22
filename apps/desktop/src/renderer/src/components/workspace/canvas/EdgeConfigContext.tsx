import { createContext, useContext } from 'react';

import type { WorkshopNode } from './CanvasNode.js';
import type { EdgeKind } from '../model/types.js';
import type { WorkshopEdgeData } from '../model/edge-config.js';

/**
 * Bridges the edge-editing callbacks (which live in `Workspace` and act on the
 * currently selected edge) down to the custom edge component rendered inside
 * `<ReactFlow>`. React Flow does not forward arbitrary props to edge
 * components, so a context is the standard way to reach them. The popover is
 * only shown for the selected edge, so `onUpdateEdgeType` / `onUpdateEdgeData`
 * — the same handlers the sidebar inspector uses — always target that edge.
 */
export interface EdgeConfigContextValue {
  readonly nodes: readonly WorkshopNode[];
  readonly graphReadOnly: boolean;
  readonly onUpdateEdgeType: (edgeType: EdgeKind) => void;
  readonly onUpdateEdgeData: (data: WorkshopEdgeData) => void;
}

const EdgeConfigContext = createContext<EdgeConfigContextValue | null>(null);

export const EdgeConfigProvider = EdgeConfigContext.Provider;

export function useEdgeConfig(): EdgeConfigContextValue | null {
  return useContext(EdgeConfigContext);
}
