// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsRepairEvidence } from '../../../../../../shared/settings/repair/contracts.js';
import { SettingsRepairHistory } from './SettingsRepairHistory.js';

const evidence: SettingsRepairEvidence = {
  id: '40000000-0000-4000-8000-000000000001',
  repairedAt: '2026-07-16T12:00:00.000Z',
  sourceDatabaseVersion: 12,
  repairedFieldPaths: ['worktreeRoot'],
  sourceSettingsSha256: 'a'.repeat(64),
  repairedSettingsSha256: 'b'.repeat(64),
  sourceSettingsJson: JSON.stringify({ worktreeRoot: 'relative/worktrees' }),
  repairedSettingsJson: JSON.stringify({ worktreeRoot: '/device/worktrees' }),
};

const listRepairs = vi.fn();
const getRepair = vi.fn();
const exportRepair = vi.fn();

beforeEach(() => {
  listRepairs.mockReset();
  getRepair.mockReset();
  exportRepair.mockReset();
  listRepairs.mockResolvedValue({
    ok: true,
    value: [
      {
        id: evidence.id,
        repairedAt: evidence.repairedAt,
        sourceDatabaseVersion: evidence.sourceDatabaseVersion,
        repairedFieldPaths: evidence.repairedFieldPaths,
        sourceSettingsSha256: evidence.sourceSettingsSha256,
        repairedSettingsSha256: evidence.repairedSettingsSha256,
      },
    ],
  });
  getRepair.mockResolvedValue({ ok: true, value: evidence });
  exportRepair.mockResolvedValue({ ok: true, value: '/tmp/recovery-evidence.json' });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { settings: { listRepairs, getRepair, exportRepair } },
  });
});

afterEach(cleanup);

describe('SettingsRepairHistory', () => {
  it('reviews preserved originals and exports them only through the explicit action', async () => {
    const onNotice = vi.fn();
    render(<SettingsRepairHistory onError={vi.fn()} onNotice={onNotice} />);

    expect(await screen.findByText('Settings recovery evidence')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText(/relative\/worktrees/u)).toBeTruthy();
    expect(getRepair).toHaveBeenCalledWith(evidence.id);

    fireEvent.click(screen.getByRole('button', { name: 'Export original' }));
    expect(await screen.findByText(/settings after safe repair/iu)).toBeTruthy();
    expect(exportRepair).toHaveBeenCalledWith(evidence.id);
    expect(onNotice).toHaveBeenCalledWith(
      'Recovery evidence exported to /tmp/recovery-evidence.json',
    );
  });

  it('renders nothing when no repair has occurred', async () => {
    listRepairs.mockResolvedValueOnce({ ok: true, value: [] });
    const { container } = render(<SettingsRepairHistory onError={vi.fn()} onNotice={vi.fn()} />);

    await vi.waitFor(() => expect(listRepairs).toHaveBeenCalledOnce());
    expect(container.innerHTML).toBe('');
  });
});
