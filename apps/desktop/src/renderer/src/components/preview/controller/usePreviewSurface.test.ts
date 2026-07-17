// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { elementBounds } from './usePreviewSurface.js';

describe('preview surface visible bounds', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('intersects a native surface with its scroll stage and window viewport', () => {
    vi.stubGlobal('innerWidth', 1_000);
    vi.stubGlobal('innerHeight', 700);
    const { host } = elements(rectangle(100, 100, 900, 800), rectangle(150, 140, 700, 500));

    expect(elementBounds(host)).toEqual({
      x: 150,
      y: 140,
      width: 700,
      height: 500,
      visible: true,
    });
  });

  it('marks a fully clipped native surface hidden instead of moving it over trusted UI', () => {
    vi.stubGlobal('innerWidth', 1_000);
    vi.stubGlobal('innerHeight', 700);
    const { host } = elements(rectangle(100, 900, 400, 300), rectangle(50, 100, 800, 500));

    expect(elementBounds(host)).toMatchObject({ visible: false, width: 64, height: 64 });
  });
});

function elements(hostRect: DOMRect, stageRect: DOMRect): { host: HTMLElement } {
  const stage = document.createElement('div');
  stage.className = 'preview-device-stage';
  const host = document.createElement('div');
  stage.append(host);
  stage.getBoundingClientRect = () => stageRect;
  host.getBoundingClientRect = () => hostRect;
  return { host };
}

function rectangle(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}
