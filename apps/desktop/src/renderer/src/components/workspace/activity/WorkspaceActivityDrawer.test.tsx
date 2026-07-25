// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceActivityDrawer } from './WorkspaceActivityDrawer.js';

afterEach(cleanup);

describe('WorkspaceActivityDrawer', () => {
  it('links tabs to panels and supports roving arrow-key navigation', () => {
    render(<WorkspaceActivityDrawer {...props()} />);
    const activityTab = screen.getByRole('tab', { name: 'Activity' });
    const changesTab = screen.getByRole('tab', { name: 'Changes' });

    expect(activityTab.getAttribute('aria-controls')).toBe('workspace-panel-activity');
    expect(screen.getByRole('tabpanel', { name: 'Activity' }).id).toBe('workspace-panel-activity');

    activityTab.focus();
    fireEvent.keyDown(activityTab, { key: 'ArrowRight' });
    expect(changesTab.getAttribute('aria-selected')).toBe('true');
    expect(changesTab.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(changesTab);
    expect(screen.getByRole('tabpanel', { name: 'Changes' }).id).toBe('workspace-panel-changes');

    // History stays reachable; opening it is covered by the audit IPC flow.
    expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-controls')).toBe(
      'workspace-panel-audit',
    );

    // Workflows and Checks are gone from the drawer.
    expect(screen.queryByRole('tab', { name: 'Workflows' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Checks' })).toBeNull();
  });

  it('explains the compact close control and shows an honest empty activity state', () => {
    render(<WorkspaceActivityDrawer {...props()} events={[]} />);

    const close = screen.getByRole('button', { name: 'Close activity panel' });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toBe('Close the activity panel');
    expect(close.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(screen.getByRole('status').textContent).toBe('Run activity will appear here.');
  });

  it('opens primary review separately from eligible agent worktree reviews', () => {
    const onOpenGitReview = vi.fn();
    render(
      <WorkspaceActivityDrawer
        {...props()}
        onOpenGitReview={onOpenGitReview}
        changeReports={[
          {
            nodeId: 'writable',
            nodeKind: 'agent',
            title: 'Writable agent',
            status: 'failed',
            files: ['src/writable.ts'],
            runId: '0d62ff7a-479f-40a8-ab4e-030d5b96eb42',
            runPermissionProfile: 'worktree-write',
          },
          {
            nodeId: 'missing-run',
            nodeKind: 'agent',
            title: 'Legacy agent',
            status: 'succeeded',
            files: ['src/legacy.ts'],
            runId: null,
            runPermissionProfile: 'worktree-write',
          },
          {
            nodeId: 'read-only',
            nodeKind: 'agent',
            title: 'Planning agent',
            status: 'succeeded',
            files: ['notes/plan.md'],
            runId: '33cbcdbc-80a5-420b-b885-1921d84f9486',
            runPermissionProfile: 'plan-read-only',
          },
          {
            nodeId: 'running',
            nodeKind: 'agent',
            title: 'Running agent',
            status: 'running',
            files: ['src/running.ts'],
            runId: 'e650e2fa-6b2c-4cc4-b001-759e8c9fdb8e',
            runPermissionProfile: 'docker-isolated',
          },
          {
            nodeId: 'not-an-agent',
            nodeKind: 'task',
            title: 'Task metadata',
            status: 'succeeded',
            files: ['src/task.ts'],
            runId: 'c14534d9-3f19-47d3-80ef-36e399e92f55',
            runPermissionProfile: 'worktree-write',
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review project changes' }));
    expect(onOpenGitReview).toHaveBeenLastCalledWith();

    const worktreeActions = screen.getAllByRole('button', {
      name: 'Review this agent’s changes',
    });
    expect(worktreeActions).toHaveLength(1);
    fireEvent.click(worktreeActions[0] as HTMLButtonElement);
    expect(onOpenGitReview).toHaveBeenLastCalledWith('0d62ff7a-479f-40a8-ab4e-030d5b96eb42');
  });
});

function props(): React.ComponentProps<typeof WorkspaceActivityDrawer> {
  return {
    events: ['Project opened.'],
    changeReports: [],
    onOpenGitReview: vi.fn(),
    onClose: vi.fn(),
  };
}
