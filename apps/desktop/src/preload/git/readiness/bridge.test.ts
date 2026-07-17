import { describe, expect, it, vi } from 'vitest';

import { GIT_DELIVERY_READINESS_IPC_CHANNELS } from '../../../shared/git/readiness/index.js';
import {
  READINESS_TEST_IDS,
  readinessFingerprint,
  readinessGetView,
  readinessView,
} from '../../../shared/git/readiness/test-fixtures.js';
import { createGitDeliveryReadinessApi } from './bridge.js';

const TARGET = {
  kind: 'agent-worktree' as const,
  projectId: READINESS_TEST_IDS.projectId,
  runId: READINESS_TEST_IDS.runId,
};

const GET_INPUT = { target: TARGET };
const PREPARE_INPUT = {
  target: TARGET,
  workflowExecutionId: READINESS_TEST_IDS.workflowExecutionId,
  additionalCheckIds: [READINESS_TEST_IDS.checkId],
};
const RUN_INPUT = {
  readinessId: READINESS_TEST_IDS.readinessId,
  checkId: READINESS_TEST_IDS.checkId,
  expectedSourceFingerprint: readinessFingerprint().digest,
};
const APPROVE_INPUT = {
  readinessId: READINESS_TEST_IDS.readinessId,
  expectedSourceFingerprint: readinessFingerprint().digest,
  confirmed: true as const,
};

describe('createGitDeliveryReadinessApi', () => {
  it('validates and forwards exact get, prepare, run, and approve requests', async () => {
    const getView = readinessGetView(null);
    const failure = {
      ok: false as const,
      error: {
        code: 'READINESS_UNAVAILABLE',
        message: 'Delivery readiness is temporarily unavailable.',
      },
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: getView })
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(failure);
    const api = createGitDeliveryReadinessApi(invoke);

    await expect(api.get(GET_INPUT)).resolves.toEqual({ ok: true, value: getView });
    await expect(api.prepare(PREPARE_INPUT)).resolves.toEqual(failure);
    await expect(api.run(RUN_INPUT)).resolves.toEqual(failure);
    await expect(api.approve(APPROVE_INPUT)).resolves.toEqual(failure);

    expect(invoke.mock.calls).toEqual([
      [GIT_DELIVERY_READINESS_IPC_CHANNELS.get, GET_INPUT],
      [GIT_DELIVERY_READINESS_IPC_CHANNELS.prepare, PREPARE_INPUT],
      [GIT_DELIVERY_READINESS_IPC_CHANNELS.run, RUN_INPUT],
      [GIT_DELIVERY_READINESS_IPC_CHANNELS.approve, APPROVE_INPUT],
    ]);
  });

  it('rejects path-bearing or otherwise extra input fields before invoking main', async () => {
    const invoke = vi.fn();
    const api = createGitDeliveryReadinessApi(invoke);

    await expect(
      api.get({ target: { ...TARGET, worktreePath: '/private/managed/worktree' } } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.prepare({
        ...PREPARE_INPUT,
        target: { ...TARGET, repositoryRoot: '/private/repository' },
      } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.run({ ...RUN_INPUT, cwd: '/private/managed/worktree' } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.approve({ ...APPROVE_INPUT, worktreePath: '/private/managed/worktree' } as never),
    ).rejects.toBeTruthy();

    expect(invoke).not.toHaveBeenCalled();
  });

  it('enforces workflow, additional-check, fingerprint, and confirmation constraints', async () => {
    const invoke = vi.fn();
    const api = createGitDeliveryReadinessApi(invoke);

    await expect(api.prepare({ ...PREPARE_INPUT, workflowExecutionId: '' })).rejects.toBeTruthy();
    await expect(
      api.prepare({
        ...PREPARE_INPUT,
        additionalCheckIds: [READINESS_TEST_IDS.checkId, READINESS_TEST_IDS.checkId],
      }),
    ).rejects.toBeTruthy();
    await expect(
      api.run({ ...RUN_INPUT, expectedSourceFingerprint: 'not-a-sha256' }),
    ).rejects.toBeTruthy();
    await expect(api.approve({ ...APPROVE_INPUT, confirmed: false } as never)).rejects.toBeTruthy();

    expect(invoke).not.toHaveBeenCalled();
  });

  it('accepts native-cancel null results only for run and approve', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: null });
    const api = createGitDeliveryReadinessApi(invoke);

    await expect(api.run(RUN_INPUT)).resolves.toEqual({ ok: true, value: null });
    await expect(api.approve(APPROVE_INPUT)).resolves.toEqual({ ok: true, value: null });
    await expect(api.get(GET_INPUT)).rejects.toBeTruthy();
    await expect(api.prepare(PREPARE_INPUT)).rejects.toBeTruthy();
  });

  it('rejects malformed get and prepare responses from main', async () => {
    const getView = readinessGetView(null);
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ...getView,
        source: { ...getView.source, repositoryRoot: '/private/repository' },
      },
    });
    const api = createGitDeliveryReadinessApi(invoke);

    await expect(api.get(GET_INPUT)).rejects.toBeTruthy();

    invoke.mockResolvedValue({
      ok: true,
      value: { ...readinessView(), worktreePath: '/private/managed/worktree' },
    });
    await expect(api.prepare(PREPARE_INPUT)).rejects.toBeTruthy();
  });

  it('rejects malformed run and approve responses from main', async () => {
    const view = readinessView();
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: { ...view, evaluation: { ...view.evaluation, ready: false } },
    });
    const api = createGitDeliveryReadinessApi(invoke);

    await expect(api.run(RUN_INPUT)).rejects.toBeTruthy();

    invoke.mockResolvedValue({ ok: true });
    await expect(api.approve(APPROVE_INPUT)).rejects.toBeTruthy();
  });
});
