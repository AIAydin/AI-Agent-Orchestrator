// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunHistorySummary } from '../../../../../shared/runs/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import {
  reconcileAgentStatus,
  useAgentStatusReconciliation,
} from './useAgentStatusReconciliation.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Agent recovered status reconciliation', () => {
  it('projects durable terminal and active attempt states onto restart-stale canvas state', () => {
    expect(reconcileAgentStatus(attempt('running'))).toEqual({
      status: 'running',
    });
    expect(reconcileAgentStatus(attempt('prepared'))).toEqual({
      status: 'waiting',
    });
    expect(reconcileAgentStatus(attempt('interrupted'))).toEqual({
      status: 'cancelled',
    });
    expect(reconcileAgentStatus(attempt('succeeded'))).toEqual({
      status: 'succeeded',
    });
    expect(reconcileAgentStatus(attempt('failed'))).toEqual({
      status: 'failed',
    });
    expect(reconcileAgentStatus(attempt('lost'))).toMatchObject({
      status: 'lost',
    });
  });

  it('fails closed when the canvas points at a run absent from durable history', () => {
    const patch = reconcileAgentStatus(undefined);
    expect(patch.status).toBe('lost');
    expect(patch.lastRunSummary).toMatch(/no longer available/iu);
  });

  it('reconciles a restart-stale running node through durable main-process history', async () => {
    const durable = attempt('lost');
    const get = vi.fn().mockResolvedValue({ ok: true, value: durable });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { runs: { get } },
    });
    const updateNodeData = vi.fn();
    renderHook(() =>
      useAgentStatusReconciliation({
        projectId: durable.projectId,
        nodes: [agentNode(durable.id)],
        updateNodeData,
        onError: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(updateNodeData).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ status: 'lost' }),
      ),
    );
    expect(get).toHaveBeenCalledWith({
      projectId: durable.projectId,
      runId: durable.id,
    });
  });

  it('ignores a deferred response after the canvas moves to a superseding run', async () => {
    const first = deferred<{ ok: true; value: RunHistorySummary }>();
    const newerRunId = '00000000-0000-4000-8000-000000000009';
    const get = vi.fn((input: { runId: string }) =>
      input.runId === newerRunId
        ? Promise.resolve({ ok: true as const, value: { ...attempt('running'), id: newerRunId } })
        : first.promise,
    );
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { runs: { get } },
    });
    const updateNodeData = vi.fn();
    const projectId = attempt('lost').projectId;
    const hook = renderHook(
      ({ runId }) =>
        useAgentStatusReconciliation({
          projectId,
          nodes: [agentNode(runId)],
          updateNodeData,
          onError: vi.fn(),
        }),
      { initialProps: { runId: attempt('lost').id } },
    );
    hook.rerender({ runId: newerRunId });
    first.resolve({ ok: true, value: attempt('lost') });

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('ignores a deferred response after the same run is already terminal on the canvas', async () => {
    const response = deferred<{ ok: true; value: RunHistorySummary }>();
    const get = vi.fn(() => response.promise);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { runs: { get } },
    });
    const updateNodeData = vi.fn();
    const durable = attempt('lost');
    const hook = renderHook(
      ({ status }) =>
        useAgentStatusReconciliation({
          projectId: durable.projectId,
          nodes: [agentNode(durable.id, status)],
          updateNodeData,
          onError: vi.fn(),
        }),
      {
        initialProps: {
          status: 'running' as WorkshopNode['data']['status'],
        },
      },
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    hook.rerender({ status: 'succeeded' });
    response.resolve({ ok: true, value: durable });

    await Promise.resolve();
    await Promise.resolve();
    expect(updateNodeData).not.toHaveBeenCalled();
  });

  it('retries a transient exact-history failure and reconciles the successful response', async () => {
    vi.useFakeTimers();
    const durable = attempt('lost');
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('Storage temporarily unavailable'))
      .mockResolvedValueOnce({ ok: true, value: durable });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { runs: { get } },
    });
    const updateNodeData = vi.fn();
    const onError = vi.fn();
    renderHook(() =>
      useAgentStatusReconciliation({
        projectId: durable.projectId,
        nodes: [agentNode(durable.id)],
        updateNodeData,
        onError,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(get).toHaveBeenCalledTimes(2);
    expect(updateNodeData).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ status: 'lost' }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('retries a durable nonterminal state instead of permanently settling it', async () => {
    vi.useFakeTimers();
    const running = attempt('running');
    const lost = attempt('lost');
    const get = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: running })
      .mockResolvedValueOnce({ ok: true, value: lost });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { runs: { get } },
    });
    const updateNodeData = vi.fn();
    renderHook(() =>
      useAgentStatusReconciliation({
        projectId: lost.projectId,
        nodes: [agentNode(lost.id)],
        updateNodeData,
        onError: vi.fn(),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(updateNodeData).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(get).toHaveBeenCalledTimes(2);
    expect(updateNodeData).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ status: 'lost' }),
    );
  });

  it('bounds repeated exact-history errors before reporting the failure', async () => {
    vi.useFakeTimers();
    const durable = attempt('lost');
    const get = vi.fn().mockRejectedValue(new Error('Storage unavailable'));
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { runs: { get } },
    });
    const onError = vi.fn();
    renderHook(() =>
      useAgentStatusReconciliation({
        projectId: durable.projectId,
        nodes: [agentNode(durable.id)],
        updateNodeData: vi.fn(),
        onError,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(get).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('Storage unavailable');
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function agentNode(
  runId: string,
  status: WorkshopNode['data']['status'] = 'running',
): WorkshopNode {
  return {
    id: 'agent-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'agent',
      title: 'Agent',
      description: 'Agent',
      status,
      locked: false,
      collapsed: false,
      color: '#445566',
      runId,
    },
  };
}

function attempt(status: RunHistorySummary['status']): RunHistorySummary {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    nodeId: 'agent-1',
    adapterId: 'test-agent',
    model: null,
    permissionProfile: 'plan-read-only',
    providerSessionAvailable: false,
    resumeSupported: false,
    resumeCapabilitySource: null,
    action: 'launch',
    parentRunId: null,
    status,
    branch: null,
    worktreeState: 'none',
    worktreeAvailable: false,
    supersededByNewerAttempt: false,
    startedAt: null,
    endedAt: status === 'prepared' || status === 'running' ? null : '2026-07-17T12:01:00.000Z',
    exitCode: null,
    outputDigest: null,
    changedFileCount: null,
    tokenUsage: null,
    costUsd: null,
    outputPreview: '',
    createdAt: '2026-07-17T12:00:00.000Z',
    updatedAt: '2026-07-17T12:01:00.000Z',
  };
}
