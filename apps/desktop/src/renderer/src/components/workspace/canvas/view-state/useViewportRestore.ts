import { useEffect } from 'react';
import type { ReactFlowInstance, Viewport } from '@xyflow/react';

import type { WorkshopEdge } from '../../model/types.js';
import type { WorkshopNode } from '../CanvasNode.js';
import { normalizeCanvasViewport } from './viewport.js';

export function useViewportRestore(
  instance: ReactFlowInstance<WorkshopNode, WorkshopEdge> | null,
  canvasId: string | null,
  savedViewport: Viewport | null,
): void {
  useEffect(() => {
    if (instance === null || canvasId === null || savedViewport === null) return;
    void instance.setViewport(normalizeCanvasViewport(savedViewport), {
      duration: 0,
    });
  }, [canvasId, instance, savedViewport]);
}
