// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunEventEnvelope } from '../../../../../../shared/application/contracts.js';
import type { RunHistorySummary } from '../../../../../../shared/runs/contracts.js';
import { useAgentAttemptHistory } from './useAgentAttemptHistory.js';

afterEach(() => vi.restoreAllMocks());

describe('useAgentAttemptHistory terminal invalidation', () => {
  it('refetches automatically after a terminal event for this Agent node', async () => {
    let listener: ((event: RunEventEnvelope) => void) | undefined;
    const first: readonly RunHistorySummary[] = [];
    const terminal = [attempt('interrupted')];
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: first })
      .mockResolvedValue({ ok: true, value: terminal });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        runs: {
          list,
          onEvent: (next: (event: RunEventEnvelope) => void) => {
            listener = next;
            return vi.fn();
          },
        },
      },
    });

    const hook = renderHook(() => useAgentAttemptHistory('project-1', 'agent-1', 'running'));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.attempts).toEqual([]);

    act(() => listener?.(event('run-summary', 'agent-1')));
    await waitFor(() => expect(hook.result.current.attempts).toEqual(terminal));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('ignores terminal events for another node', async () => {
    let listener: ((event: RunEventEnvelope) => void) | undefined;
    const list = vi.fn().mockResolvedValue({ ok: true, value: [] });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        runs: {
          list,
          onEvent: (next: (event: RunEventEnvelope) => void) => {
            listener = next;
            return vi.fn();
          },
        },
      },
    });

    const hook = renderHook(() => useAgentAttemptHistory('project-1', 'agent-1', 'running'));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => listener?.(event('run-summary', 'agent-2')));
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(list).toHaveBeenCalledTimes(1);
  });
});

function event(kind: RunEventEnvelope['kind'], nodeId: string): RunEventEnvelope {
  return { runId: 'run-1', nodeId, kind, payload: { status: 'interrupted' } };
}

function attempt(status: RunHistorySummary['status']): RunHistorySummary {
  return {
    id: 'run-1',
    projectId: 'project-1',
    nodeId: 'agent-1',
    adapterId: 'test-agent',
    action: 'launch',
    parentRunId: null,
    status,
    model: null,
    permissionProfile: 'worktree-write',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:01.000Z',
    startedAt: '2026-07-17T00:00:00.000Z',
    endedAt: '2026-07-17T00:00:01.000Z',
    branch: null,
    exitCode: 130,
    changedFileCount: 1,
    outputPreview: 'interrupted',
    outputDigest: null,
    tokenUsage: null,
    costUsd: null,
    providerSessionAvailable: true,
    resumeSupported: true,
    resumeCapabilitySource: 'manifest',
    worktreeState: 'active',
    worktreeAvailable: true,
    supersededByNewerAttempt: false,
  };
}
