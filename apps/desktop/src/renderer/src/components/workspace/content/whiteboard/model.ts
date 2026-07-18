export type WhiteboardElementType = 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'text';

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
  readonly points?: readonly [readonly [number, number], readonly [number, number]];
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

const DEFAULT_BACKGROUND = '#ffffff';
const DEFAULT_STROKE = '#334155';
const DEFAULT_FILL = '#e2e8f0';
const MAX_ELEMENTS = 2_000;

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

export function createWhiteboardElement(
  type: WhiteboardElementType,
  index: number,
  text = '',
): WhiteboardElement {
  const now = Date.now();
  const id = crypto.randomUUID();
  const x = 24 + (index % 8) * 22;
  const y = 24 + (index % 6) * 22;
  const width = type === 'arrow' ? 150 : type === 'text' ? 180 : 140;
  const height = type === 'arrow' ? 72 : type === 'text' ? 42 : 90;
  const base: WhiteboardElement = {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: DEFAULT_STROKE,
    backgroundColor: type === 'arrow' || type === 'text' ? 'transparent' : DEFAULT_FILL,
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
    updated: now,
    link: null,
    locked: false,
  };
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
  if (type === 'arrow') {
    return {
      ...base,
      points: [
        [0, 0],
        [width, height],
      ],
      startBinding: null,
      endBinding: null,
      lastCommittedPoint: null,
      startArrowhead: null,
      endArrowhead: 'arrow',
    };
  }
  return base;
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
      const width = finiteNumber(patch.width, element.width, 1, 4_000);
      const height = finiteNumber(patch.height, element.height, 1, 4_000);
      return {
        ...element,
        ...patch,
        x: finiteNumber(patch.x, element.x, -4_000, 4_000),
        y: finiteNumber(patch.y, element.y, -4_000, 4_000),
        width,
        height,
        ...(element.type === 'arrow'
          ? {
              points: [
                [0, 0],
                [width, height],
              ] as const,
            }
          : {}),
        version: element.version + 1,
        versionNonce: randomInteger(),
        updated: Date.now(),
      };
    }),
  };
}

function parseElement(value: unknown): WhiteboardElement | null {
  const record = objectValue(value);
  if (record === null) return null;
  const type = record['type'];
  if (!isElementType(type)) return null;
  const id = stringValue(record['id']);
  if (id === null || id.length > 128) return null;
  const text = stringValue(record['text'])?.slice(0, 20_000) ?? '';
  const width = finiteNumber(record['width'], type === 'text' ? 180 : 140, 1, 4_000);
  const height = finiteNumber(record['height'], type === 'text' ? 42 : 90, 1, 4_000);
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
  if (type === 'arrow') {
    return {
      ...base,
      backgroundColor: 'transparent',
      points: [
        [0, 0],
        [width, height],
      ],
      startBinding: null,
      endBinding: null,
      lastCommittedPoint: null,
      startArrowhead: null,
      endArrowhead: 'arrow',
    };
  }
  return base;
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
    x: finiteNumber(record['x'], 0, -4_000, 4_000),
    y: finiteNumber(record['y'], 0, -4_000, 4_000),
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
  return ['rectangle', 'ellipse', 'diamond', 'arrow', 'text'].includes(String(value));
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

function colorValue(value: unknown, fallback: string, transparent = false): string {
  if (transparent && value === 'transparent') return value;
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
}

function randomInteger(): number {
  return Math.floor(Math.random() * 2_147_483_646) + 1;
}
