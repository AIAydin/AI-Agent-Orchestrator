export type WhiteboardElementType =
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'arrow'
  | 'text'
  | 'freedraw';

/** A single point, relative to its element's `x`/`y` origin. */
export type WhiteboardPoint = readonly [number, number];

export interface WhiteboardBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WhiteboardElement extends Record<string, unknown> {
  readonly id: string;
  readonly type: WhiteboardElementType;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly fillStyle: 'solid';
  readonly strokeWidth: number;
  readonly strokeStyle: 'solid';
  readonly roughness: number;
  readonly opacity: number;
  readonly groupIds: string[];
  readonly frameId: null;
  readonly roundness: null;
  readonly seed: number;
  readonly version: number;
  readonly versionNonce: number;
  readonly isDeleted: boolean;
  readonly boundElements: null;
  readonly updated: number;
  readonly link: null;
  readonly locked: boolean;
  readonly text?: string;
  readonly originalText?: string;
  readonly fontSize?: number;
  readonly fontFamily?: number;
  readonly textAlign?: 'left';
  readonly verticalAlign?: 'top';
  readonly containerId?: null;
  readonly lineHeight?: number;
  readonly points?: readonly WhiteboardPoint[];
  readonly startBinding?: null;
  readonly endBinding?: null;
  readonly lastCommittedPoint?: null;
  readonly startArrowhead?: null;
  readonly endArrowhead?: 'arrow';
}

export interface WhiteboardDocument {
  readonly type: 'excalidraw';
  readonly version: 2;
  readonly source: 'https://forgeboard.local';
  readonly elements: WhiteboardElement[];
  readonly appState: { readonly viewBackgroundColor: string; readonly gridSize: number | null };
  readonly files: Record<string, never>;
}

/** The drawing surface is a fixed box scaled to fit the node; it never pans or zooms. */
export const VIEW_BOX_WIDTH = 960;
export const VIEW_BOX_HEIGHT = 640;
/** Smallest side an element may occupy, so a stray click cannot create an invisible element. */
export const MIN_ELEMENT_SIZE = 4;
export const MAX_POINTS_PER_STROKE = 512;

const DEFAULT_BACKGROUND = '#ffffff';
const DEFAULT_STROKE = '#334155';
const DEFAULT_FILL = '#e2e8f0';
const MAX_ELEMENTS = 2_000;
const COORDINATE_LIMIT = 4_000;

export function parseWhiteboardDocument(value: unknown): WhiteboardDocument {
  const record = objectValue(value);
  const elements = Array.isArray(record?.['elements'])
    ? record['elements'].slice(0, MAX_ELEMENTS).flatMap((candidate) => {
        const parsed = parseElement(candidate);
        return parsed === null ? [] : [parsed];
      })
    : [];
  const appState = objectValue(record?.['appState']);
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://forgeboard.local',
    elements,
    appState: {
      viewBackgroundColor: colorValue(appState?.['viewBackgroundColor'], DEFAULT_BACKGROUND),
      gridSize: appState?.['gridSize'] === null ? null : finiteNumber(appState?.['gridSize'], 20),
    },
    files: {},
  };
}

/** The smallest box containing every point, never thinner than {@link MIN_ELEMENT_SIZE}. */
export function boundsOfPoints(points: readonly WhiteboardPoint[]): WhiteboardBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { x: 0, y: 0, width: MIN_ELEMENT_SIZE, height: MIN_ELEMENT_SIZE };
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(MIN_ELEMENT_SIZE, maxX - minX),
    height: Math.max(MIN_ELEMENT_SIZE, maxY - minY),
  };
}

export function createWhiteboardElement(
  type: 'rectangle' | 'ellipse' | 'diamond' | 'text',
  bounds: WhiteboardBounds,
  text = '',
): WhiteboardElement {
  const base = elementBase(type, bounds);
  if (type === 'text') {
    return {
      ...base,
      text,
      originalText: text,
      fontSize: 20,
      fontFamily: 1,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      lineHeight: 1.25,
    };
  }
  return base;
}

/**
 * Arrows carry their direction in `points`, so a drag up-left produces an arrow that
 * points up-left. `x`/`y`/`width`/`height` are the normalized bounding box.
 */
export function createArrowElement(start: WhiteboardPoint, end: WhiteboardPoint): WhiteboardElement {
  const bounds = boundsOfPoints([start, end]);
  return {
    ...elementBase('arrow', bounds),
    points: [
      [start[0] - bounds.x, start[1] - bounds.y],
      [end[0] - bounds.x, end[1] - bounds.y],
    ],
    startBinding: null,
    endBinding: null,
    lastCommittedPoint: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
  };
}

/** Builds a freehand stroke from absolute points, storing them relative to their bounding box. */
export function createFreedrawElement(
  points: readonly WhiteboardPoint[],
): WhiteboardElement | null {
  if (points.length < 2) return null;
  const bounds = boundsOfPoints(points);
  return {
    ...elementBase('freedraw', bounds),
    points: points.map(([x, y]) => [x - bounds.x, y - bounds.y] as WhiteboardPoint),
  };
}

/** Absolute start and end of an arrow, falling back to the box diagonal for legacy elements. */
export function arrowEndpoints(element: WhiteboardElement): {
  readonly start: WhiteboardPoint;
  readonly end: WhiteboardPoint;
} {
  const start = element.points?.[0] ?? [0, 0];
  const end = element.points?.[1] ?? [element.width, element.height];
  return {
    start: [element.x + start[0], element.y + start[1]],
    end: [element.x + end[0], element.y + end[1]],
  };
}

/** Absolute SVG path data for a freehand stroke, shared by the renderer and the exporter. */
export function strokePath(element: WhiteboardElement): string {
  return (element.points ?? [])
    .map(
      ([x, y], index) =>
        `${index === 0 ? 'M' : 'L'}${roundCoordinate(element.x + x)} ${roundCoordinate(element.y + y)}`,
    )
    .join(' ');
}

export function updateWhiteboardElement(
  document: WhiteboardDocument,
  elementId: string,
  patch: Partial<
    Pick<
      WhiteboardElement,
      'x' | 'y' | 'width' | 'height' | 'strokeColor' | 'backgroundColor' | 'text' | 'originalText'
    >
  >,
): WhiteboardDocument {
  return {
    ...document,
    elements: document.elements.map((element) => {
      if (element.id !== elementId) return element;
      const width = finiteNumber(patch.width, element.width, 1, COORDINATE_LIMIT);
      const height = finiteNumber(patch.height, element.height, 1, COORDINATE_LIMIT);
      return {
        ...element,
        ...patch,
        x: finiteNumber(patch.x, element.x, -COORDINATE_LIMIT, COORDINATE_LIMIT),
        y: finiteNumber(patch.y, element.y, -COORDINATE_LIMIT, COORDINATE_LIMIT),
        width,
        height,
        ...(element.points === undefined
          ? {}
          : { points: scalePoints(element.points, width / element.width, height / element.height) }),
        version: element.version + 1,
        versionNonce: randomInteger(),
        updated: Date.now(),
      };
    }),
  };
}

function scalePoints(
  points: readonly WhiteboardPoint[],
  scaleX: number,
  scaleY: number,
): readonly WhiteboardPoint[] {
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return points;
  return points.map(([x, y]) => [x * scaleX, y * scaleY] as WhiteboardPoint);
}

function elementBase(type: WhiteboardElementType, bounds: WhiteboardBounds): WhiteboardElement {
  return {
    id: crypto.randomUUID(),
    type,
    x: clampCoordinate(bounds.x),
    y: clampCoordinate(bounds.y),
    width: Math.min(COORDINATE_LIMIT, Math.max(1, bounds.width)),
    height: Math.min(COORDINATE_LIMIT, Math.max(1, bounds.height)),
    angle: 0,
    strokeColor: DEFAULT_STROKE,
    backgroundColor: isOutlineOnly(type) ? 'transparent' : DEFAULT_FILL,
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: randomInteger(),
    version: 1,
    versionNonce: randomInteger(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function isOutlineOnly(type: WhiteboardElementType): boolean {
  return type === 'arrow' || type === 'text' || type === 'freedraw';
}

function parseElement(value: unknown): WhiteboardElement | null {
  const record = objectValue(value);
  if (record === null) return null;
  const type = record['type'];
  if (!isElementType(type)) return null;
  const id = stringValue(record['id']);
  if (id === null || id.length > 128) return null;
  const text = stringValue(record['text'])?.slice(0, 20_000) ?? '';
  const width = finiteNumber(record['width'], type === 'text' ? 180 : 140, 1, COORDINATE_LIMIT);
  const height = finiteNumber(record['height'], type === 'text' ? 42 : 90, 1, COORDINATE_LIMIT);
  const base = createParsedBase(record, id, type, width, height);
  if (type === 'text') {
    return {
      ...base,
      text,
      originalText: text,
      fontSize: finiteNumber(record['fontSize'], 20, 8, 96),
      fontFamily: 1,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      lineHeight: 1.25,
    };
  }
  if (type === 'freedraw') {
    const points = parsePoints(record['points']);
    if (points.length < 2) return null;
    return { ...base, backgroundColor: 'transparent', points };
  }
  if (type === 'arrow') {
    const stored = parsePoints(record['points']);
    const first = stored[0];
    const second = stored[1];
    return {
      ...base,
      backgroundColor: 'transparent',
      points:
        first === undefined || second === undefined
          ? [
              [0, 0],
              [width, height],
            ]
          : [first, second],
      startBinding: null,
      endBinding: null,
      lastCommittedPoint: null,
      startArrowhead: null,
      endArrowhead: 'arrow',
    };
  }
  return base;
}

function parsePoints(value: unknown): WhiteboardPoint[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_POINTS_PER_STROKE).flatMap((candidate) => {
    if (!Array.isArray(candidate)) return [];
    const [x, y] = candidate as unknown[];
    if (typeof x !== 'number' || !Number.isFinite(x)) return [];
    if (typeof y !== 'number' || !Number.isFinite(y)) return [];
    return [[clampCoordinate(x), clampCoordinate(y)] as WhiteboardPoint];
  });
}

function createParsedBase(
  record: Record<string, unknown>,
  id: string,
  type: WhiteboardElementType,
  width: number,
  height: number,
): WhiteboardElement {
  return {
    id,
    type,
    x: finiteNumber(record['x'], 0, -COORDINATE_LIMIT, COORDINATE_LIMIT),
    y: finiteNumber(record['y'], 0, -COORDINATE_LIMIT, COORDINATE_LIMIT),
    width,
    height,
    angle: 0,
    strokeColor: colorValue(record['strokeColor'], DEFAULT_STROKE),
    backgroundColor: colorValue(record['backgroundColor'], DEFAULT_FILL, true),
    fillStyle: 'solid',
    strokeWidth: finiteNumber(record['strokeWidth'], 2, 1, 8),
    strokeStyle: 'solid',
    roughness: 0,
    opacity: finiteNumber(record['opacity'], 100, 0, 100),
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: finiteNumber(record['seed'], randomInteger(), 1, 2_147_483_647),
    version: finiteNumber(record['version'], 1, 1, 2_147_483_647),
    versionNonce: finiteNumber(record['versionNonce'], randomInteger(), 1, 2_147_483_647),
    isDeleted: record['isDeleted'] === true,
    boundElements: null,
    updated: finiteNumber(record['updated'], Date.now(), 0, Number.MAX_SAFE_INTEGER),
    link: null,
    locked: record['locked'] === true,
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isElementType(value: unknown): value is WhiteboardElementType {
  return ['rectangle', 'ellipse', 'diamond', 'arrow', 'text', 'freedraw'].includes(String(value));
}

function finiteNumber(
  value: unknown,
  fallback: number,
  minimum = -Number.MAX_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function clampCoordinate(value: number): number {
  return Math.min(COORDINATE_LIMIT, Math.max(-COORDINATE_LIMIT, value));
}

function roundCoordinate(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function colorValue(value: unknown, fallback: string, transparent = false): string {
  if (transparent && value === 'transparent') return value;
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
}

function randomInteger(): number {
  return Math.floor(Math.random() * 2_147_483_646) + 1;
}
