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

    fireEvent.click(screen.getByRole('tab', { name: 'Checks' }));
    expect(screen.getByRole('tabpanel', { name: 'Checks' }).id).toBe('workspace-panel-checks');
  });
});

function props(): React.ComponentProps<typeof WorkspaceActivityDrawer> {
  return {
    events: ['Project opened.'],
    changeReports: [],
    checkCommands: [
      {
        id: 'lint',
        label: 'Lint',
        command: { executable: 'node', arguments: ['--version'] },
        detectedScript: undefined,
      },
    ],
    latestChecks: new Map(),
    busyCheckId: null,
    onPrepareCheck: vi.fn(),
    onCancelCheck: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenGitReview: vi.fn(),
    onClose: vi.fn(),
  };
}
