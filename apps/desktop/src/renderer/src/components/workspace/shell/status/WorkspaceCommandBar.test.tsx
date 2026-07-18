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

    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);

    view.rerender(<WorkspaceCommandBar {...props} notificationsOpen />);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe('workspace-notifications');
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
