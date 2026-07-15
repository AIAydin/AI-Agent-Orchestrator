// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { HelpSettings } from './HelpSettings.js';
import { HELP_ARTICLES, searchHelpArticles } from './help-content.js';

afterEach(cleanup);

describe('HelpSettings', () => {
  it('provides offline UI guidance and the active standard shortcut', () => {
    const view = render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    expect(screen.getByRole('heading', { name: 'Help & shortcuts' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Command palette' })).toBeTruthy();
    expect(screen.getByLabelText('Control or Command plus K').textContent).toBe('Ctrl/⌘ K');
    expect(screen.getByText('Standard preset · currently active')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(`${HELP_ARTICLES.length} local guides`);
    expect(screen.getByText('Run your first agent')).toBeTruthy();
    expect(screen.getByText('Understand what can leave this device')).toBeTruthy();
    expect(view.container.querySelectorAll('a')).toHaveLength(0);
  });

  it('shows the VS Code palette shortcut without implying it is configurable in code', () => {
    render(<HelpSettings keyboardPreset="vscode" activeKeyboardPreset="vscode" />);

    expect(screen.getByLabelText('F1 or Control or Command plus Shift plus P').textContent).toBe(
      'F1 or Ctrl/⌘ Shift P',
    );
    expect(screen.getByText('VS Code preset · currently active')).toBeTruthy();
  });

  it('does not present an unsaved draft shortcut as active', () => {
    render(<HelpSettings keyboardPreset="vscode" activeKeyboardPreset="standard" />);

    expect(
      screen.getByText('VS Code preset · unsaved; Standard preset remains active'),
    ).toBeTruthy();
  });

  it('filters every guide term and expands the matching recovery steps', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'moved repository' },
    });

    expect(screen.getByRole('status').textContent).toBe('1 matching guide');
    expect(screen.getByText('A project was moved or renamed')).toBeTruthy();
    expect(screen.getByText(/Choose Locate project/u)).toBeTruthy();
    expect(screen.queryByText('Docker isolation is unavailable')).toBeNull();
  });

  it('describes the implemented Git views and Docker action without claiming unavailable flows', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'committed immutable base' },
    });
    expect(screen.getByText(/read-only view of committed work/u)).toBeTruthy();
    expect(
      screen.getByText(/Merge, push, and pull-request controls are not available yet/u),
    ).toBeTruthy();
    expect(screen.queryByText(/include both committed and uncommitted/u)).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'docker readiness' },
    });
    expect(screen.getByText(/Select Check Docker/u)).toBeTruthy();
    expect(screen.queryByText(/Select Test Docker/u)).toBeNull();
  });

  it('renders an actionable empty state for an unmatched search', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'nonexistent-frobnicator' },
    });

    expect(screen.getByRole('status').textContent).toBe('0 matching guides');
    expect(screen.getByText('No matching local guide')).toBeTruthy();
  });

  it('explains Custom host and Docker boundaries without claiming cwd is a sandbox', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'custom cwd sandbox' },
    });

    expect(screen.getByText('Build a Custom permission profile')).toBeTruthy();
    expect(screen.getByText(/cwd is not an operating-system sandbox/u)).toBeTruthy();
    expect(screen.getByText(/one whole-worktree read-only or read-write mount/u)).toBeTruthy();
  });
});

describe('searchHelpArticles', () => {
  it('uses AND matching across titles, summaries, keywords, and instructions', () => {
    expect(searchHelpArticles('docker credentials').map((article) => article.id)).toEqual([
      'docker-readiness',
      'custom-permissions',
    ]);
    expect(searchHelpArticles('approval exact plan').map((article) => article.id)).toEqual([
      'run-will-not-start',
    ]);
    expect(searchHelpArticles('   ')).toBe(HELP_ARTICLES);
  });
});
