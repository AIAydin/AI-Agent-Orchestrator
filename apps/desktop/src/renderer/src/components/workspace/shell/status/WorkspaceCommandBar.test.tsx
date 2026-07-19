// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../../../shared/application/contracts.js';
import { WorkspaceCommandBar } from '../WorkspaceCommandBar.js';

afterEach(cleanup);

describe('WorkspaceCommandBar notifications', () => {
  it('binds its trigger to the managed notifications dialog only while it is open', () => {
    const props = commandBarProps();
    const view = render(<WorkspaceCommandBar {...props} notificationsOpen={false} />);
    const trigger = screen.getByRole('button', { name: 'Notifications' });
    const tooltip = screen.getByRole('tooltip', {
      name: 'Local notifications',
    });

    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);

    view.rerender(<WorkspaceCommandBar {...props} notificationsOpen />);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe('workspace-notifications');
  });

  it('provides reusable visible descriptions for every compact icon control', () => {
    render(<WorkspaceCommandBar {...commandBarProps()} notificationsOpen={false} />);

    const expected = [
      ['Undo', 'Nothing to undo'],
      ['Redo', 'Nothing to redo'],
      ['Zoom to fit the canvas', 'Fit every node on the canvas'],
      ['Notifications', 'Local notifications'],
      ['Settings', 'Open Forgeboard settings'],
    ] as const;
    for (const [buttonName, description] of expected) {
      const button = screen.getByRole('button', { name: buttonName });
      const tooltip = screen.getByRole('tooltip', { name: description });
      expect(button.getAttribute('aria-describedby')).toBe(tooltip.id);
    }
  });

  it('describes disabled workflow actions and live workflow status without native titles', () => {
    render(
      <WorkspaceCommandBar
        {...commandBarProps()}
        notificationsOpen={false}
        workflowStatus="waiting-for-approval"
      />,
    );

    const expected = [
      [
        'Run canvas',
        'Add an Agent, Test, Review gate, or Diff/review node before running this canvas',
      ],
      ['Run selected', 'Select a runnable node.'],
    ] as const;
    for (const [name, explanation] of expected) {
      const button = screen.getByRole('button', { name });
      const tooltip = screen.getByRole('tooltip', { name: explanation });
      expect(button).toHaveProperty('disabled', true);
      expect(button.getAttribute('title')).toBeNull();
      expect(button.getAttribute('aria-describedby')).toBe(tooltip.id);
    }
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
    workflowBusy: false,
    canRunWorkflow: false,
    canRunSelected: false,
    runSelectedReason: 'Select a runnable node.',
    commandPaletteShortcut: '⌘K',
    collaborationEnabled: false,
    sharingStatus: 'not-connected' as const,
    onCloseProject: callback,
    onUndo: callback,
    onRedo: callback,
    onFitCanvas: callback,
    onRunWorkflow: callback,
    onRunSelected: callback,
    onOpenGitReview: callback,
    onOpenCommands: callback,
    onToggleNotifications: callback,
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
