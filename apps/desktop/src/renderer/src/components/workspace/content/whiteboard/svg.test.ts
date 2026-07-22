import { describe, expect, it } from 'vitest';

import { assertSafeDiagramSvg } from '../../../../../../main/diagram/svg-policy.js';
import { createArrowElement, createFreedrawElement, parseWhiteboardDocument } from './model.js';
import { whiteboardSvg } from './svg.js';

function documentOf(...elements: unknown[]) {
  return parseWhiteboardDocument({ elements });
}

const STROKE = createFreedrawElement([
  [10, 10],
  [40, 50],
]);

describe('whiteboardSvg freehand strokes', () => {
  it('emits an unfilled path along the stroke', () => {
    const svg = whiteboardSvg(documentOf(STROKE));
    expect(svg).toContain('<path d="M10 10 L40 50"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke-linecap="round"');
  });

  it('produces export-policy-safe SVG the main process will accept', () => {
    expect(() => {
      assertSafeDiagramSvg(whiteboardSvg(documentOf(STROKE)));
    }).not.toThrow();
  });
});

describe('whiteboardSvg arrows', () => {
  it('draws along the stored direction rather than the box diagonal', () => {
    const svg = whiteboardSvg(documentOf(createArrowElement([100, 100], [50, 50])));
    expect(svg).toContain('x1="100" y1="100" x2="50" y2="50"');
  });

  it('draws a legacy arrow along the box diagonal', () => {
    const svg = whiteboardSvg(documentOf({ id: 'a1', type: 'arrow', x: 5, y: 5, width: 100, height: 50 }));
    expect(svg).toContain('x1="5" y1="5" x2="105" y2="55"');
  });
});

describe('whiteboardSvg escaping', () => {
  it('escapes markup in text content', () => {
    const svg = whiteboardSvg(documentOf({ id: 't1', type: 'text', text: '<script>&' }));
    expect(svg).toContain('&lt;script&gt;&amp;');
    expect(svg).not.toContain('<script>');
  });

  it('stays policy-safe with hostile text', () => {
    expect(() => {
      assertSafeDiagramSvg(whiteboardSvg(documentOf({ id: 't2', type: 'text', text: '</svg><img>' })));
    }).not.toThrow();
  });
});
