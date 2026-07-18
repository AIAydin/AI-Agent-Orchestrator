// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GitDeliveryReadinessGetView,
  GitDeliveryReadinessTarget,
  GitDeliveryReadinessView,
} from '../../../../../shared/git/readiness/index.js';
import {
  READINESS_TEST_IDS,
  readinessCheck,
  readinessGetView,
  readinessView,
} from '../../../../../shared/git/readiness/test-fixtures.js';
import { useGitDeliveryReadiness } from './useGitDeliveryReadiness.js';

const TARGET_A: GitDeliveryReadinessTarget = {
  kind: 'agent-worktree',
  projectId: READINESS_TEST_IDS.projectId,
  runId: READINESS_TEST_IDS.runId,
};
const TARGET_B: GitDeliveryReadinessTarget = {
  kind: 'agent-worktree',
  projectId: '10000000-0000-4000-8000-000000000002',
  runId: '20000000-0000-4000-8000-000000000002',
};

const get = vi.fn();
const prepare = vi.fn();
const run = vi.fn();
const approve = vi.fn();

beforeEach(() => {
  get.mockReset();
  prepare.mockReset();
  run.mockReset();
  approve.mockReset();
  get.mockResolvedValue(ok(readinessGetView()));
  prepare.mockResolvedValue(ok(preparedReadiness('missing')));
  run.mockResolvedValue(ok(null));
  approve.mockResolvedValue(ok(null));
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { git: { readiness: { get, prepare, run, approve } } },
  });
});

afterEach(cleanup);

describe('useGitDeliveryReadiness', () => {
  it('stays fail-closed for a null target and selects every configured check after discovery', async () => {
    const request = deferred<ReturnType<typeof ok<GitDeliveryReadinessGetView>>>();
    get.mockReturnValueOnce(request.promise);
    const hook = renderReadiness(null);

    expect(hook.result.current.view).toBeNull();
    expect(hook.result.current.selectedCheckIds).toEqual([]);
    expect(hook.result.current.loading).toBe(false);
    expect(get).not.toHaveBeenCalled();

    hook.rerender({ target: TARGET_A });
    expect(hook.result.current.view).toBeNull();
    expect(hook.result.current.loading).toBe(true);
    const discovered = {
      ...readinessGetView(),
      staleReason: 'The source changed after the previous delivery evidence was recorded.',
      availableChecks: [
        ...readinessGetView().availableChecks,
        {
          checkId: 'lint' as const,
          label: 'Lint',
          kind: 'lint' as const,
          availability: 'configured' as const,
          configurationDigest: '8'.repeat(64),
        },
        {
          checkId: 'build' as const,
          label: 'Build',
          kind: 'build' as const,
          availability: 'disabled' as const,
          configurationDigest: null,
        },
      ],
    };
    await act(async () => {
      request.resolve(ok(discovered));
      await request.promise;
    });

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.view?.staleReason).toBe(discovered.staleReason);
    expect(hook.result.current.selectedCheckIds).toEqual([READINESS_TEST_IDS.checkId, 'lint']);
  });

  it('initializes selection from prepared requirements instead of every available check', async () => {
    const prepared = preparedReadiness('missing');
    const discovered = readinessGetView(prepared);
    discovered.availableChecks.push({
      checkId: 'lint',
      label: 'Lint',
      kind: 'lint',
      availability: 'configured',
      configurationDigest: '8'.repeat(64),
    });
    get.mockResolvedValueOnce(ok(discovered));
    const hook = renderReadiness(TARGET_A);

    await waitFor(() => expect(hook.result.current.view).toBe(discovered));
    expect(hook.result.current.selectedCheckIds).toEqual([READINESS_TEST_IDS.checkId]);
  });

  it('ignores a discovery response after the managed target changes', async () => {
    const first = deferred<ReturnType<typeof ok<GitDeliveryReadinessGetView>>>();
    const second = deferred<ReturnType<typeof ok<GitDeliveryReadinessGetView>>>();
    get.mockReset();
    get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const hook = renderReadiness(TARGET_A);

    hook.rerender({ target: TARGET_B });
    expect(hook.result.current.view).toBeNull();
    expect(hook.result.current.selectedCheckIds).toEqual([]);
    const targetBView = getViewForTarget(TARGET_B);
    await act(async () => {
      second.resolve(ok(targetBView));
      await second.promise;
    });
    await waitFor(() =>
      expect(hook.result.current.view?.target.projectId).toBe(TARGET_B.projectId),
    );

    await act(async () => {
      first.resolve(ok(readinessGetView()));
      await first.promise;
    });
    expect(hook.result.current.view?.target.projectId).toBe(TARGET_B.projectId);
    expect(hook.result.current.selectedCheckIds).toEqual([READINESS_TEST_IDS.checkId]);
  });

  it('saves the UI-selected required checks and refreshes the authoritative GetView', async () => {
    const unprepared = readinessGetView();
    const prepared = preparedReadiness('missing');
    const refreshed = readinessGetView(prepared);
    get.mockReset();
    get.mockResolvedValueOnce(ok(unprepared)).mockResolvedValueOnce(ok(refreshed));
    const save = deferred<ReturnType<typeof ok<GitDeliveryReadinessView>>>();
    prepare.mockReturnValueOnce(save.promise);
    const hook = renderReadiness(TARGET_A);
    await waitFor(() => expect(hook.result.current.view).toBe(unprepared));

    let pending!: Promise<boolean>;
    act(() => {
      pending = hook.result.current.prepareRequirements([READINESS_TEST_IDS.checkId]);
    });
    expect(hook.result.current.busy).toEqual({ kind: 'prepare-requirements' });
    await act(async () => {
      save.resolve(ok(prepared));
      await save.promise;
    });
    await expect(pending).resolves.toBe(true);

    expect(prepare).toHaveBeenCalledWith({
      target: TARGET_A,
      requiredCheckIds: [READINESS_TEST_IDS.checkId],
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(hook.result.current.view).toBe(refreshed);
    expect(hook.result.current.busy).toBeNull();
  });

  it('refreshes after native run cancellation and returns a cancellation notice', async () => {
    const prepared = preparedReadiness('missing');
    const current = readinessGetView(prepared);
    get.mockReset();
    get.mockResolvedValueOnce(ok(current)).mockResolvedValueOnce(ok(current));
    const confirmation = deferred<ReturnType<typeof ok<GitDeliveryReadinessView | null>>>();
    run.mockReturnValueOnce(confirmation.promise);
    const hook = renderReadiness(TARGET_A);
    await waitFor(() => expect(hook.result.current.view).toBe(current));

    let pending!: ReturnType<typeof hook.result.current.runCheck>;
    act(() => {
      pending = hook.result.current.runCheck(READINESS_TEST_IDS.checkId);
    });
    expect(hook.result.current.busy).toEqual({
      kind: 'run-check',
      checkId: READINESS_TEST_IDS.checkId,
    });
    let notice: Awaited<typeof pending>;
    await act(async () => {
      confirmation.resolve(ok(null));
      notice = await pending;
    });

    expect(notice).toEqual({
      kind: 'check-run-cancelled',
      checkId: READINESS_TEST_IDS.checkId,
    });
    expect(run).toHaveBeenCalledWith({
      readinessId: prepared.readinessId,
      checkId: READINESS_TEST_IDS.checkId,
      expectedSourceFingerprint: prepared.sourceFingerprint.digest,
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(hook.result.current.busy).toBeNull();
  });

  it('reports the authoritative terminal state returned by a completed check run', async () => {
    const prepared = preparedReadiness('missing');
    const failed = preparedReadiness('failed');
    get.mockReset();
    get
      .mockResolvedValueOnce(ok(readinessGetView(prepared)))
      .mockResolvedValueOnce(ok(readinessGetView(failed)));
    run.mockResolvedValueOnce(ok(failed));
    const hook = renderReadiness(TARGET_A);
    await waitFor(() => expect(hook.result.current.view?.readiness).toBe(prepared));

    let notice: Awaited<ReturnType<typeof hook.result.current.runCheck>>;
    await act(async () => {
      notice = await hook.result.current.runCheck(READINESS_TEST_IDS.checkId);
    });

    expect(notice).toEqual({
      kind: 'check-run-result',
      checkId: READINESS_TEST_IDS.checkId,
      state: 'failed',
    });
    expect(hook.result.current.view?.readiness).toBe(failed);
    expect(hook.result.current.ready).toBe(false);
  });

  it('clears stale ready evidence and refreshes authoritatively when a run fails', async () => {
    const ready = readinessView({ requiredChecks: [readinessCheck('passed')] });
    const lost = readinessView({
      requiredChecks: [readinessCheck('lost')],
      approvals: ready.approvals,
      evidenceFingerprint: '8'.repeat(64),
    });
    const authoritativeRefresh = deferred<ReturnType<typeof ok<GitDeliveryReadinessGetView>>>();
    get.mockReset();
    get
      .mockResolvedValueOnce(ok(readinessGetView(ready)))
      .mockReturnValueOnce(authoritativeRefresh.promise);
    run.mockResolvedValueOnce({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'Check completion evidence was lost.' },
    });
    const hook = renderReadiness(TARGET_A);
    await waitFor(() => expect(hook.result.current.ready).toBe(true));

    let pending!: ReturnType<typeof hook.result.current.runCheck>;
    act(() => {
      pending = hook.result.current.runCheck(READINESS_TEST_IDS.checkId);
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(hook.result.current.view).toBeNull();
    expect(hook.result.current.ready).toBe(false);
    expect(hook.result.current.loading).toBe(true);

    await act(async () => {
      authoritativeRefresh.resolve(ok(readinessGetView(lost)));
      await pending;
    });
    expect(hook.result.current.view?.readiness).toBe(lost);
    expect(hook.result.current.ready).toBe(false);
    expect(hook.result.current.error).toBe('Check completion evidence was lost.');
  });

  it('refreshes after native quality-approval cancellation without claiming approval', async () => {
    const prepared = preparedReadiness('passed');
    const current = readinessGetView(prepared);
    get.mockReset();
    get.mockResolvedValueOnce(ok(current)).mockResolvedValueOnce(ok(current));
    const confirmation = deferred<ReturnType<typeof ok<GitDeliveryReadinessView | null>>>();
    approve.mockReturnValueOnce(confirmation.promise);
    const hook = renderReadiness(TARGET_A);
    await waitFor(() => expect(hook.result.current.view).toBe(current));

    let pending!: ReturnType<typeof hook.result.current.approveQuality>;
    act(() => {
      pending = hook.result.current.approveQuality();
    });
    expect(hook.result.current.busy).toEqual({ kind: 'approve-quality' });
    let notice: Awaited<typeof pending>;
    await act(async () => {
      confirmation.resolve(ok(null));
      notice = await pending;
    });

    expect(notice).toEqual({ kind: 'quality-approval-cancelled' });
    expect(approve).toHaveBeenCalledWith({
      readinessId: prepared.readinessId,
      expectedSourceFingerprint: prepared.sourceFingerprint.digest,
      confirmed: true,
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(hook.result.current.view?.readiness?.evaluation.humanApprovalState).toBe('missing');
  });

  it('blocks approval locally until the prepared selection is exact and every check passes', async () => {
    const prepared = preparedReadiness('failed');
    get.mockResolvedValueOnce(ok(readinessGetView(prepared)));
    const hook = renderReadiness(TARGET_A);
    await waitFor(() => expect(hook.result.current.view?.readiness).toBe(prepared));

    let result: Awaited<ReturnType<typeof hook.result.current.approveQuality>>;
    await act(async () => {
      result = await hook.result.current.approveQuality();
    });
    expect(result).toBeUndefined();
    expect(approve).not.toHaveBeenCalled();
    expect(hook.result.current.error).toContain('Every required check must pass');

    act(() => hook.result.current.setSelectedCheckIds(['lint']));
    await act(async () => {
      result = await hook.result.current.runCheck(READINESS_TEST_IDS.checkId);
    });
    expect(result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(hook.result.current.error).toContain('Save the current selection of required checks');
  });

  it('does not refresh or publish a run response after target change or unmount', async () => {
    const prepared = preparedReadiness('missing');
    get.mockReset();
    get.mockImplementation(({ target }: { target: GitDeliveryReadinessTarget }) =>
      Promise.resolve(
        ok(
          target.projectId === TARGET_A.projectId
            ? readinessGetView(prepared)
            : getViewForTarget(TARGET_B),
        ),
      ),
    );
    const firstConfirmation = deferred<ReturnType<typeof ok<GitDeliveryReadinessView | null>>>();
    run.mockReturnValueOnce(firstConfirmation.promise);
    const hook = renderReadiness(TARGET_A);
    await waitFor(() => expect(hook.result.current.view?.readiness).toBe(prepared));
    let firstAction!: ReturnType<typeof hook.result.current.runCheck>;
    act(() => {
      firstAction = hook.result.current.runCheck(READINESS_TEST_IDS.checkId);
    });

    hook.rerender({ target: TARGET_B });
    await waitFor(() =>
      expect(hook.result.current.view?.target.projectId).toBe(TARGET_B.projectId),
    );
    await act(async () => {
      firstConfirmation.resolve(ok(null));
      await firstConfirmation.promise;
    });
    await expect(firstAction).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(2);

    const secondPrepared = preparedReadiness('missing');
    const secondConfirmation = deferred<ReturnType<typeof ok<GitDeliveryReadinessView | null>>>();
    get.mockResolvedValueOnce(ok(readinessGetView(secondPrepared)));
    run.mockReturnValueOnce(secondConfirmation.promise);
    const unmounted = renderReadiness(TARGET_A);
    await waitFor(() => expect(unmounted.result.current.view?.readiness).toBe(secondPrepared));
    let secondAction!: ReturnType<typeof unmounted.result.current.runCheck>;
    act(() => {
      secondAction = unmounted.result.current.runCheck(READINESS_TEST_IDS.checkId);
    });
    unmounted.unmount();
    await act(async () => {
      secondConfirmation.resolve(ok(null));
      await secondConfirmation.promise;
    });
    await expect(secondAction).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('surfaces load errors while keeping the evidence view unavailable', async () => {
    get.mockRejectedValueOnce(new Error('Managed worktree is unavailable.'));
    const hook = renderReadiness(TARGET_A);

    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.view).toBeNull();
    expect(hook.result.current.error).toBe('Managed worktree is unavailable.');
  });
});

function renderReadiness(initialTarget: GitDeliveryReadinessTarget | null) {
  return renderHook(
    ({ target }: { target: GitDeliveryReadinessTarget | null }) => useGitDeliveryReadiness(target),
    { initialProps: { target: initialTarget } },
  );
}

function preparedReadiness(state: 'missing' | 'passed' | 'failed'): GitDeliveryReadinessView {
  return readinessView({
    requiredChecks: [readinessCheck(state)],
    approvals: [],
  });
}

function getViewForTarget(target: GitDeliveryReadinessTarget): GitDeliveryReadinessGetView {
  const base = readinessGetView();
  return {
    ...base,
    target,
    source: {
      ...base.source,
      runId: target.runId,
      worktreeId:
        target === TARGET_A
          ? READINESS_TEST_IDS.worktreeId
          : '30000000-0000-4000-8000-000000000002',
    },
  };
}

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
