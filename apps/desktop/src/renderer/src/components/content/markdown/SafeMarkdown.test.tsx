// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SafeMarkdown } from './SafeMarkdown.js';
import { parseSafeMarkdown, safeMarkdownUrl } from './markdown-model.js';

afterEach(cleanup);

describe('SafeMarkdown', () => {
  it('renders common authoring blocks without injecting project-authored HTML', () => {
    const { container } = render(
      <SafeMarkdown
        markdown={[
          '# Release plan',
          '',
          '- [x] Preserve **local data**',
          '- [ ] Verify `pnpm test`',
          '',
          '<img src=x onerror="globalThis.pwned=true"><script>alert(1)</script>',
          '',
          '```ts',
          'const value = "<unsafe>";',
          '```',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Release plan' })).toBeTruthy();
    const completed = screen.getByRole('checkbox', { name: 'Completed item' });
    const incomplete = screen.getByRole('checkbox', {
      name: 'Incomplete item',
    });
    if (!(completed instanceof HTMLInputElement) || !(incomplete instanceof HTMLInputElement)) {
      throw new Error('Markdown checklist controls must be checkbox inputs.');
    }
    expect(completed.checked).toBe(true);
    expect(incomplete.checked).toBe(false);
    expect(screen.getByText('local data')).toHaveProperty('tagName', 'STRONG');
    expect(screen.getByText('pnpm test')).toHaveProperty('tagName', 'CODE');
    expect(screen.getByText(/<img src=x onerror/)).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toContain('const value = "<unsafe>";');
  });

  it('makes accepted links caller-controlled and renders unsafe links inert', () => {
    const open = vi.fn();
    render(
      <SafeMarkdown
        markdown={[
          '[Docs](https://example.com/guide)',
          '[Attack](javascript:alert(1))',
          '[Credentials](https://user:secret@example.com/private)',
        ].join('\n')}
        onOpenLink={open}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    expect(open).toHaveBeenCalledWith('https://example.com/guide');
    expect(screen.queryByRole('button', { name: 'Attack' })).toBeNull();
    expect(screen.getByText('Attack').getAttribute('title')).toBe(
      'This link was blocked for safety',
    );
    expect(screen.getByText('Credentials').getAttribute('title')).toBe(
      'This link was blocked for safety',
    );
  });

  it('does not expose a dead link control when no approved opener is available', () => {
    render(<SafeMarkdown markdown="[Docs](https://example.com/guide)" />);

    expect(screen.queryByRole('button', { name: 'Docs' })).toBeNull();
    expect(screen.getByText('Docs').getAttribute('title')).toContain('not available here');
  });

  it('parses headings, quotes, ordered lists, rules, and unterminated fences deterministically', () => {
    expect(
      parseSafeMarkdown(
        [
          '## Review',
          '> One',
          '> Two',
          '',
          '4. Four',
          '5. Five',
          '',
          '---',
          '',
          '```sh',
          'echo ok',
        ].join('\n'),
      ).map((block) => block.kind),
    ).toEqual(['heading', 'quote', 'list', 'rule', 'code']);
  });

  it('bounds adversarial preview complexity without discarding the editable source', () => {
    const manyLines = Array.from({ length: 5_100 }, (_, index) => `line ${index}`).join('\n\n');
    render(<SafeMarkdown markdown={manyLines} />);

    expect(screen.getByRole('status').textContent).toContain('full text');
    expect(screen.queryByText('line 5099')).toBeNull();
  });
});

describe('safeMarkdownUrl', () => {
  it('accepts explicit web/mail destinations and rejects executable, credentialed, and relative URLs', () => {
    expect(safeMarkdownUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
    expect(safeMarkdownUrl('mailto:person@example.com')).toBe('mailto:person@example.com');
    expect(safeMarkdownUrl('javascript:alert(1)')).toBeNull();
    expect(safeMarkdownUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeMarkdownUrl('https://user:secret@example.com')).toBeNull();
    expect(safeMarkdownUrl('../local-file')).toBeNull();
  });
});
