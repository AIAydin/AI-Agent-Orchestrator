// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../../shared/application/contracts.js';
import { WORKFLOW_TEMPLATES } from '../workflows/templates/catalog.js';
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
      workflowTemplates: [],
      extensionTemplates: [],
      nodes: [],
      fileOperations: fileOperations(),
      initializingGit: false,
      collaborationGraphReadOnly: false,
      onTabChange: vi.fn(),
      onSearchChange: vi.fn(),
      onAddNode: vi.fn(),
      onAddWorkflowTemplate: vi.fn(),
      onAddExtensionNode: vi.fn(),
      onInitializeGit: vi.fn(),
      onSelectNode: vi.fn(),
      onAttachAgentContext: vi.fn(),
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

    rerender(<WorkspaceRail {...props} tab="nodes" />);
    expect(screen.getByRole('button', { name: 'Nodes' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Search canvas nodes' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('No matching nodes on this canvas.');
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
        workflowTemplates={[]}
        extensionTemplates={[]}
        nodes={[]}
        fileOperations={fileOperations()}
        initializingGit={false}
        collaborationGraphReadOnly={false}
        onTabChange={vi.fn()}
        onSearchChange={vi.fn()}
        onAddNode={vi.fn()}
        onAddWorkflowTemplate={vi.fn()}
        onAddExtensionNode={vi.fn()}
        onInitializeGit={onInitializeGit}
        onSelectNode={vi.fn()}
        onAttachAgentContext={vi.fn()}
      />,
    );

    expect(screen.getByText('Your files stay exactly as they are.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up Git…' }));
    expect(onInitializeGit).toHaveBeenCalledTimes(1);
  });

  it('offers every first-party workflow template and inserts the selected catalog entry', () => {
    const onAddWorkflowTemplate = vi.fn();
    render(
      <WorkspaceRail
        project={project}
        tab="project"
        search=""
        templates={[]}
        workflowTemplates={WORKFLOW_TEMPLATES}
        extensionTemplates={[]}
        nodes={[]}
        fileOperations={fileOperations()}
        initializingGit={false}
        collaborationGraphReadOnly={false}
        onTabChange={vi.fn()}
        onSearchChange={vi.fn()}
        onAddNode={vi.fn()}
        onAddWorkflowTemplate={onAddWorkflowTemplate}
        onAddExtensionNode={vi.fn()}
        onInitializeGit={vi.fn()}
        onSelectNode={vi.fn()}
        onAttachAgentContext={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Workflow templates' })).toBeTruthy();
    for (const template of WORKFLOW_TEMPLATES) {
      expect(screen.getByRole('button', { name: new RegExp(template.name, 'u') })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: /Implement \/ review loop/u }));
    expect(onAddWorkflowTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'implement-review-loop' }),
    );
  });

  it('disables workflow template insertion for a view-only collaborator', () => {
    render(
      <WorkspaceRail
        project={project}
        tab="project"
        search=""
        templates={[]}
        collaborationGraphReadOnly
        workflowTemplates={WORKFLOW_TEMPLATES}
        extensionTemplates={[]}
        nodes={[]}
        fileOperations={fileOperations()}
        initializingGit={false}
        onTabChange={vi.fn()}
        onSearchChange={vi.fn()}
        onAddNode={vi.fn()}
        onAddWorkflowTemplate={vi.fn()}
        onAddExtensionNode={vi.fn()}
        onInitializeGit={vi.fn()}
        onSelectNode={vi.fn()}
        onAttachAgentContext={vi.fn()}
      />,
    );

    for (const template of WORKFLOW_TEMPLATES) {
      expect(
        screen
          .getByRole('button', { name: new RegExp(template.name, 'u') })
          .hasAttribute('disabled'),
      ).toBe(true);
    }
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
