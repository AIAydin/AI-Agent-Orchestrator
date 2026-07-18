// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SANITIZED_INTEGRITY_MESSAGES,
  type IntegrityCheckResult,
} from '../../../../shared/integrity/contracts.js';
import { TrustCenter } from './TrustCenter.js';

afterEach(cleanup);

describe('TrustCenter', () => {
  it('automatically runs quick verification and can run a full verification', async () => {
    const quick: IntegrityCheckResult = {
      schemaVersion: 1,
      mode: 'quick',
      checkedAt: '2026-07-15T18:00:00.000Z',
      ok: true,
      messages: [],
    };
    const full: IntegrityCheckResult = {
      schemaVersion: 1,
      mode: 'full',
      checkedAt: '2026-07-15T18:01:00.000Z',
      ok: false,
      messages: [SANITIZED_INTEGRITY_MESSAGES.audit],
    };
    const runIntegrityCheck = vi.fn().mockResolvedValueOnce(quick).mockResolvedValueOnce(full);

    render(<TrustCenter runIntegrityCheck={runIntegrityCheck} />);

    await screen.findByText('Local data verified');
    expect(runIntegrityCheck).toHaveBeenNthCalledWith(1, { mode: 'quick' });
    expect(screen.getByText('Pass')).toBeTruthy();
    expect(screen.getByText(/Quick check finished/)).toBeTruthy();
    expect(screen.getByText(/only ever added/)).toBeTruthy();
    expect(screen.getByText(/When old entries expire/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Run full check' }));

    await screen.findByText('Local data needs attention');
    expect(runIntegrityCheck).toHaveBeenNthCalledWith(2, { mode: 'full' });
    expect(screen.getByText('Fail')).toBeTruthy();
    expect(screen.getByText(SANITIZED_INTEGRITY_MESSAGES.audit)).toBeTruthy();
    expect(screen.getByText(/Full check finished/)).toBeTruthy();
  });

  it('does not surface transport exception details', async () => {
    const runIntegrityCheck = vi.fn(() =>
      Promise.reject(new Error('Failed to open /Users/private/forgeboard.sqlite3')),
    );

    render(<TrustCenter runIntegrityCheck={runIntegrityCheck} />);

    await waitFor(() => expect(screen.getByText('Check unavailable')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('The check could not finish.');
    expect(document.body.textContent).not.toContain('/Users/private');
  });
});
