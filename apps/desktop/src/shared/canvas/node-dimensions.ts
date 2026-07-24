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

interface NodeDimensions {
  readonly width: number;
  readonly height: number;
}

/** Face dimensions for the document & status node kinds (sub-plan 2b). */
export const DOCUMENT_NODE_DIMENSIONS: Readonly<
  Record<string, { readonly default: NodeDimensions; readonly minimum: NodeDimensions }>
> = {
  diagram: {
    default: { width: 480, height: 360 },
    minimum: { width: 320, height: 240 },
  },
  whiteboard: {
    default: { width: 560, height: 420 },
    minimum: { width: 360, height: 280 },
  },
  brief: {
    default: { width: 440, height: 440 },
    minimum: { width: 320, height: 280 },
  },
  'note-image': {
    default: { width: 400, height: 360 },
    minimum: { width: 300, height: 240 },
  },
  task: {
    default: { width: 340, height: 280 },
    minimum: { width: 260, height: 200 },
  },
  'review-gate': {
    default: { width: 360, height: 300 },
    minimum: { width: 280, height: 220 },
  },
  'git-pr': {
    default: { width: 420, height: 380 },
    minimum: { width: 320, height: 260 },
  },
  test: {
    default: { width: 400, height: 340 },
    minimum: { width: 300, height: 240 },
  },
  text: {
    default: { width: 260, height: 64 },
    minimum: { width: 120, height: 40 },
  },
};

/** Face dimensions for the heavier content node kinds (sub-plan 2c). */
export const CONTENT_NODE_DIMENSIONS: Readonly<
  Record<string, { readonly default: NodeDimensions; readonly minimum: NodeDimensions }>
> = {
  terminal: {
    default: { width: 560, height: 480 },
    minimum: { width: 400, height: 320 },
  },
  file: {
    default: { width: 640, height: 520 },
    minimum: { width: 420, height: 360 },
  },
  video: {
    default: { width: 640, height: 440 },
    minimum: { width: 400, height: 300 },
  },
  diff: {
    default: { width: 640, height: 560 },
    minimum: { width: 440, height: 360 },
  },
};

/** Default dimensions for non-frame node kinds (frames are handled separately). */
export function defaultNodeDimensionsForKind(kind: string): {
  readonly width: number;
  readonly height: number;
} {
  if (kind === 'agent') return AGENT_NODE_DEFAULT_DIMENSIONS;
  if (kind === 'web-preview') return WEB_PREVIEW_NODE_DEFAULT_DIMENSIONS;
  if (kind === 'mobile-preview') return MOBILE_PREVIEW_NODE_DEFAULT_DIMENSIONS;
  const contentDimensions = CONTENT_NODE_DIMENSIONS[kind];
  if (contentDimensions !== undefined) return contentDimensions.default;
  const documentDimensions = DOCUMENT_NODE_DIMENSIONS[kind];
  if (documentDimensions !== undefined) return documentDimensions.default;
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
  const contentDimensions = CONTENT_NODE_DIMENSIONS[kind];
  if (contentDimensions !== undefined) return contentDimensions.minimum;
  const documentDimensions = DOCUMENT_NODE_DIMENSIONS[kind];
  if (documentDimensions !== undefined) return documentDimensions.minimum;
  return CANVAS_NODE_MINIMUM_DIMENSIONS;
}
