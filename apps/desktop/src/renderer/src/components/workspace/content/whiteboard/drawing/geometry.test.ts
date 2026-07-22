import { describe, expect, it } from 'vitest';

import { createWhiteboardElement, type WhiteboardPoint } from '../model.js';
import {
  appendStrokePoint,
  dragBounds,
  handlePosition,
  hitTest,
  resizeBounds,
  surfacePoint,
  viewBoxPoint,
} from './geometry.js';

/** A 960x640 viewBox drawn into 480x320: uniform 0.5 scale, no letterboxing. */
const EXACT = { left: 0, top: 0, width: 480, height: 320 };
/** A 480x480 box letterboxes vertically: 0.5 scale with 80px bars top and bottom. */
const TALL = { left: 0, top: 0, width: 480, height: 480 };

describe('viewBoxPoint', () => {
  it('maps a pointer position through a uniform scale', () => {
    expect(viewBoxPoint(EXACT, 240, 160)).toEqual([480, 320]);
  });

  it('subtracts the element offset', () => {
    expect(viewBoxPoint({ ...EXACT, left: 100, top: 50 }, 340, 210)).toEqual([480, 320]);
  });

  it('subtracts the letterbox bars', () => {
    expect(viewBoxPoint(TALL, 240, 240)).toEqual([480, 320]);
  });

  it('clamps a pointer inside a letterbox bar to the drawable area', () => {
    expect(viewBoxPoint(TALL, 240, 10)).toEqual([480, 0]);
  });

  it('clamps a pointer past the right edge to the drawable area', () => {
    expect(viewBoxPoint(EXACT, 5_000, 160)).toEqual([960, 320]);
  });

  it('survives a zero-sized rect', () => {
    expect(viewBoxPoint({ left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toEqual([0, 0]);
  });
});

describe('surfacePoint', () => {
  it('round-trips with viewBoxPoint through a uniform scale', () => {
    expect(surfacePoint(EXACT, [480, 320])).toEqual([240, 160]);
  });

  it('adds the letterbox offset back', () => {
    expect(surfacePoint(TALL, [480, 320])).toEqual([240, 240]);
  });

  it('survives a zero-sized rect', () => {
    expect(surfacePoint({ left: 0, top: 0, width: 0, height: 0 }, [10, 10])).toEqual([0, 0]);
  });
});

describe('dragBounds', () => {
  it('normalises a drag down and to the right', () => {
    expect(dragBounds([40, 60], [100, 100])).toEqual({ x: 40, y: 60, width: 60, height: 40 });
  });

  it('normalises a drag up and to the left', () => {
    expect(dragBounds([100, 100], [40, 60])).toEqual({ x: 40, y: 60, width: 60, height: 40 });
  });

  it('enforces the minimum size on a click without movement', () => {
    expect(dragBounds([10, 10], [10, 10])).toEqual({ x: 10, y: 10, width: 4, height: 4 });
  });
});

describe('hitTest', () => {
  const lower = createWhiteboardElement('rectangle', { x: 0, y: 0, width: 100, height: 100 });
  const upper = createWhiteboardElement('rectangle', { x: 50, y: 50, width: 100, height: 100 });

  it('returns the topmost element under the point', () => {
    expect(hitTest([lower, upper], [60, 60])).toBe(upper.id);
  });

  it('returns the only element under the point', () => {
    expect(hitTest([lower, upper], [10, 10])).toBe(lower.id);
  });

  it('returns null when nothing is under the point', () => {
    expect(hitTest([lower, upper], [400, 400])).toBeNull();
  });

  it('ignores deleted elements', () => {
    expect(hitTest([{ ...lower, isDeleted: true }], [10, 10])).toBeNull();
  });
});

describe('resizeBounds', () => {
  const element = createWhiteboardElement('rectangle', { x: 100, y: 100, width: 100, height: 100 });

  it('anchors the south-east corner when dragging the north-west handle', () => {
    expect(resizeBounds(element, 'nw', [150, 150])).toEqual({
      x: 150,
      y: 150,
      width: 50,
      height: 50,
    });
  });

  it('anchors the north-west corner when dragging the south-east handle', () => {
    expect(resizeBounds(element, 'se', [400, 300])).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 200,
    });
  });

  it('anchors the south-west corner when dragging the north-east handle', () => {
    expect(resizeBounds(element, 'ne', [300, 150])).toEqual({
      x: 100,
      y: 150,
      width: 200,
      height: 50,
    });
  });
});

describe('handlePosition', () => {
  const bounds = { x: 10, y: 20, width: 100, height: 50 };

  it('locates each corner', () => {
    expect(handlePosition(bounds, 'nw')).toEqual([10, 20]);
    expect(handlePosition(bounds, 'ne')).toEqual([110, 20]);
    expect(handlePosition(bounds, 'sw')).toEqual([10, 70]);
    expect(handlePosition(bounds, 'se')).toEqual([110, 70]);
  });
});

describe('appendStrokePoint', () => {
  it('skips a point within the sampling distance of the previous one', () => {
    expect(appendStrokePoint([[0, 0]], [1, 0])).toEqual([[0, 0]]);
  });

  it('appends a point beyond the sampling distance', () => {
    expect(appendStrokePoint([[0, 0]], [10, 0])).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it('always accepts the first point', () => {
    expect(appendStrokePoint([], [3, 3])).toEqual([[3, 3]]);
  });

  it('stops appending at the cap', () => {
    const full: WhiteboardPoint[] = Array.from({ length: 512 }, (_, index) => [index * 10, 0]);
    expect(appendStrokePoint(full, [99_999, 0])).toHaveLength(512);
  });
});
