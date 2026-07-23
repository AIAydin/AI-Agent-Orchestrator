// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunHistorySummary } from '../../../../../shared/runs/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { useAgentWorktreeRecord } from './useAgentWorktreeAvailability.js';

afterEach(() => vi.restoreAllMocks());

describe('useAgentWorktreeRecord', () => {
  it('revalidates a path-free assignment marker against durable owned history', async () => {
    const get = vi.fn().mockResolvedValue({ ok: true, value: attempt(true) });
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { runs: { get } },
    });
    const updateNodeData = vi.fn();
    renderHook(() =>
      useAgentWorktreeRecord({
        projectId: PROJECT_ID,
        nodes: [agentNode(true)],
        updateNodeData,
      }),
    );

    await waitFor(() =>
      expect(updateNodeData).toHaveBeenCalledWith('agent-1', { worktreeRecordedActive: true }),
    );
  });

  it('clears persisted worktree and branch claims after cleanup', async () => {
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: { runs: { get: vi.fn().mockResolvedValue({ ok: true, value: attempt(false) }) } },
    });
    const updateNodeData = vi.fn();
    renderHook(() =>
      useAgentWorktreeRecord({
        projectId: PROJECT_ID,
        nodes: [agentNode()],
        updateNodeData,
      }),
    );

    await waitFor(() =>
      expect(updateNodeData).toHaveBeenCalledWith('agent-1', {
        branch: undefined,
        worktreeId: undefined,
        worktreeRecordedActive: undefined,
      }),
    );
  });
});

const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const RUN_ID = '00000000-0000-4000-8000-000000000001';

function agentNode(pathFree = false): WorkshopNode {
  return {
    id: 'agent-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'agent',
      title: 'Agent',
      description: 'Agent',
      status: 'succeeded',
      locked: false,
      collapsed: false,
      color: '#445566',
      runId: RUN_ID,
      branch: 'forgeboard/agent-1',
      ...(pathFree ? { worktreeRecordedActive: true } : { worktreeId: 'worktree-1' }),
    },
  };
}

function attempt(worktreeAvailable: boolean): RunHistorySummary {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-1',
    adapterId: 'codex',
    model: null,
    permissionProfile: 'plan-read-only',
    providerSessionAvailable: false,
    resumeSupported: false,
    resumeCapabilitySource: null,
    action: 'launch',
    parentRunId: null,
    status: 'succeeded',
    branch: worktreeAvailable ? 'forgeboard/agent-1' : null,
    worktreeState: worktreeAvailable ? 'active' : 'cleaned',
    worktreeAvailable,
    supersededByNewerAttempt: false,
    startedAt: '2026-07-18T00:00:00.000Z',
    endedAt: '2026-07-18T00:01:00.000Z',
    exitCode: 0,
    outputDigest: null,
    changedFileCount: 1,
    tokenUsage: null,
    costUsd: null,
    outputPreview: '',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:01:00.000Z',
  };
}
