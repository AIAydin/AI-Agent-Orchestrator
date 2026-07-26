// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { HelpSettings, HELP_PAGE_SIZE } from './HelpSettings.js';
import { HELP_ARTICLES, searchHelpArticles } from './help-content.js';

afterEach(cleanup);

describe('HelpSettings', () => {
  it('provides offline UI guidance and the active standard shortcut', () => {
    const view = render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    expect(screen.getByRole('heading', { name: 'Help & shortcuts' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Command palette' })).toBeTruthy();
    expect(screen.getByLabelText('Control or Command plus K').textContent).toBe('Ctrl/⌘ K');
    expect(screen.getByText('Standard preset · currently active')).toBeTruthy();
    expect(screen.getByText(`${HELP_ARTICLES.length} local guides`)).toBeTruthy();
    expect(screen.getByText('Run your first agent')).toBeTruthy();
    fireEvent.click(screen.getByText('Replay Getting started tour'));
    expect(screen.getByRole('heading', { name: 'Getting started tour', level: 4 })).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(view.container.querySelectorAll('a')).toHaveLength(0);
  });

  it('paginates every guide without trimming entries', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    const pageCount = Math.ceil(HELP_ARTICLES.length / HELP_PAGE_SIZE);
    expect(pageCount).toBeGreaterThan(1);
    expect(screen.getByText(`Page 1 of ${pageCount}`)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Previous help page' }).disabled,
    ).toBe(true);

    const seen = new Set<string>();
    const collectTitles = () => {
      for (const article of HELP_ARTICLES) {
        if (screen.queryByText(article.title) !== null) seen.add(article.id);
      }
    };
    collectTitles();
    for (let page = 1; page < pageCount; page += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Next help page' }));
      collectTitles();
    }
    expect(seen.size).toBe(HELP_ARTICLES.length);
    expect(screen.getByText(`Page ${pageCount} of ${pageCount}`)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next help page' }).disabled).toBe(
      true,
    );
    expect(screen.getByText('Understand what can leave this device')).toBeTruthy();
  });

  it('returns to the first page when a search begins', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    fireEvent.click(screen.getByRole('button', { name: 'Next help page' }));
    expect(screen.getByText(/Page 2 of/u)).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'agent' },
    });

    expect(screen.queryByText(/Page 2 of/u)).toBeNull();
    expect(screen.getByText(/matching guide/u)).toBeTruthy();
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
      screen.getByText('VS Code preset · not saved yet; Standard preset is still active'),
    ).toBeTruthy();
  });

  it('filters every guide term and expands the matching recovery steps', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'moved repository' },
    });

    expect(screen.getByText('1 matching guide')).toBeTruthy();
    expect(screen.getByText('A project was moved or renamed')).toBeTruthy();
    expect(screen.getByText(/Choose Locate project/u)).toBeTruthy();
    expect(screen.queryByText('Running agents in Docker is unavailable')).toBeNull();
  });

  it('describes exact reviewed remote delivery and the implemented Docker action', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'read-only comparison' },
    });
    expect(screen.getByText(/read-only comparison of everything the run saved/u)).toBeTruthy();
    expect(screen.getByText(/PR action on the agent node/u)).toBeTruthy();
    expect(screen.getByText(/Artemis never force-pushes/u)).toBeTruthy();
    expect(screen.getByText(/only checks your GitHub sign-in/u)).toBeTruthy();
    expect(screen.queryByText(/Add a Git \/ PR node/u)).toBeNull();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'docker image' },
    });
    expect(screen.getByText(/Select Check Docker/u)).toBeTruthy();
    expect(screen.queryByText(/Select Test Docker/u)).toBeNull();
  });

  it('troubleshoots remote delivery entirely through visible reviewed actions', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'non-fast-forward expired gh' },
    });

    expect(screen.getByText('1 matching guide')).toBeTruthy();
    expect(screen.getByText('Sharing your work online is blocked')).toBeTruthy();
    expect(screen.getByText(/names listed next to the Remote field/u)).toBeTruthy();
    expect(screen.getByText(/normal Git push still works/u)).toBeTruthy();
    expect(screen.getByText(/reports a head mismatch/u)).toBeTruthy();
    expect(screen.getByText(/rejected without force/u)).toBeTruthy();
  });

  it('covers preview collisions, honest Git conflicts, offline sharing, and database recovery', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);
    const search = screen.getByRole('searchbox', { name: 'Search local help' });

    fireEvent.change(search, { target: { value: 'preview collision occupied' } });
    expect(screen.getByText('A preview port is already in use')).toBeTruthy();
    expect(screen.getByText(/Do not kill an unrelated process/u)).toBeTruthy();

    fireEvent.change(search, { target: { value: 'git cherry-pick conflict' } });
    expect(screen.getByText('Git delivery stopped on a conflict')).toBeTruthy();
    expect(screen.getByText(/does not choose a side/u)).toBeTruthy();

    fireEvent.change(search, { target: { value: 'collaboration offline websocket' } });
    expect(screen.getByText('The collaboration server is offline')).toBeTruthy();
    expect(screen.getByText(/Solo persistence does not depend/u)).toBeTruthy();

    fireEvent.change(search, { target: { value: 'malformed database quarantine' } });
    expect(screen.getByText('An import or database recovery was rejected')).toBeTruthy();
    expect(screen.getByText(/never edits the backup in place/u)).toBeTruthy();
  });

  it('explains that agents work out of the box without a connection flow', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'sign in account codex' },
    });

    expect(screen.getByText('Agents work out of the box')).toBeTruthy();
    expect(screen.getByText(/finds installed CLIs automatically/u)).toBeTruthy();
    expect(screen.getByText(/never sees or stores provider credentials/u)).toBeTruthy();
    expect(screen.queryByText(/Connect with OpenAI/u)).toBeNull();
    expect(screen.queryByText(/OAuth/u)).toBeNull();
  });

  it('renders an actionable empty state for an unmatched search', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'nonexistent-frobnicator' },
    });

    expect(screen.getByText('0 matching guides')).toBeTruthy();
    expect(screen.getByText('No guides match your search')).toBeTruthy();
  });

  it('explains permission profiles and Docker boundaries without claiming cwd is a sandbox', () => {
    render(<HelpSettings keyboardPreset="standard" activeKeyboardPreset="standard" />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search local help' }), {
      target: { value: 'cwd sandbox' },
    });

    expect(screen.getByText('Choose what an agent may do')).toBeTruthy();
    expect(screen.getByText(/does not confine the agent/u)).toBeTruthy();
    expect(screen.getByText(/sign-ins — are never shared in/u)).toBeTruthy();
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
