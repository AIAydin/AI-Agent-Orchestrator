// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarkdownComposer } from './MarkdownComposer.js';

afterEach(cleanup);

describe('MarkdownComposer', () => {
  it('renders the label and shows the controlled value', () => {
    render(<MarkdownComposer label="Brief" value="# First" onChange={vi.fn()} />);

    expect(screen.getByText('Brief')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Brief Markdown source' })).toHaveProperty(
      'value',
      '# First',
    );
  });

  it('calls onChange when typing', () => {
    const onChange = vi.fn();
    render(<MarkdownComposer label="Brief" value="# First" onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Brief Markdown source' }), {
      target: { value: '# Second' },
    });
    expect(onChange).toHaveBeenCalledWith('# Second');
  });

  it('keeps a locked editor read-only and never calls onChange', () => {
    const onChange = vi.fn();
    render(<MarkdownComposer label="Note" value="locked" onChange={onChange} readOnly />);

    const source = screen.getByRole('textbox', { name: 'Note Markdown source' });
    expect(source.getAttribute('readonly')).not.toBeNull();
    fireEvent.change(source, { target: { value: 'changed' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses emptyLabel as the textarea placeholder', () => {
    render(
      <MarkdownComposer
        label="Note"
        value=""
        onChange={vi.fn()}
        emptyLabel="Write a note that stays on this device."
      />,
    );

    expect(screen.getByPlaceholderText('Write a note that stays on this device.')).toBeTruthy();
  });
});
