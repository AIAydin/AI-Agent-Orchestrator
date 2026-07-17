import { describe, expect, it } from 'vitest';

import { visibleCanvasDropPosition } from './drop-position.js';

describe('visibleCanvasDropPosition', () => {
  it('clamps a zoomed node so its controls remain inside the visible canvas', () => {
    const position = visibleCanvasDropPosition({
      pointer: { x: 900, y: 700 },
      canvasBounds: {
        left: 0,
        top: 0,
        right: 1_000,
        bottom: 750,
        width: 1_000,
        height: 750,
      },
      nodeDimensions: { width: 320, height: 180 },
      screenToFlowPosition: ({ x, y }) => ({ x: x / 2.5, y: y / 2.5 }),
    });

    expect(position.x).toBeCloseTo(73.6);
    expect(position.y).toBeCloseTo(113.6);
  });

  it('preserves an ordinary in-bounds drop position', () => {
    expect(
      visibleCanvasDropPosition({
        pointer: { x: 200, y: 160 },
        canvasBounds: {
          left: 0,
          top: 0,
          right: 1_000,
          bottom: 750,
          width: 1_000,
          height: 750,
        },
        nodeDimensions: { width: 320, height: 180 },
        screenToFlowPosition: (point) => point,
      }),
    ).toEqual({ x: 200, y: 160 });
  });

  it('keeps the pointer snapped while measuring panned viewport bounds without snapping', () => {
    const pan = { x: -138.5, y: 0 };
    const zoom = 2.5;
    const grid = 128;
    const screenToFlowPosition = (
      { x, y }: { x: number; y: number },
      options?: { snapToGrid: boolean },
    ) => {
      const position = { x: (x - pan.x) / zoom, y: (y - pan.y) / zoom };
      if (options?.snapToGrid === false) return position;
      return {
        x: grid * Math.round(position.x / grid),
        y: grid * Math.round(position.y / grid),
      };
    };

    const position = visibleCanvasDropPosition({
      pointer: { x: 900, y: 700 },
      canvasBounds: {
        left: 0,
        top: 0,
        right: 1_000,
        bottom: 750,
        width: 1_000,
        height: 750,
      },
      nodeDimensions: { width: 320, height: 180 },
      screenToFlowPosition,
    });

    expect(position.x).toBeCloseTo(129);
    expect(position.y).toBeCloseTo(113.6);
    expect(pan.x + (position.x + 320) * zoom).toBeCloseTo(984);
    expect(pan.y + (position.y + 180) * zoom).toBeCloseTo(734);
  });

  it('returns the snapped pointer unchanged when the canvas has no visible area', () => {
    expect(
      visibleCanvasDropPosition({
        pointer: { x: 900, y: 700 },
        canvasBounds: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
        nodeDimensions: { width: 520, height: 360 },
        screenToFlowPosition: () => ({ x: 128, y: 256 }),
      }),
    ).toEqual({ x: 128, y: 256 });
  });
});
