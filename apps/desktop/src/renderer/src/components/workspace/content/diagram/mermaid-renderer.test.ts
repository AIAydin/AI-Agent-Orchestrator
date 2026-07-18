// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { renderMermaidDiagram, renderMermaidSvg } from './mermaid-renderer.js';

describe('safe Mermaid renderer', () => {
  it('sanitizes active generated markup and applies inert presentation attributes', async () => {
    const svg = await renderMermaidSvg('flowchart LR\nA-->B', () =>
      Promise.resolve({
        svg: `<svg xmlns="http://www.w3.org/2000/svg" onload="attack()">
        <style>.node { background: url(https://evil.example) }</style>
        <foreignObject><img src="https://evil.example/pixel" /></foreignObject>
        <a href="javascript:attack()"><text>unsafe</text></a>
        <rect class="node" width="20" height="10" />
        <path class="edge" d="M0 0L20 10" />
      </svg>`,
      }),
    );

    expect(svg).not.toMatch(/script|foreignObject|onload|javascript:|evil\.example|<style|class=/u);
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(document.querySelector('rect')?.getAttribute('fill')).toBe('#f1f0ff');
    expect(document.querySelector('path')?.getAttribute('stroke')).toBe('#475569');
  });

  it('does not let Mermaid init directives enable HTML labels or external links', async () => {
    Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', {
      configurable: true,
      value: () => 80,
    });
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 80, height: 20 }),
    });
    const svg = await renderMermaidDiagram(`%%{init: {"securityLevel":"loose","htmlLabels":true}}%%
flowchart LR
  A[Safe] --> B[Review]
  click A "https://evil.example/collect"
`);
    expect(svg).not.toMatch(/<a|foreignObject|evil\.example|javascript:|onerror|onclick/u);
    expect(svg).toContain('<svg');
    expect(svg).toContain('<text');
  });
});
