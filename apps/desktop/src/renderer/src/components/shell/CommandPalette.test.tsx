// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette } from './CommandPalette.js';

afterEach(cleanup);

describe('CommandPalette accessibility', () => {
  it('exposes a listbox and runs the active option selected with arrow keys', () => {
    const runs = [vi.fn(), vi.fn(), vi.fn()];
    const onClose = vi.fn();
    render(
      <CommandPalette
        actions={runs.map((run, index) => ({
          id: `action-${index + 1}`,
          label: `Action ${index + 1}`,
          section: 'Test',
          run,
        }))}
        onClose={onClose}
      />,
    );

    const query = screen.getByRole('combobox', { name: 'Search commands' });
    const options = screen.getAllByRole('option');
    expect(query.getAttribute('name')).toBe('command-palette-query');
    expect(query.getAttribute('aria-controls')).toBe('command-palette-results');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(query, { key: 'ArrowDown' });
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(query, { key: 'ArrowUp' });
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(query, { key: 'ArrowUp' });
    expect(options[2]?.getAttribute('aria-selected')).toBe('true');
    expect(query.getAttribute('aria-activedescendant')).toBe(options[2]?.id);

    fireEvent.keyDown(query, { key: 'Enter' });
    expect(runs[2]).toHaveBeenCalledTimes(1);
    expect(runs[0]).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
