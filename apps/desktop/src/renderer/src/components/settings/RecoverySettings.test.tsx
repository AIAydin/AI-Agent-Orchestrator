// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../shared/contracts.js';
import type {
  RecoveryImportPlan,
  RecoverySnapshotRestorePlan,
  RecoverySnapshotSummary,
} from '../../../../shared/recovery-contracts.js';
import { RecoverySettings } from './RecoverySettings.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const SNAPSHOT_ID = '10000000-0000-4000-8000-000000000002';
const PLAN_ID = '10000000-0000-4000-8000-000000000003';
const NOW = '2026-07-15T12:00:00.000Z';

const recoveryApi = {
  listSnapshots: vi.fn(),
  createSnapshot: vi.fn(),
  prepareSnapshotRestore: vi.fn(),
  confirmSnapshotRestore: vi.fn(),
  chooseImport: vi.fn(),
  confirmImport: vi.fn(),
};

beforeEach(() => {
  for (const operation of Object.values(recoveryApi)) operation.mockReset();
  recoveryApi.listSnapshots.mockResolvedValue({ ok: true, value: [snapshot()] });
  recoveryApi.createSnapshot.mockResolvedValue({ ok: true, value: snapshot() });
  recoveryApi.prepareSnapshotRestore.mockResolvedValue({ ok: true, value: restorePlan() });
  recoveryApi.confirmSnapshotRestore.mockResolvedValue({
    ok: true,
    value: {
      id: '10000000-0000-4000-8000-000000000004',
      projectId: PROJECT_ID,
      name: 'Workshop',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: NOW,
    },
  });
  recoveryApi.chooseImport.mockResolvedValue({ ok: true, value: importPlan() });
  recoveryApi.confirmImport.mockResolvedValue({
    ok: true,
    value: {
      projects: 2,
      canvases: 2,
      runs: 3,
      checkExecutions: 4,
      snapshots: 5,
      auditEvents: 6,
    },
  });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { recovery: recoveryApi },
  });
});

afterEach(cleanup);

describe('RecoverySettings', () => {
  it('does not surface an intentional recovery pause while another Settings operation is busy', async () => {
    let rejectHistory!: (reason: Error) => void;
    recoveryApi.listSnapshots.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectHistory = reject;
        }),
    );
    const onError = vi.fn();
    const view = renderRecovery({ onError });
    await vi.waitFor(() => {
      expect(rejectHistory).toBeTypeOf('function');
    });

    view.rerender(<RecoverySettings {...recoveryProps({ busy: true, onError })} />);
    rejectHistory(new Error('Recovery operations are paused for a local-data change.'));
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
  });

  it('selects a valid recovery project when projects arrive or the prior selection disappears', async () => {
    const view = renderRecovery({ projects: [] });
    expect(screen.getByText('Open a project once to create recovery history.')).toBeTruthy();

    view.rerender(<RecoverySettings {...recoveryProps({ projects: [project()] })} />);
    await waitFor(() =>
      expect(recoveryApi.listSnapshots).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        limit: 100,
      }),
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Recovery project').value).toBe(PROJECT_ID);
    expect(screen.getByRole('button', { name: 'Create snapshot' }).hasAttribute('disabled')).toBe(
      false,
    );

    const replacementId = '10000000-0000-4000-8000-000000000099';
    view.rerender(
      <RecoverySettings {...recoveryProps({ projects: [project({ id: replacementId })] })} />,
    );
    await waitFor(() =>
      expect(recoveryApi.listSnapshots).toHaveBeenCalledWith({
        projectId: replacementId,
        limit: 100,
      }),
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Recovery project').value).toBe(replacementId);
  });

  it('browses exact snapshots and restores only after renderer and native approval', async () => {
    const onRecoveryApplied = vi.fn(() => Promise.resolve());
    renderRecovery({ onRecoveryApplied });

    await screen.findByText(/1 nodes · 0 connections · autosave/u);
    fireEvent.click(screen.getByRole('button', { name: 'Review restore' }));
    await screen.findByRole('region', { name: 'Snapshot restore disclosure' });
    expect(screen.getByText(/Current canvas/u)).toBeTruthy();
    expect(recoveryApi.confirmSnapshotRestore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue to native approval' }));
    await waitFor(() =>
      expect(recoveryApi.confirmSnapshotRestore).toHaveBeenCalledWith({ planId: PLAN_ID }),
    );
    expect(onRecoveryApplied).toHaveBeenCalledTimes(1);
  });

  it('flushes an open canvas before snapshot creation and blocks destructive recovery', async () => {
    const onFlushActiveCanvas = vi.fn(() => Promise.resolve(true));
    renderRecovery({ activeProject: project(), onFlushActiveCanvas });

    await screen.findByText(/1 nodes · 0 connections · autosave/u);
    expect(screen.getByRole('button', { name: 'Review restore' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(
      screen.getByRole('button', { name: 'Choose data export' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Create snapshot' }));

    await waitFor(() => expect(onFlushActiveCanvas).toHaveBeenCalledTimes(1));
    expect(recoveryApi.createSnapshot).toHaveBeenCalledWith({ projectId: PROJECT_ID });
  });

  it('reviews bounded import counts and exact digest before native approval', async () => {
    const setNotice = vi.fn();
    renderRecovery({ setNotice });

    fireEvent.change(screen.getByLabelText('Import behavior'), {
      target: { value: 'replace' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Choose data export' }));
    await screen.findByRole('region', { name: 'Local data import disclosure' });
    expect(screen.getByText('2 projects')).toBeTruthy();
    expect(screen.getByText(/SHA-256 bbbbbbbbbbbbbbbb/u)).toBeTruthy();
    expect(recoveryApi.confirmImport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue to native approval' }));
    await waitFor(() =>
      expect(recoveryApi.confirmImport).toHaveBeenCalledWith({ planId: PLAN_ID }),
    );
    expect(setNotice).toHaveBeenCalledWith(
      expect.stringMatching(/Imported 2 projects, 2 canvases, and 5 snapshots/u),
    );
  });

  it('clears consumed one-shot plans after failed confirmations', async () => {
    recoveryApi.confirmSnapshotRestore.mockResolvedValueOnce({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'Snapshot changed.' },
    });
    recoveryApi.confirmImport.mockResolvedValueOnce({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'Import conflict.' },
    });
    const perform = vi.fn(async (operation: () => Promise<void>) => {
      await operation().catch(() => undefined);
    });
    renderRecovery({ perform });

    await screen.findByText(/1 nodes · 0 connections · autosave/u);
    fireEvent.click(screen.getByRole('button', { name: 'Review restore' }));
    await screen.findByRole('region', { name: 'Snapshot restore disclosure' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to native approval' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Snapshot restore disclosure' })).toBeNull(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose data export' }));
    await screen.findByRole('region', { name: 'Local data import disclosure' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to native approval' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Local data import disclosure' })).toBeNull(),
    );
  });
});

function renderRecovery(overrides: Partial<ComponentProps<typeof RecoverySettings>> = {}) {
  return render(<RecoverySettings {...recoveryProps(overrides)} />);
}

function recoveryProps(
  overrides: Partial<ComponentProps<typeof RecoverySettings>> = {},
): ComponentProps<typeof RecoverySettings> {
  return {
    projects: [project()],
    activeProject: null,
    busy: false,
    perform: async (operation) => await operation(),
    onError: vi.fn(),
    onFlushActiveCanvas: vi.fn(() => Promise.resolve(true)),
    onRecoveryApplied: vi.fn(() => Promise.resolve()),
    setNotice: vi.fn(),
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    name: 'Recovery project',
    path: '/tmp/recovery-project',
    openedAt: NOW,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: ['React'],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
    ...overrides,
  };
}

function snapshot(): RecoverySnapshotSummary {
  return {
    id: SNAPSHOT_ID,
    projectId: PROJECT_ID,
    canvasId: '10000000-0000-4000-8000-000000000004',
    canvasName: 'Workshop',
    nodeCount: 1,
    edgeCount: 0,
    contentHash: 'a'.repeat(64),
    canvasUpdatedAt: NOW,
    createdAt: NOW,
    reason: 'autosave',
  };
}

function restorePlan(): RecoverySnapshotRestorePlan {
  return {
    kind: 'snapshot-restore',
    planId: PLAN_ID,
    expiresAt: '2026-07-15T12:05:00.000Z',
    projectId: PROJECT_ID,
    snapshot: snapshot(),
    currentCanvasContentHash: 'c'.repeat(64),
  };
}

function importPlan(): RecoveryImportPlan {
  return {
    kind: 'local-data-import',
    planId: PLAN_ID,
    expiresAt: '2026-07-15T12:05:00.000Z',
    mode: 'replace',
    fileName: 'forgeboard-local-data.json',
    sha256: 'b'.repeat(64),
    sizeBytes: 4_096,
    exportVersion: 3,
    exportedAt: NOW,
    includesSettings: true,
    counts: {
      projects: 2,
      canvases: 2,
      runs: 3,
      checkExecutions: 4,
      snapshots: 5,
      auditEvents: 6,
    },
  };
}
