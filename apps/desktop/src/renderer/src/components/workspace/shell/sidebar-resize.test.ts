import { describe, expect, it } from 'vitest';

import {
  CANVAS_MIN_WIDTH,
  clampSidebarWidth,
  keyboardSidebarWidth,
  RAIL_WIDTH_RANGE,
  reclampSidebarWidths,
} from './sidebar-resize.js';

describe('clampSidebarWidth', () => {
  it('keeps a width inside the sidebar range untouched', () => {
    expect(clampSidebarWidth(300, RAIL_WIDTH_RANGE, 0, 1600)).toBe(300);
  });

  it('clamps below the minimum up to the minimum', () => {
    expect(clampSidebarWidth(40, RAIL_WIDTH_RANGE, 0, 1600)).toBe(RAIL_WIDTH_RANGE.min);
    expect(clampSidebarWidth(-500, RAIL_WIDTH_RANGE, 0, 1600)).toBe(RAIL_WIDTH_RANGE.min);
  });

  it('clamps above the maximum down to the maximum', () => {
    expect(clampSidebarWidth(2000, RAIL_WIDTH_RANGE, 0, 2400)).toBe(RAIL_WIDTH_RANGE.max);
  });

  it('never lets the sidebar squeeze the canvas below its minimum width', () => {
    const windowWidth = 800;
    const clamped = clampSidebarWidth(480, RAIL_WIDTH_RANGE, 0, windowWidth);
    expect(clamped).toBe(windowWidth - CANVAS_MIN_WIDTH);
    expect(clamped + CANVAS_MIN_WIDTH).toBeLessThanOrEqual(windowWidth);
  });

  it('lets the sidebar minimum win over the canvas budget in tiny windows', () => {
    expect(clampSidebarWidth(400, RAIL_WIDTH_RANGE, 0, 480)).toBe(RAIL_WIDTH_RANGE.min);
  });

  it('rounds fractional drag positions to whole pixels', () => {
    expect(clampSidebarWidth(300.6, RAIL_WIDTH_RANGE, 0, 1600)).toBe(301);
  });
});

describe('reclampSidebarWidths', () => {
  it('returns the width unchanged when the rail still fits', () => {
    expect(reclampSidebarWidths({ railWidth: 260 }, 1440)).toEqual({ railWidth: 260 });
  });

  it('pulls an out-of-range width back into the rail range', () => {
    expect(reclampSidebarWidths({ railWidth: 40 }, 2000)).toEqual({
      railWidth: RAIL_WIDTH_RANGE.min,
    });
    expect(reclampSidebarWidths({ railWidth: 900 }, 2000)).toEqual({
      railWidth: RAIL_WIDTH_RANGE.max,
    });
  });

  it('shrinks the rail when the window narrows', () => {
    const result = reclampSidebarWidths({ railWidth: 480 }, 700);
    expect(result.railWidth).toBe(700 - CANVAS_MIN_WIDTH);
    expect(result.railWidth).toBeGreaterThanOrEqual(RAIL_WIDTH_RANGE.min);
  });

  it('stops at the rail minimum even when the window is smaller than it needs', () => {
    expect(reclampSidebarWidths({ railWidth: 480 }, 400)).toEqual({
      railWidth: RAIL_WIDTH_RANGE.min,
    });
  });
});

describe('keyboardSidebarWidth', () => {
  it('grows a start-edge sidebar with ArrowRight and shrinks it with ArrowLeft', () => {
    expect(keyboardSidebarWidth('ArrowRight', false, 260, RAIL_WIDTH_RANGE, 'start')).toBe(276);
    expect(keyboardSidebarWidth('ArrowLeft', false, 260, RAIL_WIDTH_RANGE, 'start')).toBe(244);
  });

  it('shrinks an end-edge sidebar with ArrowRight and grows it with ArrowLeft', () => {
    expect(keyboardSidebarWidth('ArrowRight', false, 320, RAIL_WIDTH_RANGE, 'end')).toBe(304);
    expect(keyboardSidebarWidth('ArrowLeft', false, 320, RAIL_WIDTH_RANGE, 'end')).toBe(336);
  });

  it('uses the large 64px step while Shift is held', () => {
    expect(keyboardSidebarWidth('ArrowRight', true, 260, RAIL_WIDTH_RANGE, 'start')).toBe(324);
    expect(keyboardSidebarWidth('ArrowLeft', true, 320, RAIL_WIDTH_RANGE, 'end')).toBe(384);
  });

  it('jumps to the range bounds with Home and End', () => {
    expect(keyboardSidebarWidth('Home', false, 300, RAIL_WIDTH_RANGE, 'start')).toBe(
      RAIL_WIDTH_RANGE.min,
    );
    expect(keyboardSidebarWidth('End', false, 300, RAIL_WIDTH_RANGE, 'start')).toBe(
      RAIL_WIDTH_RANGE.max,
    );
  });

  it('ignores keys that do not resize', () => {
    expect(keyboardSidebarWidth('ArrowUp', false, 260, RAIL_WIDTH_RANGE, 'start')).toBeNull();
    expect(keyboardSidebarWidth('Enter', false, 260, RAIL_WIDTH_RANGE, 'start')).toBeNull();
    expect(keyboardSidebarWidth('a', true, 260, RAIL_WIDTH_RANGE, 'start')).toBeNull();
  });
});
