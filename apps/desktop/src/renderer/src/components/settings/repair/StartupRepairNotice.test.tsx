// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StartupRepairNotice } from './StartupRepairNotice.js';

afterEach(cleanup);

describe('StartupRepairNotice', () => {
  it('discloses the repair and routes users to review it', () => {
    const onReview = vi.fn();
    const onDismiss = vi.fn();
    render(
      <StartupRepairNotice
        repair={{
          id: '50000000-0000-4000-8000-000000000001',
          repairedAt: '2026-07-16T12:00:00.000Z',
          sourceDatabaseVersion: 12,
          repairedFieldPaths: ['worktreeRoot', 'backupDirectory'],
          sourceSettingsSha256: 'a'.repeat(64),
          repairedSettingsSha256: 'b'.repeat(64),
        }}
        onReview={onReview}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText('Settings were repaired for this version')).toBeTruthy();
    expect(screen.getByText(/original settings remain available/iu)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onReview).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
