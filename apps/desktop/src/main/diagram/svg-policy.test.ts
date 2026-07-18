import { describe, expect, it } from 'vitest';

import { assertSafeDiagramSvg } from './svg-policy.js';

describe('diagram SVG export policy', () => {
  it('accepts the inert subset emitted by the renderer sanitizer', () => {
    expect(() =>
      assertSafeDiagramSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><marker id="arrow"><path d="M0 0L10 5" fill="#334155" /></marker></defs><path d="M0 0L10 10" stroke="#334155" /></svg>',
      ),
    ).not.toThrow();
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject /></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" />',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/a.svg" /></svg>',
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" />',
  ])('rejects active or external SVG content', (source) => {
    expect(() => assertSafeDiagramSvg(source)).toThrow();
  });
});
