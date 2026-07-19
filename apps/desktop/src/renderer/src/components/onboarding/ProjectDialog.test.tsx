// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectDialog } from './ProjectDialog.js';

afterEach(cleanup);

describe('ProjectDialog accessibility', () => {
  it('names the dialog and its create-project controls', () => {
    render(<ProjectDialog mode="create" onClose={vi.fn()} onCreate={vi.fn()} onClone={vi.fn()} />);

    const dialog = screen.getByRole('dialog', {
      name: 'Create a local project',
    });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const close = screen.getByRole('button', { name: 'Close' });
    const closeTooltip = screen.getByRole('tooltip', {
      name: 'Close without creating or cloning a project',
    });
    expect(close.getAttribute('aria-describedby')).toBe(closeTooltip.id);
    expect(screen.getByLabelText('Project name').getAttribute('name')).toBe('project-name');
    expect(screen.getByLabelText('Location').getAttribute('name')).toBe('project-location');
    expect(
      screen.getByRole('checkbox', { name: /Start a Git repository/ }).getAttribute('name'),
    ).toBe('project-initialize-git');
  });
});
