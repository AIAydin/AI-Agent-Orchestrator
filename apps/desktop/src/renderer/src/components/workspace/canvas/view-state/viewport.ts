import type { Viewport } from '@xyflow/react';

export const CANVAS_MIN_ZOOM = 0.15;
export const CANVAS_MAX_ZOOM = 2.5;
export const CANVAS_MAX_OFFSET = 10_000_000;

export function normalizeCanvasViewport(viewport: Viewport): Viewport {
  return {
    x: boundedFinite(viewport.x, -CANVAS_MAX_OFFSET, CANVAS_MAX_OFFSET, 0),
    y: boundedFinite(viewport.y, -CANVAS_MAX_OFFSET, CANVAS_MAX_OFFSET, 0),
    zoom: boundedFinite(viewport.zoom, CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM, 1),
  };
}

export function sameCanvasViewport(left: Viewport, right: Viewport): boolean {
  return left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

function boundedFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
