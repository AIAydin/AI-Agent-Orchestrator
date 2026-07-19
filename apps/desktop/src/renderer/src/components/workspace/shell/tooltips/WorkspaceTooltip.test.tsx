// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceTooltip } from './WorkspaceTooltip.js';

afterEach(cleanup);

describe('WorkspaceTooltip', () => {
  it('binds a visible tooltip description to its keyboard-focusable control', () => {
    const action = vi.fn();
    render(
      <WorkspaceTooltip content="Fit every node on the canvas">
        <button type="button" aria-label="Fit canvas" onClick={action}>
          Fit
        </button>
      </WorkspaceTooltip>,
    );

    const button = screen.getByRole('button', { name: 'Fit canvas' });
    const tooltip = screen.getByRole('tooltip');
    expect(button.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(tooltip.textContent).toBe('Fit every node on the canvas');

    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('provides a focusable status target when the described action is disabled', () => {
    render(
      <WorkspaceTooltip content="Nothing to undo">
        <button type="button" aria-label="Undo" disabled>
          Undo
        </button>
      </WorkspaceTooltip>,
    );

    const button = screen.getByRole('button', { name: 'Undo' });
    const statusTarget = screen.getByRole('group', { name: 'Undo unavailable' });
    const tooltip = screen.getByRole('tooltip');
    expect(button).toHaveProperty('disabled', true);
    expect(statusTarget.getAttribute('tabindex')).toBe('0');
    expect(statusTarget.getAttribute('aria-describedby')).toBe(tooltip.id);

    statusTarget.focus();
    expect(document.activeElement).toBe(statusTarget);
  });
});
