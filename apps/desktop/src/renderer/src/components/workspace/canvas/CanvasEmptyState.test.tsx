// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasEmptyState } from './CanvasEmptyState.js';

afterEach(cleanup);

describe('CanvasEmptyState', () => {
  it('offers exactly one action: adding an agent', () => {
    const onAddAgent = vi.fn();
    render(<CanvasEmptyState readOnly={false} onAddAgent={onAddAgent} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('Add an agent');
    fireEvent.click(buttons[0] as HTMLButtonElement);
    expect(onAddAgent).toHaveBeenCalledTimes(1);
  });

  it('disables the action while the shared canvas is read-only', () => {
    const onAddAgent = vi.fn();
    render(<CanvasEmptyState readOnly onAddAgent={onAddAgent} />);

    const button = screen.getByRole('button', { name: 'Add an agent' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onAddAgent).not.toHaveBeenCalled();
  });
});
