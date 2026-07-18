// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceNotifications } from '../WorkspaceOverlays.js';

afterEach(cleanup);

describe('WorkspaceNotifications', () => {
  it('shows an honest empty state and closes locally', () => {
    const onClose = vi.fn();
    render(<WorkspaceNotifications events={[]} onClose={onClose} />);

    expect(screen.getByRole('status').textContent).toBe('No local notifications yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Close notifications' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('announces a dialog, focuses its close action, closes with Escape, and restores focus', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Notifications';
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const { unmount } = render(
      <WorkspaceNotifications events={['Run finished.']} onClose={onClose} />,
    );

    expect(screen.getByRole('dialog', { name: 'Local notifications' })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close notifications' }),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('closes when focus remains elsewhere and the user points outside the popover', () => {
    const onClose = vi.fn();
    render(<WorkspaceNotifications events={['Run finished.']} onClose={onClose} />);

    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('bounds the visible local event history', () => {
    render(
      <WorkspaceNotifications
        events={Array.from({ length: 8 }, (_, index) => `Local event ${String(index + 1)}`)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Local event 1')).toBeTruthy();
    expect(screen.getByText('Local event 6')).toBeTruthy();
    expect(screen.queryByText('Local event 7')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
