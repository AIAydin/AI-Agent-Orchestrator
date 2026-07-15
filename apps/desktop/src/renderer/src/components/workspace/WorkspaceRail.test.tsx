// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../shared/contracts.js';
import { WorkspaceRail } from './WorkspaceRail.js';

const project: Project = {
  id: 'd95d6c69-8409-4f0d-bb42-940b38b0a703',
  name: 'accessible-project',
  path: '/tmp/accessible-project',
  openedAt: '2026-07-14T16:00:00.000Z',
  missing: false,
  health: {
    isGitRepository: true,
    branch: 'main',
    dirty: true,
    remotes: [],
    packageManager: 'unknown',
    frameworks: [],
    scripts: {},
    hasSubmodules: false,
    sensitiveWarnings: [],
  },
};

afterEach(cleanup);

describe('WorkspaceRail accessibility', () => {
  it('exposes selected-tab, search, and repository status semantics', () => {
    const props = {
      project,
      search: '',
      templates: [],
      extensionTemplates: [],
      nodes: [],
      initializingGit: false,
      onTabChange: vi.fn(),
      onSearchChange: vi.fn(),
      onAddNode: vi.fn(),
      onAddExtensionNode: vi.fn(),
      onInitializeGit: vi.fn(),
      onSelectNode: vi.fn(),
    };
    const { rerender } = render(<WorkspaceRail {...props} tab="project" />);

    expect(screen.getByRole('button', { name: 'Project' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Nodes' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(
      screen.getByRole('textbox', { name: 'Search node templates' }).getAttribute('name'),
    ).toBe('workspace-rail-search');
    expect(screen.getByRole('img', { name: 'Repository has uncommitted changes' })).toBeTruthy();

    rerender(<WorkspaceRail {...props} tab="nodes" />);
    expect(screen.getByRole('button', { name: 'Nodes' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Search canvas nodes' })).toBeTruthy();
  });

  it('offers an explicit UI path for initializing an existing non-Git folder', () => {
    const onInitializeGit = vi.fn();
    render(
      <WorkspaceRail
        project={{
          ...project,
          health: { ...project.health, isGitRepository: false, branch: null, dirty: false },
        }}
        tab="project"
        search=""
        templates={[]}
        extensionTemplates={[]}
        nodes={[]}
        initializingGit={false}
        onTabChange={vi.fn()}
        onSearchChange={vi.fn()}
        onAddNode={vi.fn()}
        onAddExtensionNode={vi.fn()}
        onInitializeGit={onInitializeGit}
        onSelectNode={vi.fn()}
      />,
    );

    expect(screen.getByText('Existing files stay untouched and uncommitted.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Git…' }));
    expect(onInitializeGit).toHaveBeenCalledTimes(1);
  });
});
