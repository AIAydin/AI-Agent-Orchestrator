import type {
  CleanupApproval,
  CleanupImpact,
  CleanupResult,
  RepositoryService,
  WorktreeCleanupRecoveryInspection,
  WorktreeOwnership,
  WorktreeService,
} from '@forgeboard/git-engine';
import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { GitWorktreeCleanupPlanView } from '../../../shared/git/lifecycle/contracts.js';

import { GitTargetResolutionError, type GitTargetResolver } from '../git-target-resolver.js';
import {
  ProcessActivityPresentError,
  ProcessAdmissionRestoreError,
} from '../../lifecycle/process-quiescence.js';
import {
  WorktreeCleanupService,
  type WorktreeCleanupAdmission,
} from './worktree-cleanup-service.js';

const PROJECT_ID = '81000000-0000-4000-8000-000000000001';
const RUN_ID = '81000000-0000-4000-8000-000000000002';
const WORKTREE_ID = '81000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-07-16T15:00:00.000Z');

describe('WorktreeCleanupService', () => {
  it('returns only bounded display data while retaining path authority in main', async () => {
    const fixture = harness();

    const plan = await preparePlan(fixture.service, 41);

    expect(plan).toMatchObject({
      kind: 'cleanup-worktree',
      branch: fixture.impact.ownership.branch,
      baseRef: fixture.impact.ownership.baseRef,
      clean: true,
      mergedIntoBase: true,
      force: false,
      deleteBranch: true,
      allowDirty: false,
      allowUnmergedBranch: false,
    });
    expect(plan).not.toHaveProperty('repositoryRoot');
    expect(plan).not.toHaveProperty('managedRoot');
    expect(plan).not.toHaveProperty('worktreePath');
    expect(plan).not.toHaveProperty('worktreeId');
    expect(JSON.stringify(plan)).not.toContain('/private/authority');
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree-prepare',
      'allowed',
      expect.objectContaining({ projectId: PROJECT_ID, runId: RUN_ID }),
    );
  });

  it('audits a safe prepare failure without disclosing authority paths', async () => {
    const fixture = harness();
    fixture.resolve.mockRejectedValueOnce(
      new GitTargetResolutionError('RUN_NOT_TERMINAL', 'Wait for the agent run to finish.'),
    );

    await expect(fixture.service.prepare(41, target())).rejects.toThrow(
      'Wait for the agent run to finish.',
    );

    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree-prepare',
      'failed',
      expect.objectContaining({
        projectId: PROJECT_ID,
        runId: RUN_ID,
        reason: 'RUN_NOT_TERMINAL',
      }),
    );
    expect(JSON.stringify(fixture.audit.mock.calls)).not.toContain('/private/authority');
  });

  it('does not let secondary failure-audit storage mask the primary refusal', async () => {
    const fixture = harness();
    fixture.resolve.mockRejectedValueOnce(
      new GitTargetResolutionError('RUN_NOT_TERMINAL', 'Wait for this exact run to finish.'),
    );
    fixture.audit.mockImplementation(() => {
      throw new Error('audit storage unavailable');
    });

    await expect(fixture.service.prepare(41, target())).rejects.toThrow(
      'Wait for this exact run to finish.',
    );
  });

  it('discloses mixed-case dirty paths in deterministic code-unit order', async () => {
    const fixture = harness({
      impact: impact({
        dirtyPaths: ['src/a.ts', 'src/B.ts'],
        status: {
          ...impact().status!,
          dirty: true,
          unstaged: true,
          entries: [
            { kind: 'ordinary', path: 'src/a.ts', index: '.', worktree: 'M' },
            { kind: 'ordinary', path: 'src/B.ts', index: '.', worktree: 'M' },
          ],
        },
      }),
    });

    const plan = await preparePlan(fixture.service, 40);

    expect(plan.dirtyPaths).toEqual(['src/B.ts', 'src/a.ts']);
  });

  it('uses a cancel-default native impact dialog and consumes a cancelled plan', async () => {
    const fixture = harness({ response: 0 });
    const plan = await preparePlan(fixture.service, 42);

    await expect(fixture.service.confirm(authority(42), plan.planId)).resolves.toBeNull();

    const options = fixture.showMessageBox.mock.calls[0]?.[1];
    if (options === undefined) throw new Error('Expected a native cleanup confirmation.');
    expect(options).toMatchObject({
      type: 'warning',
      defaultId: 0,
      cancelId: 0,
      buttons: ['Cancel', 'Clean up worktree and branch'],
    });
    expect(options.detail).toContain(fixture.impact.ownership.branch);
    expect(options.detail).toContain(fixture.impact.ownership.worktreePath);
    expect(options.detail).toContain(fixture.impact.branchOid?.slice(0, 12));
    expect(options.detail).toContain(fixture.impact.ownership.baseCommit.slice(0, 12));
    expect(options.detail).toContain(fixture.impact.expectedHead.slice(0, 12));
    expect(fixture.admission).not.toHaveBeenCalled();
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'denied',
      expect.objectContaining({ reason: 'native-confirmation-cancelled' }),
    );
    await expect(fixture.service.confirm(authority(42), plan.planId)).rejects.toThrow(
      'missing, expired, or belongs to another window',
    );
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'failed',
      expect.objectContaining({ reason: 'PLAN_UNAVAILABLE' }),
    );
  });

  it('fails closed without the injected process-admission boundary', async () => {
    const fixture = harness({ omitAdmission: true });
    const plan = await preparePlan(fixture.service, 43);

    await expect(fixture.service.confirm(authority(43), plan.planId)).rejects.toThrow(
      'every process admission boundary can be verified',
    );

    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'failed',
      expect.objectContaining({ reason: 'PROCESS_QUIESCENCE_UNAVAILABLE' }),
    );
  });

  it('preserves the actionable managed-process activity denial', async () => {
    const fixture = harness({
      beforeAdmission: () => {
        throw new ProcessActivityPresentError();
      },
    });
    const plan = await preparePlan(fixture.service, 43);

    await expect(fixture.service.confirm(authority(43), plan.planId)).rejects.toThrow(
      'Stop or cancel every Forgeboard-managed agent run',
    );

    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'failed',
      expect.objectContaining({ reason: 'PROCESS_ACTIVITY_PRESENT' }),
    );
  });

  it('restores an exact active-intact crash state before preparing a normal fresh plan', async () => {
    const activeImpact = impact();
    const fixture = harness({
      impact: activeImpact,
      recoveryInspections: [
        {
          kind: 'active-intact',
          impact: activeImpact,
          residue: fullResidue(),
        },
        {
          kind: 'active-intact',
          impact: activeImpact,
          residue: fullResidue(),
        },
      ],
    });
    fixture.resolve.mockRejectedValueOnce(inactiveLifecycleError());

    const plan = await preparePlan(fixture.service, 44);

    expect(plan.recovery).toBe(false);
    expect(fixture.recoverPending).toHaveBeenCalledTimes(2);
    expect(fixture.transitionRunWorktreeState).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedState: 'cleanup-pending',
        nextState: 'active',
        expectedWorktreeId: WORKTREE_ID,
      }),
      expect.any(Date),
    );
    expect(fixture.resolve).toHaveBeenCalledTimes(2);
  });

  it('does not reopen a pending run when the active-intact recovery proof races', async () => {
    const activeImpact = impact();
    const fixture = harness({
      impact: activeImpact,
      recoveryInspections: [
        { kind: 'active-intact', impact: activeImpact, residue: fullResidue() },
        { kind: 'unsafe', reason: 'active-not-intact' },
      ],
    });
    fixture.resolve.mockRejectedValueOnce(inactiveLifecycleError());

    await expect(fixture.service.prepare(44, target())).rejects.toThrow(
      'interrupted cleanup state changed',
    );

    expect(fixture.recoverPending).toHaveBeenCalledTimes(2);
    expect(fixture.transitionRunWorktreeState).not.toHaveBeenCalled();
  });

  it('reconciles only a twice-proven fully removed crash state without issuing consent', async () => {
    const fullyRemoved: WorktreeCleanupRecoveryInspection = {
      kind: 'fully-removed',
      residue: {
        worktreePathPresent: false,
        worktreeRegistered: false,
        branchExists: false,
      },
    };
    const fixture = harness({ recoveryInspections: [fullyRemoved, fullyRemoved] });
    fixture.resolve.mockRejectedValueOnce(inactiveLifecycleError());

    await expect(fixture.service.prepare(44, target())).resolves.toEqual({
      kind: 'cleanup-reconciled',
      worktreeRemoved: true,
      branchDeleted: true,
      metadataRemoved: true,
    });

    expect(fixture.recoverPending).toHaveBeenCalledTimes(2);
    expect(fixture.transitionRunWorktreeState).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedState: 'cleanup-pending',
        nextState: 'cleaned',
      }),
      expect.any(Date),
    );
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree-reconcile',
      'allowed',
      expect.objectContaining({ operationCompleted: true }),
    );
  });

  it('uses a fresh native confirmation to resume an exact cleanup-pending impact', async () => {
    const pendingImpact = impact({
      ownership: { ...ownership(), status: 'cleanup-pending' },
    });
    const pendingInspection: WorktreeCleanupRecoveryInspection = {
      kind: 'cleanup-pending',
      impact: pendingImpact,
      residue: fullResidue(),
    };
    const fixture = harness({
      impact: pendingImpact,
      recoveryInspections: [pendingInspection, pendingInspection, pendingInspection],
    });
    fixture.resolve.mockRejectedValueOnce(inactiveLifecycleError());

    const plan = await preparePlan(fixture.service, 44);
    expect(plan.recovery).toBe(true);
    await expect(fixture.service.confirm(authority(44), plan.planId)).resolves.toEqual({
      worktreeRemoved: true,
      branchDeleted: true,
      metadataRemoved: true,
    });

    expect(fixture.recoverPending).toHaveBeenCalledTimes(3);
    expect(fixture.transitionRunWorktreeState).toHaveBeenCalledTimes(1);
    expect(fixture.transitionRunWorktreeState).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedState: 'cleanup-pending',
        nextState: 'cleaned',
      }),
      expect.any(Date),
    );
    expect(fixture.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cleanup-pending' }),
      expect.objectContaining({
        deleteBranch: true,
        allowDirty: false,
        allowUnmergedBranch: false,
      }),
    );
    const options = fixture.showMessageBox.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      title: 'Continue interrupted worktree cleanup',
      message: 'Continue removing the remaining exact worktree cleanup target?',
      buttons: ['Cancel', 'Continue interrupted cleanup'],
      defaultId: 0,
      cancelId: 0,
    });
    expect(options?.detail).toContain('Fresh recovery confirmation');
  });

  it('keeps an ambiguous recovery pending and non-mutating', async () => {
    const fixture = harness({
      recoveryInspections: [{ kind: 'unsafe', reason: 'ownership-mismatch' }],
    });
    fixture.resolve.mockRejectedValueOnce(inactiveLifecycleError());

    await expect(fixture.service.prepare(44, target())).rejects.toThrow(
      'could not prove the interrupted cleanup state',
    );

    expect(fixture.transitionRunWorktreeState).not.toHaveBeenCalled();
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree-prepare',
      'failed',
      expect.objectContaining({ reason: 'RECOVERY_UNSAFE_OWNERSHIP_MISMATCH' }),
    );
  });

  it('truthfully reports completed reconciliation when final audit persistence fails', async () => {
    const fullyRemoved: WorktreeCleanupRecoveryInspection = {
      kind: 'fully-removed',
      residue: {
        worktreePathPresent: false,
        worktreeRegistered: false,
        branchExists: false,
      },
    };
    const fixture = harness({ recoveryInspections: [fullyRemoved, fullyRemoved] });
    fixture.resolve.mockRejectedValueOnce(inactiveLifecycleError());
    fixture.audit.mockImplementation((_category, action, outcome) => {
      if (action === 'cleanup-worktree-reconcile' && outcome === 'allowed') {
        throw new Error('audit disk unavailable');
      }
    });

    await expect(fixture.service.prepare(44, target())).rejects.toThrow(
      'Cleanup was already complete and run history was reconciled',
    );

    expect(fixture.transitionRunWorktreeState).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'cleanup-pending', nextState: 'cleaned' }),
      expect.any(Date),
    );
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree-prepare',
      'failed',
      expect.objectContaining({
        reason: 'RECOVERY_SUCCESS_AUDIT_FAILED',
        operationCompleted: true,
      }),
    );
  });

  it('re-resolves under admission and submits only the hard-coded safe cleanup policy', async () => {
    const fixture = harness();
    const plan = await preparePlan(fixture.service, 44);

    await expect(fixture.service.confirm(authority(44), plan.planId)).resolves.toEqual({
      worktreeRemoved: true,
      branchDeleted: true,
      metadataRemoved: true,
    });

    expect(fixture.resolve).toHaveBeenCalledTimes(3);
    expect(fixture.cleanupImpact).toHaveBeenCalledTimes(3);
    expect(fixture.admission).toHaveBeenCalledTimes(1);
    expect(fixture.transitionRunWorktreeState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedState: 'active',
        nextState: 'cleanup-pending',
        expectedWorktreeId: WORKTREE_ID,
      }),
      expect.any(Date),
    );
    expect(fixture.transitionRunWorktreeState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedState: 'cleanup-pending',
        nextState: 'cleaned',
        expectedWorktreeId: WORKTREE_ID,
      }),
      expect.any(Date),
    );
    const approval = fixture.cleanup.mock.calls[0]?.[1];
    if (approval === undefined) throw new Error('Expected an exact cleanup approval.');
    expect(approval).toMatchObject({
      action: 'cleanup-worktree',
      approved: true,
      repositoryRoot: fixture.impact.ownership.repositoryRoot,
      worktreeId: WORKTREE_ID,
      worktreePath: fixture.impact.ownership.worktreePath,
      branch: fixture.impact.ownership.branch,
      deleteBranch: true,
      allowDirty: false,
      allowUnmergedBranch: false,
    });
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'allowed',
      expect.objectContaining({
        worktreeRemoved: true,
        branchDeleted: true,
        metadataRemoved: true,
      }),
    );
  });

  it('preserves a completed-cleanup admission restoration failure and audits its outcome', async () => {
    const fixture = harness({
      afterAdmissionOperation: () => {
        throw new ProcessAdmissionRestoreError([new Error('resume failed')], true);
      },
    });
    const plan = await preparePlan(fixture.service, 44);

    await expect(fixture.service.confirm(authority(44), plan.planId)).rejects.toThrow(
      'cleanup completed, but Forgeboard could not reopen',
    );

    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'failed',
      expect.objectContaining({
        reason: 'PROCESS_ADMISSION_RESTORE_FAILED',
        operationCompleted: true,
      }),
    );
  });

  it('truthfully reports completed cleanup when its final success audit cannot persist', async () => {
    const fixture = harness();
    const plan = await preparePlan(fixture.service, 44);
    fixture.audit.mockImplementation((_category, action, outcome) => {
      if (action === 'cleanup-worktree' && outcome === 'allowed') {
        throw new Error('audit disk unavailable');
      }
    });

    await expect(fixture.service.confirm(authority(44), plan.planId)).rejects.toThrow(
      'Cleanup completed and run history was finalized',
    );

    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.transitionRunWorktreeState).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedState: 'cleanup-pending', nextState: 'cleaned' }),
      expect.any(Date),
    );
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'failed',
      expect.objectContaining({
        reason: 'CLEANUP_SUCCESS_AUDIT_FAILED',
        operationCompleted: true,
      }),
    );
  });

  it('rolls pending back to active only when cleanup failure leaves the exact impact intact', async () => {
    const fixture = harness();
    fixture.cleanup.mockRejectedValueOnce(new Error('engine refused before mutation'));
    const plan = await preparePlan(fixture.service, 44);

    await expect(fixture.service.confirm(authority(44), plan.planId)).rejects.toThrow(
      'could not safely clean up',
    );

    expect(fixture.cleanupImpact).toHaveBeenCalledTimes(4);
    expect(fixture.transitionRunWorktreeState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedState: 'active', nextState: 'cleanup-pending' }),
      expect.any(Date),
    );
    expect(fixture.transitionRunWorktreeState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedState: 'cleanup-pending', nextState: 'active' }),
      expect.any(Date),
    );
  });

  it('leaves lifecycle pending and reports an incomplete engine result as potentially mutated', async () => {
    const fixture = harness();
    fixture.cleanup.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: false,
      metadataRemoved: false,
    });
    const plan = await preparePlan(fixture.service, 44);

    await expect(fixture.service.confirm(authority(44), plan.planId)).rejects.toThrow(
      'incomplete result',
    );

    expect(fixture.transitionRunWorktreeState).toHaveBeenCalledTimes(1);
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'failed',
      expect.objectContaining({
        reason: 'CLEANUP_RESULT_INCOMPLETE',
        mutationMayHaveCompleted: true,
      }),
    );
  });

  it('reports completed mutation when the final cleaned transition cannot persist', async () => {
    const fixture = harness();
    fixture.transitionRunWorktreeState.mockImplementationOnce(() => undefined);
    fixture.transitionRunWorktreeState.mockImplementationOnce(() => {
      throw new Error('persistence unavailable');
    });
    const plan = await preparePlan(fixture.service, 44);

    await expect(fixture.service.confirm(authority(44), plan.planId)).rejects.toThrow(
      'Cleanup completed, but Forgeboard could not finalize',
    );

    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'failed',
      expect.objectContaining({
        reason: 'CLEANUP_FINAL_PERSISTENCE_FAILED',
        operationCompleted: true,
      }),
    );
  });

  it('rejects a stale exact impact before showing the destructive dialog', async () => {
    const fixture = harness();
    fixture.cleanupImpact.mockResolvedValueOnce(fixture.impact).mockResolvedValueOnce(
      impact({
        branchOid: 'c'.repeat(40),
        status: { ...fixture.impact.status!, headOid: 'c'.repeat(40) },
      }),
    );
    const plan = await preparePlan(fixture.service, 45);

    await expect(fixture.service.confirm(authority(45), plan.planId)).rejects.toThrow(
      'changed after review',
    );

    expect(fixture.showMessageBox).not.toHaveBeenCalled();
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'failed',
      expect.objectContaining({ reason: 'STALE_PLAN' }),
    );
  });

  it.each([
    {
      label: 'dirty',
      override: {
        dirtyPaths: ['changed.txt'],
        status: {
          ...impact().status!,
          dirty: true,
          unstaged: true,
          entries: [
            {
              kind: 'ordinary' as const,
              path: 'changed.txt',
              index: '.' as const,
              worktree: 'M' as const,
            },
          ],
        },
      },
      message: 'Commit or discard',
    },
    {
      label: 'unmerged',
      override: { mergedIntoBase: false },
      message: 'Deliver or merge',
    },
  ])(
    'refuses an unchanged $label impact without invoking cleanup',
    async ({ override, message }) => {
      const fixture = harness({ impact: impact(override) });
      const plan = await preparePlan(fixture.service, 46);

      await expect(fixture.service.confirm(authority(46), plan.planId)).rejects.toThrow(message);
      expect(fixture.showMessageBox).not.toHaveBeenCalled();
      expect(fixture.cleanup).not.toHaveBeenCalled();
    },
  );

  it('binds plans to one owner, one use, and a finite TTL', async () => {
    let now = NOW;
    const fixture = harness({ now: () => now, planTtlMs: 100 });
    const ownerBound = await preparePlan(fixture.service, 47);
    await expect(fixture.service.confirm(authority(48), ownerBound.planId)).rejects.toThrow(
      'belongs to another window',
    );
    await expect(fixture.service.confirm(authority(47), ownerBound.planId)).resolves.toEqual({
      worktreeRemoved: true,
      branchDeleted: true,
      metadataRemoved: true,
    });
    fixture.showMessageBox.mockClear();

    const expiring = await preparePlan(fixture.service, 47);
    now = new Date(NOW.getTime() + 101);
    await expect(fixture.service.confirm(authority(47), expiring.planId)).rejects.toThrow(
      'missing, expired',
    );
    expect(fixture.showMessageBox).not.toHaveBeenCalled();
  });

  it('denies an approval that expires while the native dialog is open', async () => {
    let now = NOW;
    const fixture = harness({ now: () => now, planTtlMs: 100 });
    fixture.showMessageBox.mockImplementationOnce(() => {
      now = new Date(NOW.getTime() + 101);
      return Promise.resolve({ response: 1, checkboxChecked: false });
    });
    const plan = await preparePlan(fixture.service, 48);

    await expect(fixture.service.confirm(authority(48), plan.planId)).resolves.toBeNull();

    expect(fixture.admission).not.toHaveBeenCalled();
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'denied',
      expect.objectContaining({ reason: 'approval-expired-after-confirmation' }),
    );
  });

  it('rechecks expiry inside the paused admission boundary', async () => {
    let now = NOW;
    const fixture = harness({
      now: () => now,
      planTtlMs: 100,
      beforeAdmission: () => {
        now = new Date(NOW.getTime() + 101);
      },
    });
    const plan = await preparePlan(fixture.service, 48);

    await expect(fixture.service.confirm(authority(48), plan.planId)).rejects.toThrow(
      'approval expired',
    );

    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'failed',
      expect.objectContaining({ reason: 'PLAN_EXPIRED' }),
    );
  });

  it('rechecks expiry after deferred exact-target revalidation', async () => {
    let now = NOW;
    const fixture = harness({ now: () => now, planTtlMs: 100 });
    let impactReads = 0;
    fixture.cleanupImpact.mockImplementation(() => {
      impactReads += 1;
      if (impactReads === 3) now = new Date(NOW.getTime() + 101);
      return Promise.resolve(fixture.impact);
    });
    const plan = await preparePlan(fixture.service, 48);

    await expect(fixture.service.confirm(authority(48), plan.planId)).rejects.toThrow(
      'approval expired',
    );

    expect(fixture.cleanupImpact).toHaveBeenCalledTimes(3);
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(
      'git',
      'cleanup-worktree',
      'failed',
      expect.objectContaining({ reason: 'PLAN_EXPIRED' }),
    );
  });

  it('serializes lifecycle operations', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstImpact = new Promise<CleanupImpact>((resolve) => {
      releaseFirst = () => resolve(impact());
    });
    const fixture = harness();
    fixture.cleanupImpact.mockImplementationOnce(async () => await firstImpact);

    const first = preparePlan(fixture.service, 49);
    const second = preparePlan(fixture.service, 49);
    await vi.waitFor(() => expect(fixture.resolve).toHaveBeenCalledTimes(1));
    expect(fixture.cleanupImpact).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(fixture.resolve).toHaveBeenCalledTimes(2);
  });
});

function target() {
  return { projectId: PROJECT_ID, runId: RUN_ID };
}

function authority(ownerId: number) {
  return {
    ownerId,
    parent: { isDestroyed: () => false } as BrowserWindow,
    assertCurrent: vi.fn(),
  };
}

function ownership(): WorktreeOwnership {
  return {
    schemaVersion: 1,
    id: WORKTREE_ID,
    repositoryRoot: '/private/authority/repository',
    managedRoot: '/private/authority/managed',
    worktreePath: '/private/authority/managed/worktree',
    branch: 'forgeboard/task/test-agent-0000000001',
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    agentId: 'test-agent',
    taskId: 'agent-node',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'active',
    cleanupPolicy: 'manual',
  };
}

function impact(overrides: Partial<CleanupImpact> = {}): CleanupImpact {
  const owned = ownership();
  const branchOid = overrides.branchOid ?? 'b'.repeat(40);
  return {
    ownership: owned,
    status: {
      branch: owned.branch,
      detached: false,
      headOid: branchOid,
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [],
      dirty: false,
      staged: false,
      unstaged: false,
      untracked: false,
      conflicted: false,
    },
    branchExists: true,
    branchOid,
    mergedIntoBase: true,
    missing: false,
    expectedHead: 'd'.repeat(40),
    dirtyPaths: [],
    ...overrides,
  };
}

function harness(
  options: {
    readonly response?: number;
    readonly impact?: CleanupImpact;
    readonly omitAdmission?: boolean;
    readonly now?: () => Date;
    readonly planTtlMs?: number;
    readonly beforeAdmission?: () => void;
    readonly afterAdmissionOperation?: () => void;
    readonly recoveryInspections?: readonly WorktreeCleanupRecoveryInspection[];
  } = {},
) {
  const authoritativeImpact = options.impact ?? impact();
  const resolve = vi.fn(() =>
    Promise.resolve({ ownership: authoritativeImpact.ownership } as Awaited<
      ReturnType<GitTargetResolver['resolve']>
    >),
  );
  const cleanupImpact = vi.fn(() => Promise.resolve(authoritativeImpact));
  const cleanup = vi.fn<
    (owned: WorktreeOwnership, approval: CleanupApproval) => Promise<CleanupResult>
  >(() => Promise.resolve({ worktreeRemoved: true, branchDeleted: true, metadataRemoved: true }));
  const showMessageBox = vi.fn<
    (
      window: BrowserWindow,
      options: MessageBoxOptions,
    ) => Promise<{ response: number; checkboxChecked: boolean }>
  >(() => Promise.resolve({ response: options.response ?? 1, checkboxChecked: false }));
  const audit = vi.fn();
  const transitionRunWorktreeState = vi.fn();
  const recoveryInspections = [...(options.recoveryInspections ?? [])];
  const recoverPending = vi.fn(() => {
    const inspection = recoveryInspections.shift();
    if (inspection === undefined) {
      return Promise.reject(new Error('No recovery inspection was configured.'));
    }
    return Promise.resolve({
      run: {} as never,
      binding: {
        worktreeId: authoritativeImpact.ownership.id,
        repositoryRoot: authoritativeImpact.ownership.repositoryRoot,
        managedRoot: authoritativeImpact.ownership.managedRoot,
        worktreePath: authoritativeImpact.ownership.worktreePath,
        branch: authoritativeImpact.ownership.branch,
        baseRef: authoritativeImpact.ownership.baseRef,
        baseCommit: authoritativeImpact.ownership.baseCommit,
        agentId: authoritativeImpact.ownership.agentId,
        taskId: authoritativeImpact.ownership.taskId,
      },
      inspection,
    });
  });
  const admission = vi.fn();
  const withCleanupAdmission: WorktreeCleanupAdmission = async <Output>(
    operation: () => Promise<Output>,
  ): Promise<Output> => {
    admission();
    options.beforeAdmission?.();
    const value = await operation();
    options.afterAdmissionOperation?.();
    return value;
  };
  const service = new WorktreeCleanupService(
    { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
    { appendAudit: audit, transitionRunWorktreeState } as unknown as ConstructorParameters<
      typeof WorktreeCleanupService
    >[1],
    { resolve } as unknown as GitTargetResolver,
    {} as RepositoryService,
    {
      worktrees: { cleanupImpact, cleanup } as unknown as WorktreeService,
      recovery: { resolvePending: recoverPending },
      ...(options.omitAdmission ? {} : { withCleanupAdmission }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.planTtlMs === undefined ? {} : { planTtlMs: options.planTtlMs }),
    },
  );
  return {
    service,
    impact: authoritativeImpact,
    resolve,
    cleanupImpact,
    cleanup,
    showMessageBox,
    audit,
    transitionRunWorktreeState,
    recoverPending,
    admission,
  };
}

async function preparePlan(
  service: WorktreeCleanupService,
  ownerId: number,
): Promise<GitWorktreeCleanupPlanView> {
  const outcome = await service.prepare(ownerId, target());
  if (outcome.kind !== 'cleanup-worktree') {
    throw new Error('Expected cleanup preparation to return a confirmation plan.');
  }
  return outcome;
}

function inactiveLifecycleError(): GitTargetResolutionError {
  return new GitTargetResolutionError(
    'WORKTREE_LIFECYCLE_INACTIVE',
    'This agent worktree cleanup is incomplete and cannot be used safely.',
  );
}

function fullResidue() {
  return {
    worktreePathPresent: true,
    worktreeRegistered: true,
    branchExists: true,
  } as const;
}
