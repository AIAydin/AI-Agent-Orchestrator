import { describe, expect, it } from 'vitest';

import {
  CANVAS_MAX_OFFSET,
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  normalizeCanvasViewport,
  sameCanvasViewport,
} from './viewport.js';

describe('canvas viewport state', () => {
  it('preserves ordinary finite pan and zoom values', () => {
    expect(normalizeCanvasViewport({ x: -420.5, y: 84.25, zoom: 1.75 })).toEqual({
      x: -420.5,
      y: 84.25,
      zoom: 1.75,
    });
  });

  it('bounds untrusted offsets and zoom to the interactive canvas limits', () => {
    expect(
      normalizeCanvasViewport({
        x: Number.POSITIVE_INFINITY,
        y: CANVAS_MAX_OFFSET * -2,
        zoom: CANVAS_MAX_ZOOM * 4,
      }),
    ).toEqual({ x: 0, y: -CANVAS_MAX_OFFSET, zoom: CANVAS_MAX_ZOOM });
    expect(normalizeCanvasViewport({ x: 1, y: 2, zoom: 0 })).toEqual({
      x: 1,
      y: 2,
      zoom: CANVAS_MIN_ZOOM,
    });
  });

  it('compares normalized viewport snapshots exactly', () => {
    expect(sameCanvasViewport({ x: 1, y: 2, zoom: 1 }, { x: 1, y: 2, zoom: 1 })).toBe(true);
    expect(sameCanvasViewport({ x: 1, y: 2, zoom: 1 }, { x: 1, y: 3, zoom: 1 })).toBe(false);
  });
});
