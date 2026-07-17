import { describe, expect, it, vi } from 'vitest';

import {
  GIT_REMOTE_IPC_CHANNELS,
  type GitRemoteDeliveryTargetInput,
} from '../../../shared/git/remote/index.js';
import { createGitRemoteDeliveryApi } from './bridge.js';

const TARGET: GitRemoteDeliveryTargetInput = {
  kind: 'agent-worktree',
  projectId: '10000000-0000-4000-8000-000000000001',
  runId: '20000000-0000-4000-8000-000000000001',
};
const PLAN_ID = '80000000-0000-4000-8000-000000000001';
const CONFIRMATION = { planId: PLAN_ID };
const FAILURE = {
  ok: false as const,
  error: { code: 'REMOTE_UNAVAILABLE', message: 'Remote delivery is unavailable.' },
};

describe('createGitRemoteDeliveryApi', () => {
  it('validates and forwards every distinct remote-delivery operation', async () => {
    const invoke = vi.fn().mockResolvedValue(FAILURE);
    const api = createGitRemoteDeliveryApi(invoke);
    const pushInput = { target: TARGET, remote: 'origin', destinationBranch: 'feature/delivery' };
    const githubInput = {
      target: TARGET,
      remote: 'origin',
      destinationBranch: 'feature/delivery',
      baseBranch: 'main',
    };
    const pullRequestInput = {
      ...githubInput,
      title: 'Safe remote delivery',
      body: 'Confirm exact impact before publication.',
      draft: false,
    };

    await expect(api.inspect({ target: TARGET })).resolves.toEqual(FAILURE);
    await expect(api.cancelPlan(CONFIRMATION)).resolves.toEqual(FAILURE);
    await expect(api.preparePush(pushInput)).resolves.toEqual(FAILURE);
    await expect(api.confirmPush(CONFIRMATION)).resolves.toEqual(FAILURE);
    await expect(api.prepareGitHubStatus(githubInput)).resolves.toEqual(FAILURE);
    await expect(api.confirmGitHubStatus(CONFIRMATION)).resolves.toEqual(FAILURE);
    await expect(api.preparePullRequest(pullRequestInput)).resolves.toEqual(FAILURE);
    await expect(api.confirmPullRequest(CONFIRMATION)).resolves.toEqual(FAILURE);
    await expect(api.prepareCi(githubInput)).resolves.toEqual(FAILURE);
    await expect(api.confirmCi(CONFIRMATION)).resolves.toEqual(FAILURE);

    expect(invoke.mock.calls).toEqual([
      [GIT_REMOTE_IPC_CHANNELS.inspect, { target: TARGET }],
      [GIT_REMOTE_IPC_CHANNELS.cancelPlan, CONFIRMATION],
      [GIT_REMOTE_IPC_CHANNELS.preparePush, pushInput],
      [GIT_REMOTE_IPC_CHANNELS.confirmPush, CONFIRMATION],
      [GIT_REMOTE_IPC_CHANNELS.prepareGitHubStatus, githubInput],
      [GIT_REMOTE_IPC_CHANNELS.confirmGitHubStatus, CONFIRMATION],
      [GIT_REMOTE_IPC_CHANNELS.preparePullRequest, pullRequestInput],
      [GIT_REMOTE_IPC_CHANNELS.confirmPullRequest, CONFIRMATION],
      [GIT_REMOTE_IPC_CHANNELS.prepareCi, githubInput],
      [GIT_REMOTE_IPC_CHANNELS.confirmCi, CONFIRMATION],
    ]);
  });

  it('rejects renderer paths, OIDs, force flags, and approval authority before IPC', async () => {
    const invoke = vi.fn();
    const api = createGitRemoteDeliveryApi(invoke);

    await expect(
      api.inspect({ target: { ...TARGET, worktreePath: '/private/worktree' } } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.preparePush({
        target: TARGET,
        remote: 'origin',
        destinationBranch: 'feature/delivery',
        expectedSourceOid: 'a'.repeat(40),
      } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.preparePush({
        target: TARGET,
        remote: 'origin',
        destinationBranch: 'feature/delivery',
        force: true,
      } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.preparePullRequest({
        target: TARGET,
        remote: 'origin',
        destinationBranch: 'feature/delivery',
        baseBranch: 'main',
        title: 'Delivery',
        body: '',
        draft: false,
        readinessApprovalId: '70000000-0000-4000-8000-000000000001',
      } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.confirmPush({ ...CONFIRMATION, repositoryPath: '/private/repository' } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.cancelPlan({ ...CONFIRMATION, ownerId: 'renderer-selected-owner' } as never),
    ).rejects.toBeTruthy();

    expect(invoke).not.toHaveBeenCalled();
  });

  it('strictly forwards a constant plan-cancellation acknowledgement', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: { acknowledged: true } });
    const api = createGitRemoteDeliveryApi(invoke);

    await expect(api.cancelPlan(CONFIRMATION)).resolves.toEqual({
      ok: true,
      value: { acknowledged: true },
    });
    expect(invoke).toHaveBeenCalledWith(GIT_REMOTE_IPC_CHANNELS.cancelPlan, CONFIRMATION);

    invoke.mockResolvedValue({
      ok: true,
      value: { acknowledged: true, ownerId: 'main-owner' },
    });
    await expect(api.cancelPlan(CONFIRMATION)).rejects.toBeTruthy();
  });

  it('accepts native cancellation only from confirmation operations', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: null });
    const api = createGitRemoteDeliveryApi(invoke);

    await expect(api.confirmPush(CONFIRMATION)).resolves.toEqual({ ok: true, value: null });
    await expect(api.confirmGitHubStatus(CONFIRMATION)).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(api.confirmPullRequest(CONFIRMATION)).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(api.confirmCi(CONFIRMATION)).resolves.toEqual({ ok: true, value: null });
    await expect(api.inspect({ target: TARGET })).rejects.toBeTruthy();
  });

  it('rejects malformed or path-bearing main-process results', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        remote: 'origin',
        destinationBranch: 'feature/delivery',
        sourceOid: 'a'.repeat(40),
        repositoryPath: '/private/repository',
      },
    });
    const api = createGitRemoteDeliveryApi(invoke);

    await expect(api.confirmPush(CONFIRMATION)).rejects.toBeTruthy();

    invoke.mockResolvedValue({
      ok: true,
      value: {
        url: 'https://token@example.com/owner/repository/pull/1',
        ownerRepository: 'owner/repository',
        baseBranch: 'main',
        headBranch: 'feature/delivery',
        sourceOid: 'a'.repeat(40),
      },
    });
    await expect(api.confirmPullRequest(CONFIRMATION)).rejects.toBeTruthy();

    invoke.mockResolvedValue({
      ok: true,
      value: {
        sourceHead: 'a'.repeat(40),
        headBranch: 'feature/delivery',
        current: true,
        runs: [
          {
            databaseId: 1,
            name: 'Verify',
            workflowName: 'CI',
            status: 'completed',
            conclusion: 'success',
            url: 'https://github.com/owner/repository/actions/runs/1',
            headBranch: 'feature/delivery',
            headSha: 'b'.repeat(40),
          },
        ],
        checkedAt: '2026-07-17T12:00:00.000Z',
      },
    });
    await expect(api.confirmCi(CONFIRMATION)).rejects.toBeTruthy();
  });
});
