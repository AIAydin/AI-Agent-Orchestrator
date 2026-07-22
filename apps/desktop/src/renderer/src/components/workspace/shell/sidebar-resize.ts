/**
 * Pure sizing rules for the draggable workspace project rail. Kept free of DOM
 * access so the clamp and keyboard behavior can be unit-tested without layout.
 */

export interface SidebarRange {
  readonly min: number;
  readonly max: number;
}

/** Which side of its resize handle the sidebar sits on. */
export type SidebarEdge = 'start' | 'end';

export const RAIL_WIDTH_RANGE: SidebarRange = { min: 180, max: 480 };

/** The canvas column must always keep at least this much room. */
export const CANVAS_MIN_WIDTH = 320;

export const RAIL_DEFAULT_WIDTH = 260;
export const NARROW_RAIL_DEFAULT_WIDTH = 230;

export const KEYBOARD_RESIZE_STEP = 16;
export const KEYBOARD_RESIZE_LARGE_STEP = 64;

/**
 * Clamps one sidebar to its own range and to the space the window can spare
 * once the other sidebar and the minimum canvas width are accounted for. The
 * sidebar's own minimum always wins over the canvas budget so a tiny window
 * cannot collapse a sidebar below its usable width.
 */
export function clampSidebarWidth(
  width: number,
  range: SidebarRange,
  otherSidebarWidth: number,
  windowWidth: number,
): number {
  const budgetMax = windowWidth - CANVAS_MIN_WIDTH - otherSidebarWidth;
  const max = Math.min(range.max, budgetMax);
  return Math.round(Math.max(range.min, Math.min(width, max)));
}

export interface SidebarWidths {
  readonly railWidth: number;
}

/**
 * Re-clamps the stored rail width after the window resizes. The rail gives up
 * space when it no longer fits alongside the minimum canvas width, but never
 * goes below its own minimum.
 */
export function reclampSidebarWidths(widths: SidebarWidths, windowWidth: number): SidebarWidths {
  let rail = Math.round(
    Math.max(RAIL_WIDTH_RANGE.min, Math.min(widths.railWidth, RAIL_WIDTH_RANGE.max)),
  );
  const overflow = rail + CANVAS_MIN_WIDTH - windowWidth;
  if (overflow > 0) {
    rail = Math.max(RAIL_WIDTH_RANGE.min, rail - overflow);
  }
  return { railWidth: rail };
}

/**
 * Maps a key press on a resize handle to the width the sidebar should request
 * next, or null when the key is not a resize key. Arrow directions follow the
 * handle's on-screen movement: pressing ArrowRight moves the divider right,
 * which grows a start-edge sidebar (the rail) and shrinks an end-edge sidebar.
 * The caller still clamps the result.
 */
export function keyboardSidebarWidth(
  key: string,
  shiftKey: boolean,
  currentWidth: number,
  range: SidebarRange,
  edge: SidebarEdge,
): number | null {
  const step = shiftKey ? KEYBOARD_RESIZE_LARGE_STEP : KEYBOARD_RESIZE_STEP;
  const grow = edge === 'start' ? step : -step;
  switch (key) {
    case 'ArrowRight':
      return currentWidth + grow;
    case 'ArrowLeft':
      return currentWidth - grow;
    case 'Home':
      return range.min;
    case 'End':
      return range.max;
    default:
      return null;
  }
}
