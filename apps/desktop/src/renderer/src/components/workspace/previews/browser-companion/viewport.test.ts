import { describe, expect, it } from 'vitest';

import { chromeViewportForNode } from './viewport.js';

describe('chromeViewportForNode', () => {
  it('upscales a compact node to a desktop viewport without changing its aspect ratio', () => {
    const viewport = chromeViewportForNode(720, 420);
    expect(viewport).toEqual({ width: 1280, height: 747 });
    expect(viewport.width / viewport.height).toBeCloseTo(720 / 420, 2);
  });

  it('does not shrink a node that is already desktop sized', () => {
    expect(chromeViewportForNode(1440, 900)).toEqual({
      width: 1440,
      height: 900,
    });
  });
});
