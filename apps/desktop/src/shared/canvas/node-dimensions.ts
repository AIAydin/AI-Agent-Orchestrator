/** Canonical dimensions used when an ordinary canvas node has never been resized. */
export const DEFAULT_CANVAS_NODE_DIMENSIONS = {
  width: 320,
  height: 180,
} as const;

/** Smallest ordinary node dimensions rendered by the shared canvas node surface. */
export const CANVAS_NODE_MINIMUM_DIMENSIONS = {
  width: 210,
  height: 92,
} as const;

/** Initial dimensions for a new frame, deliberately larger than the resizing floor. */
export const DEFAULT_GROUP_FRAME_DIMENSIONS = {
  width: 520,
  height: 360,
} as const;

/** Smallest logical and rendered frame dimensions accepted across migration and interaction. */
export const GROUP_FRAME_MINIMUM_DIMENSIONS = {
  width: 360,
  height: 240,
} as const;
