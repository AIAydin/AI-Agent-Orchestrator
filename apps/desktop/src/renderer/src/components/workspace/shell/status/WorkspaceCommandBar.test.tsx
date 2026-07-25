// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../../../shared/application/contracts.js';
import { WorkspaceCommandBar } from '../WorkspaceCommandBar.js';

afterEach(cleanup);

describe('WorkspaceCommandBar', () => {
  it('provides reusable visible descriptions for every compact icon control', () => {
    render(<WorkspaceCommandBar {...commandBarProps()} />);

    const expected = [
      ['Undo', 'Nothing to undo'],
      ['Redo', 'Nothing to redo'],
      ['Zoom to fit the canvas', 'Fit every node on the canvas'],
      ['Hide project sidebar', 'Hide the project sidebar'],
      ['Settings', 'Open Forgeboard settings'],
    ] as const;
    for (const [buttonName, description] of expected) {
      const button = screen.getByRole('button', { name: buttonName });
      const tooltip = screen.getByRole('tooltip', { name: description });
      expect(button.getAttribute('aria-describedby')).toBe(tooltip.id);
    }
  });

  it('provides a persistent place to close and reopen the project sidebar', () => {
    const onToggleProjectSidebar = vi.fn();
    const { rerender } = render(
      <WorkspaceCommandBar
        {...commandBarProps()}
        onToggleProjectSidebar={onToggleProjectSidebar}
      />,
    );

    const hideButton = screen.getByRole('button', {
      name: 'Hide project sidebar',
    });
    expect(hideButton.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(hideButton);
    expect(onToggleProjectSidebar).toHaveBeenCalledTimes(1);

    rerender(
      <WorkspaceCommandBar
        {...commandBarProps()}
        projectSidebarOpen={false}
        onToggleProjectSidebar={onToggleProjectSidebar}
      />,
    );
    expect(screen.getByRole('button', { name: 'Show project sidebar' })).toBeTruthy();
  });

  it('mirrors the live persistence state in the save indicator', () => {
    const { rerender } = render(<WorkspaceCommandBar {...commandBarProps()} saveState="saving" />);
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Saving…');

    rerender(<WorkspaceCommandBar {...commandBarProps()} saveState="saved" />);
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Saved locally');

    rerender(<WorkspaceCommandBar {...commandBarProps()} saveState="error" />);
    expect(screen.getByRole('status', { name: 'Save status' }).textContent).toBe('Save failed');
  });

  it('omits workflow run actions while describing live workflow status', () => {
    render(<WorkspaceCommandBar {...commandBarProps()} workflowStatus="waiting-for-approval" />);

    expect(screen.queryByRole('button', { name: 'Run canvas' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run selected' })).toBeNull();
    const status = screen.getByRole('status', {
      name: /Workflow · waiting for approval/u,
    });
    expect(status.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip', { name: 'Workflow: waiting-for-approval' }).id,
    );
  });
});

function commandBarProps() {
  const callback = vi.fn();
  return {
    project: PROJECT,
    projectStatusAvailable: true,
    canvasName: 'Workshop',
    agents: [],
    saveState: 'saved' as const,
    canUndo: false,
    canRedo: false,
    workflowStatus: null,
    commandPaletteShortcut: '⌘K',
    collaborationEnabled: false,
    sharingStatus: 'not-connected' as const,
    projectSidebarOpen: true,
    onCloseProject: callback,
    onToggleProjectSidebar: callback,
    onUndo: callback,
    onRedo: callback,
    onFitCanvas: callback,
    onOpenGitReview: callback,
    onOpenCommands: callback,
    onOpenSettings: callback,
  };
}

const PROJECT: Project = {
  id: 'd95d6c69-8409-4f0d-bb42-940b38b0a703',
  name: 'accessible-project',
  path: '/tmp/accessible-project',
  openedAt: '2026-07-14T16:00:00.000Z',
  missing: false,
  health: {
    isGitRepository: true,
    branch: 'main',
    dirty: false,
    remotes: [],
    packageManager: 'unknown',
    frameworks: [],
    scripts: {},
    hasSubmodules: false,
    sensitiveWarnings: [],
  },
};
