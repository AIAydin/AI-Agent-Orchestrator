const MAX_ELEMENTS = 1_000;
const MAX_TEXT_CHARACTERS = 2_048;
const MAX_ID_CHARACTERS = 128;
const ELEMENT_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'arrow', 'text']);
const COLOR = /^(?:#[0-9a-f]{3,8}|transparent)$/iu;

interface SafeWhiteboardElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  backgroundColor: string;
  strokeWidth: number;
  opacity: number;
  text?: string;
  fontSize?: number;
  points?: [[number, number], [number, number]];
}

export interface SafeWhiteboardDocument {
  type: 'excalidraw';
  version: 2;
  source: 'https://forgeboard.local';
  elements: SafeWhiteboardElement[];
  appState: { viewBackgroundColor: string; gridSize: number | null };
  embeddedFilesIncluded: false;
  discardedElementCount: number;
  truncatedElementCount: number;
}

/**
 * Converts arbitrary persisted Excalidraw-compatible JSON into the small visual vocabulary agents
 * need. File payloads, links, bindings, custom data, and every other opaque field are deliberately
 * omitted rather than copied into agent context.
 */
export function safeWhiteboardDocument(value: unknown): SafeWhiteboardDocument {
  const input = objectValue(value);
  const candidates = Array.isArray(input?.['elements']) ? input['elements'] : [];
  const considered = candidates.slice(0, MAX_ELEMENTS);
  const elements = considered.flatMap((candidate) => {
    const element = safeElement(candidate);
    return element === null ? [] : [element];
  });
  const appState = objectValue(input?.['appState']);
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://forgeboard.local',
    elements,
    appState: {
      viewBackgroundColor: colorValue(appState?.['viewBackgroundColor'], '#ffffff'),
      gridSize:
        appState?.['gridSize'] === null ? null : finiteNumber(appState?.['gridSize'], 20, 1, 200),
    },
    embeddedFilesIncluded: false,
    discardedElementCount: considered.length - elements.length,
    truncatedElementCount: Math.max(0, candidates.length - considered.length),
  };
}

function safeElement(value: unknown): SafeWhiteboardElement | null {
  const input = objectValue(value);
  const type = input?.['type'];
  const id = input?.['id'];
  if (
    input === null ||
    typeof type !== 'string' ||
    !ELEMENT_TYPES.has(type) ||
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_ID_CHARACTERS ||
    input['isDeleted'] === true
  ) {
    return null;
  }
  const width = finiteNumber(input['width'], type === 'text' ? 180 : 140, 1, 4_000);
  const height = finiteNumber(input['height'], type === 'text' ? 42 : 90, 1, 4_000);
  const base: SafeWhiteboardElement = {
    id,
    type,
    x: finiteNumber(input['x'], 0, -4_000, 4_000),
    y: finiteNumber(input['y'], 0, -4_000, 4_000),
    width,
    height,
    strokeColor: colorValue(input['strokeColor'], '#334155'),
    backgroundColor: colorValue(
      input['backgroundColor'],
      type === 'arrow' || type === 'text' ? 'transparent' : '#e2e8f0',
    ),
    strokeWidth: finiteNumber(input['strokeWidth'], 2, 1, 8),
    opacity: finiteNumber(input['opacity'], 100, 0, 100),
  };
  if (type === 'text') {
    return {
      ...base,
      text: typeof input['text'] === 'string' ? input['text'].slice(0, MAX_TEXT_CHARACTERS) : '',
      fontSize: finiteNumber(input['fontSize'], 20, 8, 96),
    };
  }
  if (type === 'arrow')
    return {
      ...base,
      points: [
        [0, 0],
        [width, height],
      ],
    };
  return base;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function colorValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && COLOR.test(value) ? value : fallback;
}

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}
