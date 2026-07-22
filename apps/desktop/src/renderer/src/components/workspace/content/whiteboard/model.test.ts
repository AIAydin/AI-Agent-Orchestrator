import { describe, expect, it } from 'vitest';

import {
  arrowEndpoints,
  boundsOfPoints,
  createArrowElement,
  createFreedrawElement,
  createWhiteboardElement,
  MAX_POINTS_PER_STROKE,
  parseWhiteboardDocument,
  strokePath,
  updateWhiteboardElement,
  type WhiteboardElement,
  type WhiteboardPoint,
} from './model.js';

function parsedElement(candidate: unknown): WhiteboardElement | undefined {
  return parseWhiteboardDocument({ elements: [candidate] }).elements[0];
}

function requireElement(element: WhiteboardElement | null | undefined): WhiteboardElement {
  if (element === null || element === undefined) throw new Error('Expected an element.');
  return element;
}

describe('boundsOfPoints', () => {
  it('spans the extremes of the supplied points', () => {
    expect(boundsOfPoints([
      [10, 20],
      [50, 90],
    ])).toEqual({ x: 10, y: 20, width: 40, height: 70 });
  });

  it('enforces the minimum size on a degenerate axis', () => {
    expect(boundsOfPoints([
      [10, 20],
      [40, 20],
    ])).toEqual({ x: 10, y: 20, width: 30, height: 4 });
  });
});

describe('createWhiteboardElement', () => {
  it('creates a shape at the supplied bounds', () => {
    expect(createWhiteboardElement('rectangle', { x: 12, y: 34, width: 56, height: 78 })).toMatchObject(
      { type: 'rectangle', x: 12, y: 34, width: 56, height: 78 },
    );
  });

  it('creates transparent text carrying its own copy', () => {
    expect(createWhiteboardElement('text', { x: 0, y: 0, width: 180, height: 42 }, 'Login')).toMatchObject(
      { type: 'text', text: 'Login', originalText: 'Login', backgroundColor: 'transparent' },
    );
  });
});

describe('createArrowElement', () => {
  it('points down and right when dragged that way', () => {
    const arrow = createArrowElement([10, 10], [110, 60]);
    expect(arrow).toMatchObject({ x: 10, y: 10, width: 100, height: 50 });
    expect(arrowEndpoints(arrow)).toEqual({ start: [10, 10], end: [110, 60] });
  });

  it('points up and left when dragged that way', () => {
    const arrow = createArrowElement([100, 100], [50, 50]);
    expect(arrow).toMatchObject({ x: 50, y: 50, width: 50, height: 50 });
    expect(arrowEndpoints(arrow)).toEqual({ start: [100, 100], end: [50, 50] });
  });
});

describe('createFreedrawElement', () => {
  it('stores points relative to the bounding box origin', () => {
    const stroke = requireElement(createFreedrawElement([
      [100, 100],
      [140, 180],
    ]));
    expect(stroke).toMatchObject({ type: 'freedraw', x: 100, y: 100, width: 40, height: 80 });
    expect(stroke.points).toEqual([
      [0, 0],
      [40, 80],
    ]);
    expect(stroke.backgroundColor).toBe('transparent');
  });

  it('rejects a stroke with fewer than two points', () => {
    expect(createFreedrawElement([[10, 10]])).toBeNull();
  });
});

describe('strokePath', () => {
  it('emits absolute move and line commands', () => {
    const stroke = requireElement(createFreedrawElement([
      [10, 10],
      [20, 30],
    ]));
    expect(strokePath(stroke)).toBe('M10 10 L20 30');
  });
});

describe('parseWhiteboardDocument freehand strokes', () => {
  it('caps the number of stored points', () => {
    const points = Array.from({ length: 600 }, (_, index) => [index, index]);
    expect(parsedElement({ id: 'f1', type: 'freedraw', points })?.points).toHaveLength(
      MAX_POINTS_PER_STROKE,
    );
  });

  it('drops points that are not pairs of finite numbers', () => {
    const points: unknown[] = [
      [0, 0],
      [1, Number.NaN],
      ['x', 2],
      [5],
      [2, 2],
    ];
    expect(parsedElement({ id: 'f2', type: 'freedraw', points })?.points).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  it('clamps point coordinates to the document bounds', () => {
    const points = [
      [-9_000, 9_000],
      [0, 0],
    ];
    expect(parsedElement({ id: 'f3', type: 'freedraw', points })?.points).toEqual([
      [-4_000, 4_000],
      [0, 0],
    ]);
  });

  it('rejects a stroke left with fewer than two valid points', () => {
    const points = [
      [0, 0],
      [1, Number.NaN],
    ];
    expect(parseWhiteboardDocument({ elements: [{ id: 'f4', type: 'freedraw', points }] }).elements).toEqual(
      [],
    );
  });
});

describe('parseWhiteboardDocument arrows', () => {
  it('keeps a legacy arrow rendering identically when it stores no points', () => {
    const arrow = requireElement(parsedElement({ id: 'a1', type: 'arrow', x: 5, y: 5, width: 100, height: 50 }));
    expect(arrowEndpoints(arrow)).toEqual({ start: [5, 5], end: [105, 55] });
  });

  it('preserves a stored direction', () => {
    const arrow = requireElement(
      parsedElement({
        id: 'a2',
        type: 'arrow',
        x: 0,
        y: 0,
        width: 50,
        height: 50,
        points: [
          [50, 50],
          [0, 0],
        ],
      }),
    );
    expect(arrowEndpoints(arrow)).toEqual({ start: [50, 50], end: [0, 0] });
  });
});

describe('updateWhiteboardElement', () => {
  it('scales stroke points with the box', () => {
    const stroke = requireElement(createFreedrawElement([
      [0, 0],
      [50, 50],
    ]));
    const next = updateWhiteboardElement(
      { ...parseWhiteboardDocument({}), elements: [stroke] },
      stroke.id,
      { width: 100, height: 25 },
    );
    expect(next.elements[0]?.points).toEqual([
      [0, 0],
      [100, 25],
    ]);
  });

  it('scales arrow endpoints with the box', () => {
    const arrow = createArrowElement([100, 100], [50, 50]);
    const next = updateWhiteboardElement(
      { ...parseWhiteboardDocument({}), elements: [arrow] },
      arrow.id,
      { width: 100 },
    );
    expect(next.elements[0]?.points).toEqual([
      [100, 50],
      [0, 0],
    ]);
  });

  it('moves an element without touching its point count', () => {
    const stroke = requireElement(createFreedrawElement([
      [0, 0],
      [50, 50],
    ]));
    const next = updateWhiteboardElement(
      { ...parseWhiteboardDocument({}), elements: [stroke] },
      stroke.id,
      { x: 200, y: 300 },
    );
    expect(next.elements[0]).toMatchObject({ x: 200, y: 300 });
    expect(next.elements[0]?.points as readonly WhiteboardPoint[]).toHaveLength(2);
  });
});
