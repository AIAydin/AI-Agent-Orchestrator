import { describe, expect, it, vi } from 'vitest';

import { GIT_LIFECYCLE_IPC_CHANNELS } from '../../../shared/git/lifecycle/contracts.js';
import { createGitLifecycleApi } from './cleanup.js';

const PROJECT_ID = '95000000-0000-4000-8000-000000000001';
const RUN_ID = '95000000-0000-4000-8000-000000000002';
const PLAN_ID = '95000000-0000-4000-8000-000000000003';

describe('createGitLifecycleApi', () => {
  it('validates an opaque project/run target before invoking main', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: cleanupPlan() });
    const api = createGitLifecycleApi(invoke);

    await expect(api.prepareCleanup({ projectId: PROJECT_ID, runId: RUN_ID })).resolves.toEqual({
      ok: true,
      value: cleanupPlan(),
    });
    expect(invoke).toHaveBeenCalledWith(GIT_LIFECYCLE_IPC_CHANNELS.prepareCleanup, {
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });

    invoke.mockClear();
    await expect(
      api.prepareCleanup({
        projectId: PROJECT_ID,
        runId: RUN_ID,
        worktreePath: '/private/managed/agent',
      } as never),
    ).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a cleanup plan that leaks path authority or absolute dirty paths', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: { ...cleanupPlan(), managedRoot: '/private/forgeboard-worktrees' },
    });
    const api = createGitLifecycleApi(invoke);

    await expect(api.prepareCleanup({ projectId: PROJECT_ID, runId: RUN_ID })).rejects.toBeTruthy();

    invoke.mockResolvedValue({
      ok: true,
      value: {
        ...cleanupPlan(),
        clean: false,
        dirtyPaths: ['/private/secret.ts'],
        dirtyPathCount: 1,
      },
    });
    await expect(api.prepareCleanup({ projectId: PROJECT_ID, runId: RUN_ID })).rejects.toBeTruthy();
  });

  it('accepts only an exact, path-free reconciled completion outcome', async () => {
    const reconciled = {
      kind: 'cleanup-reconciled' as const,
      worktreeRemoved: true as const,
      branchDeleted: true as const,
      metadataRemoved: true as const,
    };
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: reconciled });
    const api = createGitLifecycleApi(invoke);

    await expect(api.prepareCleanup({ projectId: PROJECT_ID, runId: RUN_ID })).resolves.toEqual({
      ok: true,
      value: reconciled,
    });

    invoke.mockResolvedValue({
      ok: true,
      value: { ...reconciled, worktreePath: '/private/managed/agent' },
    });
    await expect(api.prepareCleanup({ projectId: PROJECT_ID, runId: RUN_ID })).rejects.toBeTruthy();
  });

  it('confirms with a plan id only and validates the path-free result', async () => {
    const result = {
      worktreeRemoved: true,
      branchDeleted: true,
      metadataRemoved: true,
    };
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: result });
    const api = createGitLifecycleApi(invoke);

    await expect(api.confirmCleanup({ planId: PLAN_ID })).resolves.toEqual({
      ok: true,
      value: result,
    });
    expect(invoke).toHaveBeenCalledWith(GIT_LIFECYCLE_IPC_CHANNELS.confirmCleanup, {
      planId: PLAN_ID,
    });

    invoke.mockClear();
    await expect(
      api.confirmCleanup({ planId: PLAN_ID, force: true } as never),
    ).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValue({
      ok: true,
      value: { ...result, removedPath: '/private/managed/agent' },
    });
    await expect(api.confirmCleanup({ planId: PLAN_ID })).rejects.toBeTruthy();
  });

  it('preserves validated failures and cancel-default null results', async () => {
    const failure = {
      ok: false as const,
      error: {
        code: 'STALE_APPROVAL' as const,
        message: 'The cleanup plan expired or its Git state changed.',
      },
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce({ ok: true, value: null });
    const api = createGitLifecycleApi(invoke);

    await expect(api.prepareCleanup({ projectId: PROJECT_ID, runId: RUN_ID })).resolves.toEqual(
      failure,
    );
    await expect(api.confirmCleanup({ planId: PLAN_ID })).resolves.toEqual({
      ok: true,
      value: null,
    });
  });
});

function cleanupPlan() {
  return {
    kind: 'cleanup-worktree' as const,
    recovery: false,
    planId: PLAN_ID,
    expiresAt: '2026-07-16T15:05:00.000Z',
    branch: 'forgeboard/task/test-agent-1234',
    baseRef: 'main',
    clean: true,
    mergedIntoBase: true,
    dirtyPaths: [],
    dirtyPathCount: 0,
    dirtyPathsTruncated: false,
    force: false as const,
    deleteBranch: true as const,
    allowDirty: false as const,
    allowUnmergedBranch: false as const,
  };
}
