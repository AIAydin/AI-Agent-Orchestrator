// @vitest-environment jsdom

import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { GUEST_INSPECTION_EXPRESSION } from './preview-guest-agent.js';

interface Inspection {
  url: string;
  title: string;
  text: string;
  dom: string;
}

function evaluateInspection(): Inspection {
  // The expression ships to the page via executeJavaScript; evaluating the
  // exact same string against jsdom exercises the real serializer.
  return runInNewContext(GUEST_INSPECTION_EXPRESSION, { document, location }) as Inspection;
}

describe('GUEST_INSPECTION_EXPRESSION', () => {
  it('serializes a sanitized DOM outline without values, handlers, or script bodies', () => {
    document.title = 'Sample app';
    document.body.innerHTML = [
      '<main id="app" data-secret="hidden">',
      '<h1 class="hero">Revenue &lt;up&gt;</h1>',
      '<script>window.token = "leak";</script>',
      '<style>.hero { color: red }</style>',
      '<input id="email" type="email" placeholder="Email" value="user@example.com" onclick="steal()">',
      '<a href="/settings" aria-label="Open settings">Settings</a>',
      '</main>',
    ].join('');

    const inspection = evaluateInspection();
    expect(inspection.title).toBe('Sample app');
    expect(inspection.dom).toContain('<main id="app">');
    expect(inspection.dom).toContain('<h1 class="hero">Revenue &lt;up&gt;</h1>');
    expect(inspection.dom).toContain('<input id="email" type="email" placeholder="Email">');
    expect(inspection.dom).toContain('<a href="/settings" aria-label="Open settings">Settings</a>');
    expect(inspection.dom).not.toContain('script');
    expect(inspection.dom).not.toContain('leak');
    expect(inspection.dom).not.toContain('color: red');
    expect(inspection.dom).not.toContain('user@example.com');
    expect(inspection.dom).not.toContain('onclick');
    expect(inspection.dom).not.toContain('data-secret');
    expect(inspection.dom).not.toContain('hidden');
  });

  it('reports the page URL without query or hash', () => {
    const inspection = evaluateInspection();
    expect(inspection.url).toBe(`${location.origin}${location.pathname}`);
    expect(inspection.url).not.toContain('?');
  });
});
