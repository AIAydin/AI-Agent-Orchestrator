// @vitest-environment jsdom

/* eslint-disable @typescript-eslint/unbound-method -- API members are Vitest mocks in this file. */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcResult } from '../../../../../shared/application/contracts.js';
import type {
  GitHubCiPlanView,
  GitHubCiResultView,
  GitHubPullRequestPlanView,
  GitHubStatusPlanView,
  GitHubStatusResultView,
  GitRemoteInspectView,
  GitRemotePushPlanView,
} from '../../../../../shared/git/remote/index.js';
import type { RunHistorySummary } from '../../../../../shared/runs/contracts.js';
import type { GitRemoteDeliveryApi } from '../../../../../preload/git/remote/index.js';
import type { GitPrNodeConfiguration } from './types.js';
import { useGitPrNodeController } from './useGitPrNodeController.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const RUN_ID = '20000000-0000-4000-8000-000000000001';
const CLEANUP_RUN_ID = '20000000-0000-4000-8000-000000000002';
const SOURCE_OID = 'a'.repeat(40);
const BASE_OID = 'b'.repeat(40);
const DIVERGENCE_BASE_OID = 'd'.repeat(40);
const PLAN_ID = '30000000-0000-4000-8000-000000000001';
const SECOND_PLAN_ID = '30000000-0000-4000-8000-000000000002';
const APPROVAL_ID = '40000000-0000-4000-8000-000000000001';

let operations: GitRemoteDeliveryApi;
let listRuns: ReturnType<typeof vi.fn>;

beforeEach(() => {
  operations = createOperations();
  listRuns = vi
    .fn()
    .mockResolvedValue(
      success([
        runSummary(RUN_ID, true, 'active'),
        runSummary(CLEANUP_RUN_ID, false, 'cleanup-pending'),
        runSummary('20000000-0000-4000-8000-000000000003', false, 'cleaned'),
      ]),
    );
});

describe('useGitPrNodeController', () => {
  it('loads only path-free owned runs and performs no remote operation until requested', async () => {
    vi.mocked(operations.inspect).mockResolvedValue(success(inspectView(false)));
    const onError = vi.fn();
    const { result } = renderController({ onError });

    await waitFor(() => expect(result.current.agentRunsLoaded).toBe(true));
    expect(result.current.agentRuns).toEqual([
      {
        runId: RUN_ID,
        nodeLabel: 'Implementation agent',
        agentLabel: 'Deterministic test agent',
        status: 'succeeded',
        branch: 'forgeboard/remote-delivery',
        worktreeState: 'active',
        endedAt: '2026-07-17T01:02:00.000Z',
      },
      {
        runId: CLEANUP_RUN_ID,
        nodeLabel: 'Implementation agent',
        agentLabel: 'Deterministic test agent',
        status: 'succeeded',
        branch: 'forgeboard/remote-delivery',
        worktreeState: 'cleanup-pending',
        endedAt: '2026-07-17T01:02:00.000Z',
      },
    ]);
    expect(JSON.stringify(result.current.agentRuns)).not.toMatch(
      /repositoryRoot|worktreeRoot|managedRoot|cwd/u,
    );
    expect(operations.inspect).not.toHaveBeenCalled();
    expect(operations.preparePush).not.toHaveBeenCalled();
    expect(operations.prepareGitHubStatus).not.toHaveBeenCalled();
    expect(operations.preparePullRequest).not.toHaveBeenCalled();
    expect(operations.prepareCi).not.toHaveBeenCalled();

    act(() => result.current.inspect());
    await waitFor(() => expect(result.current.inspection).not.toBeNull());
    expect(operations.inspect).toHaveBeenCalledWith({
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
    });
    expect(result.current.inspection).toMatchObject({
      sourceBranch: 'forgeboard/remote-delivery',
      sourceOid: SOURCE_OID,
      remote: 'origin',
      remoteDisclosure: 'https://github.com/example/forgeboard.git',
      destinationBranch: 'forgeboard/remote-delivery',
      requestedBaseBranch: 'main',
      runBaseRef: 'refs/heads/main',
      runBaseOid: BASE_OID,
      divergenceBaseOid: DIVERGENCE_BASE_OID,
      commitCount: 1,
      fileCount: 1,
      ahead: 1,
      behind: 0,
      ready: false,
    });
    expect(result.current.inspection?.readiness).toContain(
      'Delivery checks and human quality approval have not been prepared.',
    );
    expect(result.current.availableRemotes).toEqual(['origin']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps the default run-list operation stable across renderer rerenders', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'forgeboard');
    const defaultListRuns = vi
      .fn()
      .mockResolvedValue(success([runSummary(RUN_ID, true, 'active')]));
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { runs: { list: defaultListRuns } },
    });
    const hook = renderHook(() =>
      useGitPrNodeController({
        projectId: PROJECT_ID,
        configuration: configuration(),
        nodes: [{ id: 'agent-node', data: { title: 'Implementation agent' } }],
        agents: [{ id: 'test-agent', label: 'Deterministic test agent' }],
        onError: vi.fn(),
        onPullRequestCreated: vi.fn(),
        operations,
      }),
    );
    try {
      await waitFor(() => expect(hook.result.current.agentRunsLoaded).toBe(true));
      hook.rerender();
      await act(async () => await Promise.resolve());
      expect(defaultListRuns).toHaveBeenCalledTimes(1);
    } finally {
      hook.unmount();
      if (original === undefined) delete (window as { forgeboard?: unknown }).forgeboard;
      else Object.defineProperty(window, 'forgeboard', original);
    }
  });

  it('binds every push, GitHub, PR, and CI call to current config and handles cancellation', async () => {
    vi.mocked(operations.inspect).mockResolvedValue(success(inspectView(true)));
    vi.mocked(operations.preparePush).mockResolvedValue(success(pushPlan()));
    vi.mocked(operations.confirmPush)
      .mockResolvedValueOnce(success(null))
      .mockResolvedValueOnce(
        success({
          remote: 'origin',
          destinationBranch: 'forgeboard/remote-delivery',
          sourceOid: SOURCE_OID,
        }),
      );
    vi.mocked(operations.prepareGitHubStatus).mockResolvedValue(success(githubPlan()));
    vi.mocked(operations.confirmGitHubStatus).mockResolvedValue(success(githubResult()));
    vi.mocked(operations.preparePullRequest).mockResolvedValue(success(pullRequestPlan()));
    vi.mocked(operations.confirmPullRequest).mockResolvedValue(
      success({
        url: 'https://github.com/example/forgeboard/pull/42',
        ownerRepository: 'example/forgeboard',
        baseBranch: 'main',
        headBranch: 'forgeboard/remote-delivery',
        sourceOid: SOURCE_OID,
      }),
    );
    vi.mocked(operations.prepareCi).mockResolvedValue(success(ciPlan()));
    vi.mocked(operations.confirmCi).mockResolvedValue(success(ciResult()));
    const onPullRequestCreated = vi.fn();
    const { result } = renderController({ onPullRequestCreated });
    await waitFor(() => expect(result.current.agentRunsLoaded).toBe(true));

    act(() => result.current.inspect());
    await waitFor(() => expect(result.current.inspection?.ready).toBe(true));

    act(() => result.current.preparePush());
    await waitFor(() => expect(result.current.pendingPlan?.kind).toBe('push'));
    expect(operations.preparePush).toHaveBeenCalledWith({
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
      remote: 'origin',
      destinationBranch: 'forgeboard/remote-delivery',
    });
    act(() => result.current.confirmPlan());
    await waitFor(() => expect(result.current.notice).toContain('Push cancelled'));

    act(() => result.current.preparePush());
    await waitFor(() => expect(result.current.pendingPlan?.kind).toBe('push'));
    act(() => result.current.confirmPlan());
    await waitFor(() => expect(result.current.notice).toContain(`Pushed exact ${SOURCE_OID}`));
    expect(operations.confirmPush).toHaveBeenCalledTimes(2);

    act(() => result.current.checkGitHub());
    await waitFor(() => expect(result.current.githubStatus?.authenticated).toBe(true));
    expect(operations.prepareGitHubStatus).toHaveBeenCalledWith({
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
      remote: 'origin',
      destinationBranch: 'forgeboard/remote-delivery',
      baseBranch: 'main',
    });
    expect(result.current.githubStatus).toMatchObject({
      ownerRepository: 'example/forgeboard',
      sourceOid: SOURCE_OID,
      headMatchesSource: true,
    });

    act(() => result.current.preparePullRequest());
    await waitFor(() => expect(result.current.pendingPlan?.kind).toBe('pull-request'));
    expect(result.current.pendingPlan?.inspection).toMatchObject({
      requestedBaseBranch: 'main',
      requestedBaseOid: BASE_OID,
      sourceBranch: 'forgeboard/remote-delivery',
      sourceOid: SOURCE_OID,
      commits: [SOURCE_OID],
      files: [{ status: 'added', oldPath: null, newPath: 'remote-proof.md' }],
    });
    expect(operations.preparePullRequest).toHaveBeenCalledWith({
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
      remote: 'origin',
      destinationBranch: 'forgeboard/remote-delivery',
      baseBranch: 'main',
      title: 'Ship exact remote delivery',
      body: 'Evidence-backed body',
      draft: false,
    });
    act(() => result.current.confirmPlan());
    await waitFor(() =>
      expect(onPullRequestCreated).toHaveBeenCalledWith(
        'https://github.com/example/forgeboard/pull/42',
      ),
    );

    act(() => result.current.checkCi());
    await waitFor(() => expect(result.current.ciStatus?.runs).toHaveLength(1));
    expect(operations.prepareCi).toHaveBeenCalledWith({
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
      remote: 'origin',
      destinationBranch: 'forgeboard/remote-delivery',
      baseBranch: 'main',
    });
    expect(result.current.ciStatus?.sourceOid).toBe(SOURCE_OID);
  });

  it('releases an explicitly cancelled prepared plan through the owner-bound backend', async () => {
    vi.mocked(operations.inspect).mockResolvedValue(success(inspectView(true)));
    vi.mocked(operations.preparePush).mockResolvedValue(success(pushPlan()));
    const { result } = renderController();
    await waitFor(() => expect(result.current.agentRunsLoaded).toBe(true));

    act(() => result.current.inspect());
    await waitFor(() => expect(result.current.inspection?.ready).toBe(true));
    act(() => result.current.preparePush());
    await waitFor(() => expect(result.current.pendingPlan?.kind).toBe('push'));

    act(() => result.current.cancelPlan());
    expect(result.current.pendingPlan).toBeNull();
    await waitFor(() => expect(operations.cancelPlan).toHaveBeenCalledWith({ planId: PLAN_ID }));
    expect(operations.cancelPlan).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(result.current.notice).toBe(
        'Cancelled the prepared remote action. Nothing remote changed.',
      ),
    );
    expect(operations.confirmPush).not.toHaveBeenCalled();
  });

  it('releases superseded and unmounted plans exactly once', async () => {
    vi.mocked(operations.inspect).mockResolvedValue(success(inspectView(true)));
    vi.mocked(operations.preparePush)
      .mockResolvedValueOnce(success(pushPlan()))
      .mockResolvedValueOnce(success({ ...pushPlan(), planId: SECOND_PLAN_ID }));
    const hook = renderController();
    await waitFor(() => expect(hook.result.current.agentRunsLoaded).toBe(true));

    act(() => hook.result.current.inspect());
    await waitFor(() => expect(hook.result.current.inspection?.ready).toBe(true));
    act(() => hook.result.current.preparePush());
    await waitFor(() => expect(hook.result.current.pendingPlan?.planId).toBe(PLAN_ID));
    act(() => hook.result.current.preparePush());
    await waitFor(() => expect(hook.result.current.pendingPlan?.planId).toBe(SECOND_PLAN_ID));
    await waitFor(() => expect(operations.cancelPlan).toHaveBeenCalledWith({ planId: PLAN_ID }));
    expect(operations.cancelPlan).toHaveBeenCalledTimes(1);

    hook.unmount();
    await waitFor(() =>
      expect(operations.cancelPlan).toHaveBeenCalledWith({ planId: SECOND_PLAN_ID }),
    );
    expect(operations.cancelPlan).toHaveBeenCalledTimes(2);
  });

  it('hides a prepared plan after configuration changes and reports operation failures', async () => {
    vi.mocked(operations.preparePush).mockResolvedValue(success(pushPlan()));
    vi.mocked(operations.inspect)
      .mockResolvedValueOnce(success(inspectView(true)))
      .mockRejectedValueOnce(new Error('Exact source ownership expired.'));
    const onError = vi.fn();
    const initial = configuration();
    const hook = renderHook(
      ({ currentConfiguration }: { currentConfiguration: GitPrNodeConfiguration }) =>
        useGitPrNodeController({
          projectId: PROJECT_ID,
          configuration: currentConfiguration,
          nodes: [{ id: 'agent-node', data: { title: 'Implementation agent' } }],
          agents: [{ id: 'test-agent', label: 'Deterministic test agent' }],
          onError,
          onPullRequestCreated: vi.fn(),
          operations,
          listRuns,
        }),
      { initialProps: { currentConfiguration: initial } },
    );
    await waitFor(() => expect(hook.result.current.agentRunsLoaded).toBe(true));

    act(() => hook.result.current.inspect());
    await waitFor(() => expect(hook.result.current.inspection?.ready).toBe(true));
    act(() => hook.result.current.preparePush());
    await waitFor(() => expect(hook.result.current.pendingPlan).not.toBeNull());
    hook.rerender({ currentConfiguration: configuration({ remote: 'upstream' }) });
    expect(hook.result.current.pendingPlan).toBeNull();
    await waitFor(() => expect(operations.cancelPlan).toHaveBeenCalledWith({ planId: PLAN_ID }));
    expect(operations.cancelPlan).toHaveBeenCalledTimes(1);
    expect(hook.result.current.availableRemotes).toEqual(['origin']);
    await waitFor(() => expect(hook.result.current.inspection).toBeNull());
    expect(operations.confirmPush).not.toHaveBeenCalled();

    hook.rerender({ currentConfiguration: initial });
    await waitFor(() => expect(hook.result.current.pendingPlan).toBeNull());
    expect(hook.result.current.inspection).toBeNull();
    hook.rerender({ currentConfiguration: configuration({ remote: 'upstream' }) });

    act(() => hook.result.current.inspect());
    await waitFor(() =>
      expect(hook.result.current.inspectionError).toBe('Exact source ownership expired.'),
    );
    expect(onError).toHaveBeenCalledWith('Exact source ownership expired.');

    hook.rerender({ currentConfiguration: configuration({ remote: 'fork' }) });
    await waitFor(() => expect(hook.result.current.inspectionError).toBeNull());
  });

  it('drops an in-flight inspection when configuration changes before it resolves', async () => {
    let resolveInspection: ((value: IpcResult<GitRemoteInspectView>) => void) | undefined;
    vi.mocked(operations.inspect).mockImplementation(
      async () =>
        await new Promise<IpcResult<GitRemoteInspectView>>((resolve) => {
          resolveInspection = resolve;
        }),
    );
    const initial = configuration();
    const hook = renderHook(
      ({ currentConfiguration }: { currentConfiguration: GitPrNodeConfiguration }) =>
        useGitPrNodeController({
          projectId: PROJECT_ID,
          configuration: currentConfiguration,
          nodes: [{ id: 'agent-node', data: { title: 'Implementation agent' } }],
          agents: [{ id: 'test-agent', label: 'Deterministic test agent' }],
          onError: vi.fn(),
          onPullRequestCreated: vi.fn(),
          operations,
          listRuns,
        }),
      { initialProps: { currentConfiguration: initial } },
    );
    await waitFor(() => expect(hook.result.current.agentRunsLoaded).toBe(true));

    act(() => hook.result.current.inspect());
    await waitFor(() => expect(hook.result.current.busy).toBe('inspect'));
    hook.rerender({ currentConfiguration: configuration({ remote: 'upstream' }) });
    await act(async () => {
      resolveInspection?.(success(inspectView(true)));
      await Promise.resolve();
    });

    await waitFor(() => expect(hook.result.current.busy).toBeNull());
    expect(hook.result.current.inspection).toBeNull();
    expect(hook.result.current.inspectionError).toBeNull();
  });

  it('does not apply an old push or pull-request confirmation result to changed config', async () => {
    vi.mocked(operations.inspect).mockResolvedValue(success(inspectView(true)));
    vi.mocked(operations.preparePush).mockResolvedValue(success(pushPlan()));
    vi.mocked(operations.prepareGitHubStatus).mockResolvedValue(success(githubPlan()));
    vi.mocked(operations.confirmGitHubStatus).mockResolvedValue(success(githubResult()));
    vi.mocked(operations.preparePullRequest).mockResolvedValue(success(pullRequestPlan()));
    let resolvePush:
      | ((value: IpcResult<Awaited<ReturnType<typeof pushResult>>>) => void)
      | undefined;
    vi.mocked(operations.confirmPush).mockImplementation(
      async () =>
        await new Promise((resolve) => {
          resolvePush = resolve;
        }),
    );
    const onPullRequestCreated = vi.fn();
    const initial = configuration();
    const hook = renderHook(
      ({ currentConfiguration }: { currentConfiguration: GitPrNodeConfiguration }) =>
        useGitPrNodeController({
          projectId: PROJECT_ID,
          configuration: currentConfiguration,
          nodes: [{ id: 'agent-node', data: { title: 'Implementation agent' } }],
          agents: [{ id: 'test-agent', label: 'Deterministic test agent' }],
          onError: vi.fn(),
          onPullRequestCreated,
          operations,
          listRuns,
        }),
      { initialProps: { currentConfiguration: initial } },
    );
    await waitFor(() => expect(hook.result.current.agentRunsLoaded).toBe(true));
    act(() => hook.result.current.inspect());
    await waitFor(() => expect(hook.result.current.inspection?.ready).toBe(true));
    act(() => hook.result.current.preparePush());
    await waitFor(() => expect(hook.result.current.pendingPlan?.kind).toBe('push'));
    act(() => hook.result.current.confirmPlan());
    expect(hook.result.current.pendingPlan).toBeNull();
    await waitFor(() => expect(hook.result.current.busy).toBe('confirm-push'));
    hook.rerender({ currentConfiguration: configuration({ remote: 'upstream' }) });
    await act(async () => {
      resolvePush?.(success(pushResult()));
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.busy).toBeNull());
    expect(hook.result.current.notice).toBeNull();

    hook.rerender({ currentConfiguration: initial });
    act(() => hook.result.current.inspect());
    await waitFor(() => expect(hook.result.current.inspection?.ready).toBe(true));
    act(() => hook.result.current.checkGitHub());
    await waitFor(() => expect(hook.result.current.githubStatus?.fresh).toBe(true));
    act(() => hook.result.current.preparePullRequest());
    await waitFor(() => expect(hook.result.current.pendingPlan?.kind).toBe('pull-request'));
    let resolvePullRequest:
      | ((value: Awaited<ReturnType<GitRemoteDeliveryApi['confirmPullRequest']>>) => void)
      | undefined;
    vi.mocked(operations.confirmPullRequest).mockImplementation(
      async () =>
        await new Promise((resolve) => {
          resolvePullRequest = resolve;
        }),
    );
    act(() => hook.result.current.confirmPlan());
    expect(hook.result.current.pendingPlan).toBeNull();
    await waitFor(() => expect(hook.result.current.busy).toBe('confirm-pull-request'));
    hook.rerender({
      currentConfiguration: configuration({ pullRequestTitle: 'A changed pull request' }),
    });
    await act(async () => {
      resolvePullRequest?.(
        success({
          url: 'https://github.com/example/forgeboard/pull/42',
          ownerRepository: 'example/forgeboard',
          baseBranch: 'main',
          headBranch: 'forgeboard/remote-delivery',
          sourceOid: SOURCE_OID,
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.busy).toBeNull());
    expect(onPullRequestCreated).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toBeNull();
    expect(operations.cancelPlan).not.toHaveBeenCalled();
  });

  it('does not confirm a GitHub or CI plan prepared for settings that changed in flight', async () => {
    vi.mocked(operations.inspect).mockResolvedValue(success(inspectView(true)));
    let resolveGitHubPlan: ((value: IpcResult<GitHubStatusPlanView>) => void) | undefined;
    vi.mocked(operations.prepareGitHubStatus).mockImplementation(
      async () =>
        await new Promise((resolve) => {
          resolveGitHubPlan = resolve;
        }),
    );
    const initial = configuration();
    const hook = renderHook(
      ({ currentConfiguration }: { currentConfiguration: GitPrNodeConfiguration }) =>
        useGitPrNodeController({
          projectId: PROJECT_ID,
          configuration: currentConfiguration,
          nodes: [{ id: 'agent-node', data: { title: 'Implementation agent' } }],
          agents: [{ id: 'test-agent', label: 'Deterministic test agent' }],
          onError: vi.fn(),
          onPullRequestCreated: vi.fn(),
          operations,
          listRuns,
        }),
      { initialProps: { currentConfiguration: initial } },
    );
    await waitFor(() => expect(hook.result.current.agentRunsLoaded).toBe(true));
    act(() => hook.result.current.inspect());
    await waitFor(() => expect(hook.result.current.inspection).not.toBeNull());
    act(() => hook.result.current.checkGitHub());
    await waitFor(() => expect(hook.result.current.busy).toBe('github-status'));
    hook.rerender({ currentConfiguration: configuration({ baseBranch: 'develop' }) });
    await act(async () => {
      resolveGitHubPlan?.(success(githubPlan()));
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.busy).toBeNull());
    expect(operations.confirmGitHubStatus).not.toHaveBeenCalled();
    expect(operations.cancelPlan).toHaveBeenCalledWith({ planId: PLAN_ID });
    expect(operations.cancelPlan).toHaveBeenCalledTimes(1);
    vi.mocked(operations.cancelPlan).mockClear();

    hook.rerender({ currentConfiguration: initial });
    act(() => hook.result.current.inspect());
    await waitFor(() => expect(hook.result.current.inspection).not.toBeNull());
    vi.mocked(operations.prepareGitHubStatus).mockResolvedValue(success(githubPlan()));
    vi.mocked(operations.confirmGitHubStatus).mockResolvedValue(success(githubResult()));
    act(() => hook.result.current.checkGitHub());
    await waitFor(() => expect(hook.result.current.githubStatus?.fresh).toBe(true));
    let resolveCiPlan: ((value: IpcResult<GitHubCiPlanView>) => void) | undefined;
    vi.mocked(operations.prepareCi).mockImplementation(
      async () =>
        await new Promise((resolve) => {
          resolveCiPlan = resolve;
        }),
    );
    act(() => hook.result.current.checkCi());
    await waitFor(() => expect(hook.result.current.busy).toBe('ci-status'));
    hook.rerender({ currentConfiguration: configuration({ destinationBranch: 'changed' }) });
    await act(async () => {
      resolveCiPlan?.(success(ciPlan()));
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.busy).toBeNull());
    expect(operations.confirmCi).not.toHaveBeenCalled();
    expect(operations.cancelPlan).toHaveBeenCalledWith({ planId: PLAN_ID });
    expect(operations.cancelPlan).toHaveBeenCalledTimes(1);
  });

  it('invalidates same-configuration evidence before a refresh that fails', async () => {
    vi.mocked(operations.inspect)
      .mockResolvedValueOnce(success(inspectView(true)))
      .mockRejectedValueOnce(new Error('Current source ownership could not be verified.'));
    const { result } = renderController();
    await waitFor(() => expect(result.current.agentRunsLoaded).toBe(true));
    act(() => result.current.inspect());
    await waitFor(() => expect(result.current.inspection?.ready).toBe(true));

    act(() => result.current.inspect());
    expect(result.current.inspection).toBeNull();
    await waitFor(() =>
      expect(result.current.inspectionError).toBe(
        'Current source ownership could not be verified.',
      ),
    );
    act(() => result.current.preparePush());
    expect(operations.preparePush).not.toHaveBeenCalled();
  });

  it('clears old GitHub and CI evidence before a repeated GitHub check can fail', async () => {
    vi.mocked(operations.inspect).mockResolvedValue(success(inspectView(true)));
    vi.mocked(operations.prepareGitHubStatus).mockResolvedValue(success(githubPlan()));
    vi.mocked(operations.confirmGitHubStatus)
      .mockResolvedValueOnce(success(githubResult()))
      .mockRejectedValueOnce(new Error('GitHub authorization refresh failed.'));
    vi.mocked(operations.prepareCi).mockResolvedValue(success(ciPlan()));
    vi.mocked(operations.confirmCi).mockResolvedValue(success(ciResult()));
    const { result } = renderController();
    await waitFor(() => expect(result.current.agentRunsLoaded).toBe(true));
    act(() => result.current.inspect());
    await waitFor(() => expect(result.current.inspection).not.toBeNull());
    act(() => result.current.checkGitHub());
    await waitFor(() => expect(result.current.githubStatus?.authenticated).toBe(true));
    act(() => result.current.checkCi());
    await waitFor(() => expect(result.current.ciStatus).not.toBeNull());

    act(() => result.current.checkGitHub());
    expect(result.current.githubStatus).toBeNull();
    expect(result.current.ciStatus).toBeNull();
    await waitFor(() =>
      expect(result.current.githubError).toBe('GitHub authorization refresh failed.'),
    );
    act(() => result.current.preparePullRequest());
    act(() => result.current.checkCi());
    expect(operations.preparePullRequest).not.toHaveBeenCalled();
    expect(operations.prepareCi).toHaveBeenCalledTimes(1);
  });

  it('expires GitHub evidence locally without polling and blocks PR or CI preparation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
    try {
      vi.mocked(operations.inspect).mockResolvedValue(success(inspectView(true)));
      vi.mocked(operations.prepareGitHubStatus).mockResolvedValue(success(githubPlan()));
      vi.mocked(operations.confirmGitHubStatus).mockResolvedValue(success(githubResult()));
      const hook = renderController();
      await flushMicrotasks();
      expect(hook.result.current.agentRunsLoaded).toBe(true);
      act(() => hook.result.current.inspect());
      await flushMicrotasks();
      expect(hook.result.current.inspection).not.toBeNull();
      act(() => hook.result.current.checkGitHub());
      await flushMicrotasks();
      expect(hook.result.current.githubStatus?.fresh).toBe(true);

      act(() => {
        vi.advanceTimersByTime(5 * 60_000 + 1);
      });
      expect(hook.result.current.githubStatus?.fresh).toBe(false);
      act(() => hook.result.current.preparePullRequest());
      act(() => hook.result.current.checkCi());
      expect(operations.preparePullRequest).not.toHaveBeenCalled();
      expect(operations.prepareCi).not.toHaveBeenCalled();
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

function renderController(
  overrides: {
    readonly onError?: (message: string) => void;
    readonly onPullRequestCreated?: (url: string) => void;
  } = {},
) {
  return renderHook(() =>
    useGitPrNodeController({
      projectId: PROJECT_ID,
      configuration: configuration(),
      nodes: [{ id: 'agent-node', data: { title: 'Implementation agent' } }],
      agents: [{ id: 'test-agent', label: 'Deterministic test agent' }],
      onError: overrides.onError ?? vi.fn(),
      onPullRequestCreated: overrides.onPullRequestCreated ?? vi.fn(),
      operations,
      listRuns,
    }),
  );
}

function configuration(overrides: Partial<GitPrNodeConfiguration> = {}): GitPrNodeConfiguration {
  return {
    targetRunId: RUN_ID,
    remote: 'origin',
    destinationBranch: 'forgeboard/remote-delivery',
    baseBranch: 'main',
    pullRequestTitle: 'Ship exact remote delivery',
    pullRequestBody: 'Evidence-backed body',
    pullRequestDraft: false,
    ...overrides,
  };
}

function createOperations(): GitRemoteDeliveryApi {
  return {
    inspect: vi.fn(),
    cancelPlan: vi.fn().mockResolvedValue(success({ acknowledged: true })),
    preparePush: vi.fn(),
    confirmPush: vi.fn(),
    prepareGitHubStatus: vi.fn(),
    confirmGitHubStatus: vi.fn(),
    preparePullRequest: vi.fn(),
    confirmPullRequest: vi.fn(),
    prepareCi: vi.fn(),
    confirmCi: vi.fn(),
  };
}

function success<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function pushResult() {
  return {
    remote: 'origin',
    destinationBranch: 'forgeboard/remote-delivery',
    sourceOid: SOURCE_OID,
  };
}

function runSummary(
  id: string,
  worktreeAvailable: boolean,
  worktreeState: RunHistorySummary['worktreeState'],
): RunHistorySummary {
  return {
    id,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'test-agent',
    model: null,
    providerSessionAvailable: false,
    resumeSupported: false,
    resumeCapabilitySource: null,
    permissionProfile: null,
    supersededByNewerAttempt: false,
    action: 'launch',
    parentRunId: null,
    status: 'succeeded',
    branch: 'forgeboard/remote-delivery',
    worktreeState,
    worktreeAvailable,
    startedAt: '2026-07-17T01:01:00.000Z',
    endedAt: '2026-07-17T01:02:00.000Z',
    exitCode: 0,
    outputDigest: 'a'.repeat(64),
    changedFileCount: 1,
    tokenUsage: null,
    costUsd: null,
    outputPreview: '',
    createdAt: '2026-07-17T01:00:00.000Z',
    updatedAt: '2026-07-17T01:02:00.000Z',
  };
}

function inspectView(ready: boolean): GitRemoteInspectView {
  return {
    target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
    projectName: 'Forgeboard demo',
    sourceBranch: 'forgeboard/remote-delivery',
    baseRef: 'refs/heads/main',
    baseCommit: BASE_OID,
    divergenceBaseCommit: DIVERGENCE_BASE_OID,
    sourceHead: SOURCE_OID,
    ahead: 1,
    behind: 0,
    dirty: false,
    commitCount: 1,
    commits: [SOURCE_OID],
    commitsTruncated: false,
    fileCount: 1,
    files: [{ status: 'added', oldPath: null, newPath: 'remote-proof.md' }],
    filesTruncated: false,
    additions: 12,
    deletions: 0,
    remotes: [remoteDescriptor()],
    defaultRemote: 'origin',
    readiness: ready ? readyDiscovery() : unpreparedDiscovery(),
    refreshedAt: '2026-07-17T01:03:00.000Z',
  } as GitRemoteInspectView;
}

function pushPlan(): GitRemotePushPlanView {
  return {
    kind: 'git-push',
    planId: PLAN_ID,
    expiresAt: '2026-07-17T01:10:00.000Z',
    target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
    projectName: 'Forgeboard demo',
    remote: remoteDescriptor(),
    sourceBranch: 'forgeboard/remote-delivery',
    destinationBranch: 'forgeboard/remote-delivery',
    baseCommit: BASE_OID,
    sourceHead: SOURCE_OID,
    commitCount: 1,
    commits: [SOURCE_OID],
    fileCount: 1,
    files: [{ status: 'added', oldPath: null, newPath: 'remote-proof.md' }],
    additions: 12,
    deletions: 0,
    force: false,
    readiness: readyReadiness(),
    readinessApprovalId: APPROVAL_ID,
  } as GitRemotePushPlanView;
}

function githubPlan(): GitHubStatusPlanView {
  return {
    kind: 'github-status',
    planId: PLAN_ID,
    expiresAt: '2026-07-17T01:10:00.000Z',
    target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
    remote: remoteDescriptor(),
    baseBranch: 'main',
    headBranch: 'forgeboard/remote-delivery',
    sourceHead: SOURCE_OID,
  };
}

function githubResult(): GitHubStatusResultView {
  return {
    installed: true,
    version: '2.76.1',
    hostname: 'github.com',
    authenticated: true,
    ownerRepository: 'example/forgeboard',
    repositoryUrl: 'https://github.com/example/forgeboard',
    defaultBranch: 'main',
    baseBranch: 'main',
    headBranch: 'forgeboard/remote-delivery',
    sourceHead: SOURCE_OID,
    baseOid: BASE_OID,
    headOid: SOURCE_OID,
    headMatchesSource: true,
    checkedAt: new Date().toISOString(),
  };
}

function pullRequestPlan(): GitHubPullRequestPlanView {
  return {
    kind: 'github-pull-request',
    planId: PLAN_ID,
    expiresAt: '2026-07-17T01:12:00.000Z',
    target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
    projectName: 'Forgeboard demo',
    remote: remoteDescriptor(),
    ownerRepository: 'example/forgeboard',
    baseBranch: 'main',
    headBranch: 'forgeboard/remote-delivery',
    baseOid: BASE_OID,
    headOid: SOURCE_OID,
    sourceHead: SOURCE_OID,
    commitCount: 1,
    commits: [SOURCE_OID],
    fileCount: 1,
    files: [{ status: 'added', oldPath: null, newPath: 'remote-proof.md' }],
    additions: 12,
    deletions: 0,
    title: 'Ship exact remote delivery',
    bodySha256: 'c'.repeat(64),
    bodyCharacterCount: 20,
    draft: false,
    readiness: readyReadiness(),
    readinessApprovalId: APPROVAL_ID,
  } as GitHubPullRequestPlanView;
}

function ciPlan(): GitHubCiPlanView {
  return {
    kind: 'github-ci',
    planId: PLAN_ID,
    expiresAt: '2026-07-17T01:13:00.000Z',
    target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
    remote: remoteDescriptor(),
    ownerRepository: 'example/forgeboard',
    baseBranch: 'main',
    headBranch: 'forgeboard/remote-delivery',
    sourceHead: SOURCE_OID,
  };
}

function ciResult(): GitHubCiResultView {
  return {
    sourceHead: SOURCE_OID,
    headBranch: 'forgeboard/remote-delivery',
    current: true,
    runs: [
      {
        databaseId: 42,
        name: 'verify',
        workflowName: 'Verify',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/example/forgeboard/actions/runs/42',
        headBranch: 'forgeboard/remote-delivery',
        headSha: SOURCE_OID,
      },
    ],
    checkedAt: '2026-07-17T01:14:00.000Z',
  };
}

function remoteDescriptor() {
  return {
    kind: 'network' as const,
    name: 'origin',
    endpoint: 'github.com',
    resource: 'example/forgeboard.git',
    transport: 'https' as const,
    githubCompatible: true,
  };
}

function unpreparedDiscovery() {
  return {
    target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
    source: {
      sourceHead: SOURCE_OID,
      sourceTree: 'd'.repeat(40),
      worktreeId: '50000000-0000-4000-8000-000000000001',
      runId: RUN_ID,
    },
    availableChecks: [deliveryCheckAvailability()],
    compatibleWorkflowExecutions: [
      {
        executionId: 'workflow-execution-1',
        canvasId: 'canvas-1',
        executionRevision: 7,
        endedAt: '2026-07-17T01:02:00.000Z',
        derivedCheckIds: ['delivery-check-1'],
      },
    ],
    workflowUnavailableReason: null,
    readiness: null,
    staleReason: null,
    refreshedAt: '2026-07-17T01:03:00.000Z',
  };
}

function readyDiscovery() {
  return { ...unpreparedDiscovery(), readiness: readyReadiness() };
}

function readyReadiness() {
  const sourceFingerprint = deliverySourceFingerprint();
  return {
    readinessId: '60000000-0000-4000-8000-000000000001',
    target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
    sourceFingerprint,
    workflowBinding: {
      executionId: 'workflow-execution-1',
      executionRevision: 7,
      canvasId: 'canvas-1',
      sourceNodeId: 'agent-node',
      sourceAttempt: 1,
      sourceOutputDigest: '2'.repeat(64),
      gates: [
        {
          gateNodeId: 'review-gate-1',
          gateAttempt: 1,
          evidenceDigest: '3'.repeat(64),
          derivedCheckIds: ['delivery-check-1'],
        },
      ],
      bindingDigest: '4'.repeat(64),
    },
    availableChecks: [deliveryCheckAvailability()],
    requiredChecks: [
      {
        checkId: 'delivery-check-1',
        label: 'Delivery verification',
        kind: 'custom' as const,
        configurationDigest: 'e'.repeat(64),
        state: 'passed' as const,
        executionId: '65000000-0000-4000-8000-000000000001',
        sourceFingerprint,
        startedAt: '2026-07-17T01:02:30.000Z',
        endedAt: '2026-07-17T01:03:00.000Z',
        updatedAt: '2026-07-17T01:03:00.000Z',
      },
    ],
    approvals: [
      {
        approvalId: APPROVAL_ID,
        authority: 'human' as const,
        actorId: 'local-reviewer',
        actorLabel: 'Local reviewer',
        sourceFingerprint,
        evidenceFingerprint: '1'.repeat(64),
        approvedAt: '2026-07-17T01:04:00.000Z',
      },
    ],
    evidenceFingerprint: '1'.repeat(64),
    updatedAt: '2026-07-17T01:04:00.000Z',
    evaluation: { ready: true, humanApprovalState: 'approved', blockers: [] },
  };
}

function deliveryCheckAvailability() {
  return {
    checkId: 'delivery-check-1',
    label: 'Delivery verification',
    kind: 'custom' as const,
    availability: 'configured' as const,
    configurationDigest: 'e'.repeat(64),
  };
}

function deliverySourceFingerprint() {
  return {
    sourceHead: SOURCE_OID,
    sourceTree: 'd'.repeat(40),
    worktreeId: '50000000-0000-4000-8000-000000000001',
    runId: RUN_ID,
    requiredCheckConfigurationDigest: 'e'.repeat(64),
    digest: 'f'.repeat(64),
  };
}
