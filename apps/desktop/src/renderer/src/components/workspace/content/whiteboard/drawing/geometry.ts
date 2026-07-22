import {
  MAX_POINTS_PER_STROKE,
  MIN_ELEMENT_SIZE,
  VIEW_BOX_HEIGHT,
  VIEW_BOX_WIDTH,
  type WhiteboardBounds,
  type WhiteboardElement,
  type WhiteboardPoint,
} from '../model.js';

export type WhiteboardHandle = 'nw' | 'ne' | 'sw' | 'se';

/** The subset of `DOMRect` the mapping needs, so this module stays testable without a DOM. */
export interface WhiteboardRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Minimum travel before a freehand stroke records another point. */
const SAMPLE_DISTANCE = 2;
/** Slack around an element's box so thin arrows and strokes stay grabbable. */
const HIT_TOLERANCE = 4;

/**
 * Maps a pointer position onto viewBox coordinates.
 *
 * The canvas renders with the default `preserveAspectRatio="xMidYMid meet"`, so the drawable
 * area is centred inside the element with letterbox bars on one axis. `rect` already carries
 * the React Flow zoom transform, so zoom cancels out and needs no special handling.
 */
export function viewBoxPoint(
  rect: WhiteboardRect,
  clientX: number,
  clientY: number,
): WhiteboardPoint {
  const scale = Math.min(rect.width / VIEW_BOX_WIDTH, rect.height / VIEW_BOX_HEIGHT);
  if (!Number.isFinite(scale) || scale <= 0) return [0, 0];
  const offsetX = (rect.width - VIEW_BOX_WIDTH * scale) / 2;
  const offsetY = (rect.height - VIEW_BOX_HEIGHT * scale) / 2;
  return [
    clamp((clientX - rect.left - offsetX) / scale, 0, VIEW_BOX_WIDTH),
    clamp((clientY - rect.top - offsetY) / scale, 0, VIEW_BOX_HEIGHT),
  ];
}

/**
 * The inverse of {@link viewBoxPoint}: where a viewBox coordinate sits in pixels,
 * relative to the surface's top-left corner. Used to park the inline text editor.
 */
export function surfacePoint(rect: WhiteboardRect, point: WhiteboardPoint): WhiteboardPoint {
  const scale = Math.min(rect.width / VIEW_BOX_WIDTH, rect.height / VIEW_BOX_HEIGHT);
  if (!Number.isFinite(scale) || scale <= 0) return [0, 0];
  return [
    point[0] * scale + (rect.width - VIEW_BOX_WIDTH * scale) / 2,
    point[1] * scale + (rect.height - VIEW_BOX_HEIGHT * scale) / 2,
  ];
}

/** Normalises two drag corners into a box, so dragging in any direction works. */
export function dragBounds(start: WhiteboardPoint, current: WhiteboardPoint): WhiteboardBounds {
  return {
    x: Math.min(start[0], current[0]),
    y: Math.min(start[1], current[1]),
    width: Math.max(MIN_ELEMENT_SIZE, Math.abs(current[0] - start[0])),
    height: Math.max(MIN_ELEMENT_SIZE, Math.abs(current[1] - start[1])),
  };
}

/** The topmost element under a point — last drawn wins, matching what the user sees. */
export function hitTest(
  elements: readonly WhiteboardElement[],
  point: WhiteboardPoint,
): string | null {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (element === undefined || element.isDeleted) continue;
    if (containsPoint(element, point)) return element.id;
  }
  return null;
}

/** The box produced by dragging one corner handle, anchored at the opposite corner. */
export function resizeBounds(
  element: WhiteboardElement,
  handle: WhiteboardHandle,
  point: WhiteboardPoint,
): WhiteboardBounds {
  const opposite: WhiteboardHandle =
    handle === 'nw' ? 'se' : handle === 'se' ? 'nw' : handle === 'ne' ? 'sw' : 'ne';
  return dragBounds(handlePosition(element, opposite), point);
}

/** The viewBox coordinate of one corner of a box. */
export function handlePosition(bounds: WhiteboardBounds, handle: WhiteboardHandle): WhiteboardPoint {
  return [
    handle === 'ne' || handle === 'se' ? bounds.x + bounds.width : bounds.x,
    handle === 'sw' || handle === 'se' ? bounds.y + bounds.height : bounds.y,
  ];
}

/**
 * Records another freehand point, skipping ones too close to the previous sample and
 * refusing to grow past the per-stroke cap.
 */
export function appendStrokePoint(
  points: readonly WhiteboardPoint[],
  point: WhiteboardPoint,
): readonly WhiteboardPoint[] {
  if (points.length >= MAX_POINTS_PER_STROKE) return points;
  const last = points[points.length - 1];
  if (last !== undefined && Math.hypot(point[0] - last[0], point[1] - last[1]) < SAMPLE_DISTANCE) {
    return points;
  }
  return [...points, point];
}

function containsPoint(element: WhiteboardElement, point: WhiteboardPoint): boolean {
  return (
    point[0] >= element.x - HIT_TOLERANCE &&
    point[0] <= element.x + element.width + HIT_TOLERANCE &&
    point[1] >= element.y - HIT_TOLERANCE &&
    point[1] <= element.y + element.height + HIT_TOLERANCE
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
