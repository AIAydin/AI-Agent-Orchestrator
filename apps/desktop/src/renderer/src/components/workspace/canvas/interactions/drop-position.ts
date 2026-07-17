interface Point {
  readonly x: number;
  readonly y: number;
}

interface CanvasBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface NodeDimensions {
  readonly width: number;
  readonly height: number;
}

interface ScreenToFlowOptions {
  readonly snapToGrid: boolean;
}

const DROP_PADDING_PX = 16;

/** Keeps a newly dropped node reachable inside the visible canvas at every zoom level. */
export function visibleCanvasDropPosition(options: {
  readonly pointer: Point;
  readonly canvasBounds: CanvasBounds;
  readonly nodeDimensions: NodeDimensions;
  readonly screenToFlowPosition: (point: Point, options?: ScreenToFlowOptions) => Point;
}): Point {
  const rawPosition = options.screenToFlowPosition(options.pointer);
  const { canvasBounds, nodeDimensions } = options;
  if (canvasBounds.width <= 0 || canvasBounds.height <= 0) return rawPosition;

  const visibleStart = options.screenToFlowPosition(
    {
      x: canvasBounds.left + DROP_PADDING_PX,
      y: canvasBounds.top + DROP_PADDING_PX,
    },
    { snapToGrid: false },
  );
  const visibleEnd = options.screenToFlowPosition(
    {
      x: canvasBounds.right - DROP_PADDING_PX,
      y: canvasBounds.bottom - DROP_PADDING_PX,
    },
    { snapToGrid: false },
  );
  const minimumX = Math.min(visibleStart.x, visibleEnd.x);
  const minimumY = Math.min(visibleStart.y, visibleEnd.y);
  const maximumX = Math.max(
    minimumX,
    Math.max(visibleStart.x, visibleEnd.x) - nodeDimensions.width,
  );
  const maximumY = Math.max(
    minimumY,
    Math.max(visibleStart.y, visibleEnd.y) - nodeDimensions.height,
  );

  return {
    x: clamp(rawPosition.x, minimumX, maximumX),
    y: clamp(rawPosition.y, minimumY, maximumY),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
