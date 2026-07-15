// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarkdownComposer } from './MarkdownComposer.js';

afterEach(cleanup);

describe('MarkdownComposer', () => {
  it('edits controlled source and switches between accessible source and safe preview modes', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MarkdownComposer label="Brief" value="# First" onChange={onChange} initialMode="edit" />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Brief Markdown source' }), {
      target: { value: '# Second' },
    });
    expect(onChange).toHaveBeenCalledWith('# Second');

    rerender(
      <MarkdownComposer label="Brief" value="# Second" onChange={onChange} initialMode="edit" />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.queryByRole('textbox', { name: 'Brief Markdown source' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Brief preview' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Second' })).toBeTruthy();
  });

  it('keeps a locked editor read-only and never creates executable HTML in preview', () => {
    const onChange = vi.fn();
    const { container } = render(
      <MarkdownComposer
        label="Note"
        value={'<script>globalThis.pwned = true</script>\n\n[Run](javascript:alert(1))'}
        onChange={onChange}
        readOnly
      />,
    );

    const source = screen.getByRole('textbox', {
      name: 'Note Markdown source',
    });
    expect(source.getAttribute('readonly')).not.toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
    fireEvent.change(source, { target: { value: 'changed' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('supports the expected arrow, Home, and End keyboard behavior for mode tabs', () => {
    render(<MarkdownComposer label="Brief" value="# Keyboard" onChange={vi.fn()} />);

    const split = screen.getByRole('tab', { name: 'Split' });
    split.focus();
    fireEvent.keyDown(split, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('textbox', { name: 'Brief Markdown source' })).toBeNull();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Preview' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Edit' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Brief Markdown source' })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Edit' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true');
  });
});
