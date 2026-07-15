// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckExecutionView, CheckPlanView } from '../../../../shared/check-contracts.js';
import { useProjectChecks } from './useProjectChecks.js';

const PROJECT_A = '30000000-0000-4000-8000-000000000001';
const PROJECT_B = '30000000-0000-4000-8000-000000000002';

const list = vi.fn();
const prepare = vi.fn();
const confirm = vi.fn();
const cancel = vi.fn();
const onError = vi.fn();

beforeEach(() => {
  list.mockReset();
  prepare.mockReset();
  confirm.mockReset();
  cancel.mockReset();
  onError.mockReset();
  list.mockResolvedValue({ ok: true, value: [] });
  prepare.mockResolvedValue({ ok: true, value: plan(PROJECT_A) });
  confirm.mockResolvedValue({ ok: true, value: null });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      checks: {
        list,
        prepare,
        confirm,
        cancel,
        onEvent: vi.fn(() => vi.fn()),
      },
    },
  });
});

afterEach(cleanup);

describe('useProjectChecks', () => {
  it('never exposes one project execution as the latest result for another project', async () => {
    list.mockImplementation(({ projectId }: { projectId: string }) =>
      Promise.resolve({
        ok: true,
        value: projectId === PROJECT_A ? [execution(PROJECT_A)] : [],
      }),
    );
    const hook = renderChecks(PROJECT_A);

    await waitFor(() => expect(hook.result.current.checks.latestByCheckId.has('lint')).toBe(true));
    let resolvePrepare!: (result: { ok: true; value: CheckPlanView }) => void;
    prepare.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePrepare = resolve;
      }),
    );
    let pendingPrepare!: Promise<void>;
    act(() => {
      pendingPrepare = hook.result.current.checks.prepare('lint');
    });
    expect(hook.result.current.checks.busyCheckId).toBe('lint');

    hook.rerender({ projectId: PROJECT_B });

    expect(hook.result.current.checks.executions).toEqual([]);
    expect(hook.result.current.checks.latestByCheckId.has('lint')).toBe(false);
    expect(hook.result.current.checks.busyCheckId).toBeNull();

    resolvePrepare({ ok: true, value: plan(PROJECT_A) });
    await act(async () => await pendingPrepare);
    expect(hook.result.current.checks.busyCheckId).toBeNull();
    expect(confirm).toHaveBeenCalledWith({
      planId: plan(PROJECT_A).planId,
      confirmed: false,
    });
  });

  it('releases a renderer-cancelled plan through the main process', async () => {
    const hook = renderChecks(PROJECT_A);

    await act(async () => await hook.result.current.checks.prepare('lint'));
    expect(hook.result.current.checks.plan?.planId).toBe(plan(PROJECT_A).planId);

    act(() => hook.result.current.checks.dismissPlan());

    expect(hook.result.current.checks.plan).toBeNull();
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith({
        planId: plan(PROJECT_A).planId,
        confirmed: false,
      }),
    );
    await waitFor(() =>
      expect(hook.result.current.events[0]).toBe('Cancelled the check approval before launch.'),
    );
  });

  it('closes an already-consumed disclosure when confirmation fails', async () => {
    confirm.mockRejectedValueOnce(new Error('Approval expired.'));
    const hook = renderChecks(PROJECT_A);
    await act(async () => await hook.result.current.checks.prepare('lint'));

    await act(async () => await hook.result.current.checks.confirm());

    expect(hook.result.current.checks.plan).toBeNull();
    expect(onError).toHaveBeenCalledWith('Approval expired.');
  });

  it('keeps every other check control busy until native confirmation settles', async () => {
    let resolveConfirmation!: (result: { ok: true; value: null }) => void;
    confirm.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfirmation = resolve;
      }),
    );
    const hook = renderChecks(PROJECT_A);
    await act(async () => await hook.result.current.checks.prepare('lint'));

    let pendingConfirmation!: Promise<void>;
    act(() => {
      pendingConfirmation = hook.result.current.checks.confirm();
    });
    expect(hook.result.current.checks.busyCheckId).toBe('lint');

    resolveConfirmation({ ok: true, value: null });
    await act(async () => await pendingConfirmation);
    expect(hook.result.current.checks.busyCheckId).toBeNull();
  });
});

function renderChecks(initialProjectId: string) {
  return renderHook(
    ({ projectId }: { projectId: string }) => {
      const [events, setEvents] = useState<string[]>([]);
      const checks = useProjectChecks({ projectId, setEvents, onError });
      return { checks, events };
    },
    { initialProps: { projectId: initialProjectId } },
  );
}

function plan(projectId: string): CheckPlanView {
  return {
    planId: '30000000-0000-4000-8000-000000000003',
    projectId,
    checkId: 'lint',
    label: 'Lint',
    kind: 'lint',
    executable: '/usr/bin/node',
    arguments: ['--version'],
    cwd: '/tmp/project',
    environmentVariableNames: ['PATH'],
    expiresAt: '2099-07-15T00:05:00.000Z',
  };
}

function execution(projectId: string): CheckExecutionView {
  return {
    id: '30000000-0000-4000-8000-000000000004',
    projectId,
    checkId: 'lint',
    label: 'Lint',
    kind: 'lint',
    executable: '/usr/bin/node',
    arguments: ['--version'],
    cwd: '/tmp/project',
    environmentVariableNames: ['PATH'],
    status: 'passed',
    exitCode: 0,
    startedAt: '2026-07-15T00:00:00.000Z',
    endedAt: '2026-07-15T00:00:01.000Z',
    output: 'v22\n',
    outputTruncated: false,
    updatedAt: '2026-07-15T00:00:01.000Z',
  };
}
