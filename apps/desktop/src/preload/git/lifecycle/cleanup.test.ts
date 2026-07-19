import { describe, expect, it, vi } from 'vitest';

import { GIT_LIFECYCLE_IPC_CHANNELS } from '../../../shared/git/lifecycle/contracts.js';
import { createGitLifecycleApi } from './cleanup.js';

const PROJECT_ID = '95000000-0000-4000-8000-000000000001';
const RUN_ID = '95000000-0000-4000-8000-000000000002';
const PLAN_ID = '95000000-0000-4000-8000-000000000003';

describe('createGitLifecycleApi', () => {
  it('validates an opaque review target and path-free external-open result', async () => {
    const result = {
      opened: true,
      targetKind: 'agent-worktree' as const,
      branch: 'forgeboard/task',
      application: 'selected' as const,
    };
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: result });
    const api = createGitLifecycleApi(invoke);

    await expect(
      api.openExternal({
        kind: 'agent-worktree',
        projectId: PROJECT_ID,
        runId: RUN_ID,
      }),
    ).resolves.toEqual({ ok: true, value: result });
    expect(invoke).toHaveBeenCalledWith(GIT_LIFECYCLE_IPC_CHANNELS.openExternal, {
      kind: 'agent-worktree',
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });

    invoke.mockResolvedValue({
      ok: true,
      value: { ...result, path: '/private/worktree' },
    });
    await expect(
      api.openExternal({
        kind: 'agent-worktree',
        projectId: PROJECT_ID,
        runId: RUN_ID,
      }),
    ).rejects.toBeTruthy();
  });

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

  it('bridges rename, archive, and restore with opaque targets and plan-id confirmations', async () => {
    const invoke = vi.fn();
    const api = createGitLifecycleApi(invoke);
    const target = { projectId: PROJECT_ID, runId: RUN_ID };
    const base = {
      planId: PLAN_ID,
      expiresAt: '2026-07-16T15:05:00.000Z',
      branch: 'forgeboard/task/test-agent-1234',
      clean: false,
      dirtyPathCount: 1,
    };

    invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        ...base,
        kind: 'rename-worktree-branch',
        newBranch: 'forgeboard/renamed',
      },
    });
    await api.prepareRename({ ...target, newBranch: 'forgeboard/renamed' });
    expect(invoke).toHaveBeenLastCalledWith(GIT_LIFECYCLE_IPC_CHANNELS.prepareRename, {
      ...target,
      newBranch: 'forgeboard/renamed',
    });

    for (const [prepare, channel, kind] of [
      [
        (input: Parameters<typeof api.prepareArchive>[0]) => api.prepareArchive(input),
        GIT_LIFECYCLE_IPC_CHANNELS.prepareArchive,
        'archive-worktree',
      ],
      [
        (input: Parameters<typeof api.prepareRestore>[0]) => api.prepareRestore(input),
        GIT_LIFECYCLE_IPC_CHANNELS.prepareRestore,
        'restore-worktree',
      ],
    ] as const) {
      invoke.mockResolvedValueOnce({
        ok: true,
        value: { ...base, kind, retainsWorktree: true, retainsBranch: true },
      });
      await prepare(target);
      expect(invoke).toHaveBeenLastCalledWith(channel, target);
    }

    for (const [confirm, channel, action] of [
      [
        (input: Parameters<typeof api.confirmRename>[0]) => api.confirmRename(input),
        GIT_LIFECYCLE_IPC_CHANNELS.confirmRename,
        'renamed',
      ],
      [
        (input: Parameters<typeof api.confirmArchive>[0]) => api.confirmArchive(input),
        GIT_LIFECYCLE_IPC_CHANNELS.confirmArchive,
        'archived',
      ],
      [
        (input: Parameters<typeof api.confirmRestore>[0]) => api.confirmRestore(input),
        GIT_LIFECYCLE_IPC_CHANNELS.confirmRestore,
        'restored',
      ],
    ] as const) {
      invoke.mockResolvedValueOnce({
        ok: true,
        value: { action, branch: 'forgeboard/renamed' },
      });
      await confirm({ planId: PLAN_ID });
      expect(invoke).toHaveBeenLastCalledWith(channel, { planId: PLAN_ID });
    }

    await expect(
      api.prepareRestore({
        ...target,
        worktreePath: '/private/worktree',
      } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.confirmRestore({
        planId: PLAN_ID,
        worktreeId: 'authority-leak',
      } as never),
    ).rejects.toBeTruthy();
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
