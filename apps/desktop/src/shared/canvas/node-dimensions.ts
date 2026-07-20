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

/** Initial dimensions for an agent session window (embedded CLI terminal). */
export const AGENT_NODE_DEFAULT_DIMENSIONS = {
  width: 560,
  height: 480,
} as const;

/** Smallest agent session window that still fits a usable terminal. */
export const AGENT_NODE_MINIMUM_DIMENSIONS = {
  width: 400,
  height: 320,
} as const;

/** Initial dimensions for a web preview node (embedded browser). */
export const WEB_PREVIEW_NODE_DEFAULT_DIMENSIONS = {
  width: 640,
  height: 480,
} as const;

/** Smallest web preview that still shows a usable page. */
export const WEB_PREVIEW_NODE_MINIMUM_DIMENSIONS = {
  width: 400,
  height: 300,
} as const;

/** Initial dimensions for a mobile preview node (scaled device frame). */
export const MOBILE_PREVIEW_NODE_DEFAULT_DIMENSIONS = {
  width: 420,
  height: 640,
} as const;

/** Smallest mobile preview that still shows a readable device frame. */
export const MOBILE_PREVIEW_NODE_MINIMUM_DIMENSIONS = {
  width: 320,
  height: 480,
} as const;

/** Default dimensions for non-frame node kinds (frames are handled separately). */
export function defaultNodeDimensionsForKind(kind: string): {
  readonly width: number;
  readonly height: number;
} {
  if (kind === 'agent') return AGENT_NODE_DEFAULT_DIMENSIONS;
  if (kind === 'web-preview') return WEB_PREVIEW_NODE_DEFAULT_DIMENSIONS;
  if (kind === 'mobile-preview') return MOBILE_PREVIEW_NODE_DEFAULT_DIMENSIONS;
  return DEFAULT_CANVAS_NODE_DIMENSIONS;
}

/** Minimum dimensions for non-frame node kinds (frames are handled separately). */
export function minimumNodeDimensionsForKind(kind: string): {
  readonly width: number;
  readonly height: number;
} {
  if (kind === 'agent') return AGENT_NODE_MINIMUM_DIMENSIONS;
  if (kind === 'web-preview') return WEB_PREVIEW_NODE_MINIMUM_DIMENSIONS;
  if (kind === 'mobile-preview') return MOBILE_PREVIEW_NODE_MINIMUM_DIMENSIONS;
  return CANVAS_NODE_MINIMUM_DIMENSIONS;
}
