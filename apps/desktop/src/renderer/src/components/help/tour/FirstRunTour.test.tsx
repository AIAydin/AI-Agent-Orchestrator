// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { FirstRunTour } from './FirstRunTour.js';

afterEach(cleanup);

describe('FirstRunTour', () => {
  it('guides four local UI stops without links, network actions, or configuration controls', () => {
    const view = render(<FirstRunTour keyboardPreset="standard" headingLevel={2} />);

    expect(screen.getByRole('heading', { name: 'Getting started tour', level: 2 })).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('tabpanel').textContent).toContain('Step 1 of 4');
    expect(screen.getByText(/contacts nothing/u)).toBeTruthy();
    expect(screen.getByText(/changes none of your projects or settings/u)).toBeTruthy();
    expect(view.container.querySelectorAll('a, input, select, textarea')).toHaveLength(0);
  });

  it('supports roving keyboard navigation and exposes shortcuts, review, privacy, and recovery', () => {
    render(<FirstRunTour keyboardPreset="vscode" headingLevel={4} />);

    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' });
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    expect(screen.getByRole('tabpanel').textContent).toContain('F1 or Ctrl/⌘ Shift P');

    fireEvent.keyDown(tabs[1] as HTMLElement, { key: 'End' });
    expect(tabs[3]?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByRole('tabpanel').textContent).toMatch(/Data & privacy/u);
    expect(screen.getByRole('tabpanel').textContent).toMatch(/troubleshooting/u);

    fireEvent.click(screen.getByRole('button', { name: 'Restart tour' }));
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
  });
});
