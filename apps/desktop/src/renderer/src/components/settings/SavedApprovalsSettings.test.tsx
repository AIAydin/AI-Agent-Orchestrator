// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalView } from '../../../../shared/approvals/contracts.js';
import type { Project } from '../../../../shared/application/contracts.js';
import { SavedApprovalsSettings } from './SavedApprovalsSettings.js';

const PROJECT: Project = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Project',
  path: '/tmp/project',
  openedAt: '2026-07-15T12:00:00.000Z',
  missing: false,
  health: {
    isGitRepository: true,
    branch: 'main',
    dirty: false,
    remotes: [],
    packageManager: 'unknown',
    scripts: {},
    frameworks: [],
    hasSubmodules: false,
    sensitiveWarnings: [],
  },
};

const ACTIVE: ApprovalView = {
  status: 'active',
  record: {
    schemaVersion: 1,
    id: '20000000-0000-4000-8000-000000000001',
    scope: {
      projectId: PROJECT.id,
      action: 'command-execute',
      resourceFingerprint: 'a'.repeat(64),
    },
    decision: 'approved',
    decidedBy: '30000000-0000-4000-8000-000000000001',
    reason: 'Remembered exact project check.',
    createdAt: '2026-07-15T12:00:00.000Z',
    expiresAt: '2026-08-14T12:00:00.000Z',
    singleUse: false,
  },
};

const list = vi.fn();
const revoke = vi.fn();

beforeEach(() => {
  list.mockReset();
  revoke.mockReset();
  list.mockResolvedValue({ ok: true, value: [ACTIVE] });
  revoke.mockResolvedValue({ ok: true, value: { ...ACTIVE, status: 'revoked' } });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { approvals: { list, revoke } },
  });
});

afterEach(cleanup);

describe('SavedApprovalsSettings', () => {
  it('loads exact project grants and revokes them without requiring a settings save', async () => {
    render(<SavedApprovalsSettings activeProject={PROJECT} busy={false} onError={vi.fn()} />);

    const revokeButton = await screen.findByRole('button', { name: 'Revoke Command execute' });
    expect(list).toHaveBeenCalledWith({
      projectId: PROJECT.id,
      includeInactive: false,
      limit: 200,
    });
    fireEvent.click(revokeButton);

    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith({
        approvalId: ACTIVE.record.id,
        projectId: PROJECT.id,
      }),
    );
    expect(screen.getByText(/per-use approval/iu)).toBeTruthy();
  });

  it('can request inactive approvals through the UI', async () => {
    list.mockResolvedValue({ ok: true, value: [] });
    render(<SavedApprovalsSettings activeProject={null} busy={false} onError={vi.fn()} />);

    await screen.findByText('No active saved approvals on this device.');
    fireEvent.click(screen.getByRole('checkbox', { name: /Show inactive approvals/ }));

    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({ includeInactive: true, limit: 200 }),
    );
  });
});
