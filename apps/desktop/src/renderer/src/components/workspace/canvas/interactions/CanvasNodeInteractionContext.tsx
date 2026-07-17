import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { WorkshopNode } from '../CanvasNode.js';

export interface CanvasNodeInteractions {
  readonly readOnly: boolean;
  readonly setCollapsed: (nodeId: string, collapsed: boolean) => void;
  readonly onResizeStart?: (nodeId: string) => void;
}

const SAFE_READ_ONLY_INTERACTIONS: CanvasNodeInteractions = Object.freeze({
  readOnly: true,
  setCollapsed: () => undefined,
  onResizeStart: () => undefined,
});

const CanvasNodeInteractionContext = createContext<CanvasNodeInteractions>(
  SAFE_READ_ONLY_INTERACTIONS,
);

export function CanvasNodeInteractionProvider({
  children,
  readOnly,
  setCollapsed,
  onResizeStart,
}: {
  readonly children: ReactNode;
  readonly readOnly: boolean;
  readonly setCollapsed: (nodeId: string, collapsed: boolean) => void;
  readonly onResizeStart?: ((nodeId: string) => void) | undefined;
}) {
  const value = useMemo<CanvasNodeInteractions>(
    () => ({
      readOnly,
      setCollapsed,
      ...(onResizeStart === undefined ? {} : { onResizeStart }),
    }),
    [onResizeStart, readOnly, setCollapsed],
  );
  return (
    <CanvasNodeInteractionContext.Provider value={value}>
      {children}
    </CanvasNodeInteractionContext.Provider>
  );
}

export function useCanvasNodeInteractions(): CanvasNodeInteractions {
  return useContext(CanvasNodeInteractionContext);
}

export function setCanvasNodeCollapsed(
  nodes: WorkshopNode[],
  nodeId: string,
  collapsed: boolean,
  readOnly: boolean,
): WorkshopNode[] {
  if (readOnly) return nodes;
  const target = nodes.find((node) => node.id === nodeId);
  if (target === undefined || target.data.locked || target.data.collapsed === collapsed) {
    return nodes;
  }
  return nodes.map((node) =>
    node.id === nodeId ? { ...node, data: { ...node.data, collapsed } } : node,
  );
}
