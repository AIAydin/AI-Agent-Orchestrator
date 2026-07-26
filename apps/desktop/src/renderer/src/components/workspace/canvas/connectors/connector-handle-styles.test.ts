import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The canvas connectors are one shared language: the same start dot and the same
 * end acceptor on a Codex agent, a Claude agent, a file node and a whiteboard.
 * They regressed once by being painted from `--node-accent`, the per-node
 * provider/kind colour, which made every node's handles a different colour.
 * These invariants keep the handle styling on the neutral foundation token.
 */
const canvasStylesheet = readFileSync(
  fileURLToPath(new URL('../../../../styles/workspace/canvas.css', import.meta.url)),
  'utf8',
);
const tokenStylesheet = readFileSync(
  fileURLToPath(new URL('../../../../styles/foundation/tokens.css', import.meta.url)),
  'utf8',
);

describe('canvas connector handle styling', () => {
  const handleRules = [
    ...canvasStylesheet.replaceAll(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]*)\{([^{}]*)\}/gu),
  ]
    .map(([, selector = '', declarations = '']) => ({
      selector: selector.trim(),
      declarations,
    }))
    .filter((rule) => rule.selector.includes('.node-handle'));

  it('never paints a handle from the per-node accent', () => {
    expect(handleRules.length).toBeGreaterThan(0);
    for (const rule of handleRules) {
      expect(rule.declarations, `${rule.selector} must not use --node-accent`).not.toContain(
        '--node-accent',
      );
    }
  });

  it('paints both the dot and the acceptor from the shared connector token', () => {
    const source = handleRules.find((rule) => rule.selector === '.node-handle.source');
    const target = handleRules.find((rule) => rule.selector === '.node-handle.target');

    expect(source?.declarations).toContain('var(--connector)');
    expect(target?.declarations).toContain('var(--connector)');
    // The start is solid, the end is an open socket the string plugs into.
    expect(source?.declarations).toContain('border: 0');
    expect(target?.declarations).toContain('border-left-color: transparent');
  });

  it('defines the connector tokens for both themes', () => {
    const light = tokenStylesheet.slice(0, tokenStylesheet.indexOf(":root[data-theme='dark']"));
    const dark = tokenStylesheet.slice(tokenStylesheet.indexOf(":root[data-theme='dark']"));

    for (const token of ['--connector:', '--connector-socket:']) {
      expect(light, `light theme must define ${token}`).toContain(token);
      expect(dark, `dark theme must define ${token}`).toContain(token);
    }
  });
});
