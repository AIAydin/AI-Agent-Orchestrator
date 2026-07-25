// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDetection, Project } from '../../../../../shared/application/contracts.js';
import { WorkspaceRail } from './WorkspaceRail.js';

const claudeAgent: AgentDetection & { id: 'claude' } = {
  id: 'claude',
  label: 'Claude Code',
  installed: true,
  executable: '/tmp/claude',
  version: '1.0.0',
  providerDisclosure: 'Local only.',
};

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
      fileOperations: fileOperations(),
      initializingGit: false,
      collaborationGraphReadOnly: false,
      runnableAgents: [],
      onTabChange: vi.fn(),
      onSearchChange: vi.fn(),
      onAddNode: vi.fn(),
      onAddAgentNode: vi.fn(),
      onAddExtensionNode: vi.fn(),
      onInitializeGit: vi.fn(),
      onSelectNode: vi.fn(),
      onAttachAgentContext: vi.fn(),
      onOpenProjectFile: vi.fn(),
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
    expect(
      screen.getByRole('img', {
        name: 'Project has changes not yet recorded in Git',
      }),
    ).toBeTruthy();
    expect(screen.queryByText('Private file protection on')).toBeNull();

    rerender(<WorkspaceRail {...props} tab="nodes" />);
    expect(screen.getByRole('button', { name: 'Nodes' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Search canvas nodes' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('No matching nodes on this canvas.');

    rerender(<WorkspaceRail {...props} tab="nodes" hidden />);
    expect(document.querySelector('#workspace-project-sidebar')?.hasAttribute('hidden')).toBe(true);
  });

  it('offers an explicit UI path for initializing an existing non-Git folder', () => {
    const onInitializeGit = vi.fn();
    render(
      <WorkspaceRail
        project={{
          ...project,
          health: {
            ...project.health,
            isGitRepository: false,
            branch: null,
            dirty: false,
          },
        }}
        tab="project"
        search=""
        templates={[]}
        extensionTemplates={[]}
        nodes={[]}
        fileOperations={fileOperations()}
        initializingGit={false}
        collaborationGraphReadOnly={false}
        runnableAgents={[]}
        onTabChange={vi.fn()}
        onSearchChange={vi.fn()}
        onAddNode={vi.fn()}
        onAddAgentNode={vi.fn()}
        onAddExtensionNode={vi.fn()}
        onInitializeGit={onInitializeGit}
        onSelectNode={vi.fn()}
        onAttachAgentContext={vi.fn()}
        onOpenProjectFile={vi.fn()}
      />,
    );

    expect(screen.getByText('Your files stay exactly as they are.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up Git…' }));
    expect(onInitializeGit).toHaveBeenCalledTimes(1);
  });

  it('offers an entry for each runnable agent and inserts the selected provider', () => {
    const onAddAgentNode = vi.fn();
    render(
      <WorkspaceRail
        project={project}
        tab="project"
        search=""
        templates={[]}
        extensionTemplates={[]}
        nodes={[]}
        fileOperations={fileOperations()}
        initializingGit={false}
        collaborationGraphReadOnly={false}
        runnableAgents={[claudeAgent]}
        onTabChange={vi.fn()}
        onSearchChange={vi.fn()}
        onAddNode={vi.fn()}
        onAddAgentNode={onAddAgentNode}
        onAddExtensionNode={vi.fn()}
        onInitializeGit={vi.fn()}
        onSelectNode={vi.fn()}
        onAttachAgentContext={vi.fn()}
        onOpenProjectFile={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Agents' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/u }));
    expect(onAddAgentNode).toHaveBeenCalledWith('claude');
  });
});

function fileOperations() {
  return {
    tree: vi.fn().mockResolvedValue({
      projectId: project.id,
      directory: '.',
      entries: [],
      truncated: false,
    }),
    search: vi.fn(),
    read: vi.fn(),
  };
}
