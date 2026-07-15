// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SafeSvgImage } from './SafeSvgImage.js';
import { sanitizeSvg, svgDataUrl } from './sanitize-svg.js';

afterEach(cleanup);

describe('sanitizeSvg', () => {
  it('removes active content, foreign HTML, event handlers, styles, and remote resources', () => {
    const sanitized = sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="attack()">
        <script>attack()</script>
        <foreignObject><iframe src="https://evil.example" /></foreignObject>
        <image href="https://evil.example/pixel" />
        <a href="javascript:attack()"><text>bad link</text></a>
        <rect id="safe" width="10" height="10" style="background:url(https://evil.example)" fill="red" />
      </svg>
    `);

    const document = new DOMParser().parseFromString(sanitized, 'image/svg+xml');
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('foreignObject')).toBeNull();
    expect(document.querySelector('image')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    const rectangle = document.querySelector('rect');
    expect(rectangle?.getAttribute('onload')).toBeNull();
    expect(rectangle?.getAttribute('style')).toBeNull();
    expect(rectangle?.getAttribute('fill')).toBe('red');
    expect(document.documentElement.getAttribute('onload')).toBeNull();
  });

  it('keeps local gradients and fragment references while stripping external or credentialed URLs', () => {
    const sanitized = sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="paint"><stop offset="0" stop-color="#fff" /></linearGradient></defs>
        <rect fill="url(#paint)" clip-path="url(#clip)" />
        <use href="#shape" />
        <use href="https://example.com/image.svg#shape" />
      </svg>
    `);
    const document = new DOMParser().parseFromString(sanitized, 'image/svg+xml');
    expect(document.querySelector('rect')?.getAttribute('fill')).toBe('url(#paint)');
    expect(document.querySelector('rect')?.getAttribute('clip-path')).toBe('url(#clip)');
    const uses = document.querySelectorAll('use');
    expect(uses[0]?.getAttribute('href')).toBe('#shape');
    expect(uses[1]?.getAttribute('href')).toBeNull();
  });

  it('rebuilds safe content in the SVG namespace and drops foreign-namespace lookalikes', () => {
    const sanitized = sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
        <g xmlns="https://evil.example/vector"><text>foreign</text></g>
        <text>local</text>
      </svg>
    `);
    const document = new DOMParser().parseFromString(sanitized, 'image/svg+xml');
    expect(document.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(document.querySelectorAll('g')).toHaveLength(0);
    expect(document.querySelector('text')?.textContent).toBe('local');
    expect(sanitized).not.toContain('evil.example');

    const namespaceLess = sanitizeSvg('<svg><circle id="safe" r="4" /></svg>');
    const normalized = new DOMParser().parseFromString(namespaceLess, 'image/svg+xml');
    expect(normalized.querySelector('circle')?.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  it('rejects declarations, malformed input, non-SVG roots, and over-sized values', () => {
    expect(() => sanitizeSvg('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" />')).toThrow(
      'declarations',
    );
    expect(() => sanitizeSvg('<svg><broken></svg>')).toThrow('malformed');
    expect(() => sanitizeSvg('<html />')).toThrow('no SVG root');
    expect(() => sanitizeSvg('<svg xmlns="https://evil.example/vector" />')).toThrow('namespace');
    expect(() => sanitizeSvg('x'.repeat(2_000_001))).toThrow('2,000,000');
  });

  it('creates only a local encoded image URL', () => {
    const url = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><text>safe</text></svg>');
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url)).toContain('<text>safe</text>');
  });
});

describe('SafeSvgImage', () => {
  it('renders valid sanitized source as an image and reports invalid source without injection', () => {
    const { rerender } = render(
      <SafeSvgImage
        source={'<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>'}
        alt="Diagram"
      />,
    );
    expect(
      screen.getByRole('img', { name: 'Diagram' }).getAttribute('src')?.startsWith('data:'),
    ).toBe(true);

    rerender(<SafeSvgImage source="<script>attack()</script>" alt="Diagram" />);
    expect(screen.queryByRole('img', { name: 'Diagram' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('SVG root');
  });
});
