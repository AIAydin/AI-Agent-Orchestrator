// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunHistorySummary } from '../../../../../shared/runs/contracts.js';
import { GitAgentComparisonPanel } from './GitAgentComparisonPanel.js';

const PROJECT_ID = '97200000-0000-4000-8000-000000000001';
const LEFT_RUN_ID = '97200000-0000-4000-8000-000000000002';
const RIGHT_RUN_ID = '97200000-0000-4000-8000-000000000003';
const LEFT_HEAD = '1'.repeat(40);
const RIGHT_HEAD = '2'.repeat(40);
const listRuns = vi.fn();
const compareAgents = vi.fn();

beforeEach(() => {
  listRuns.mockReset();
  compareAgents.mockReset();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      runs: { list: listRuns },
      git: { comparison: { compareAgents } },
    },
  });
});

afterEach(cleanup);

describe('GitAgentComparisonPanel', () => {
  it('selects a second available run and renders its bounded committed-code comparison', async () => {
    listRuns.mockResolvedValue({ ok: true, value: [summary(RIGHT_RUN_ID)] });
    compareAgents.mockResolvedValue({ ok: true, value: comparisonView() });
    render(<GitAgentComparisonPanel target={target()} />);

    const runSelection = await screen.findByLabelText('Other agent run');
    expect(runSelection.getAttribute('name')).toBe('git-agent-comparison-run');
    fireEvent.change(runSelection, {
      target: { value: RIGHT_RUN_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Compare committed code' }));

    await waitFor(() =>
      expect(compareAgents).toHaveBeenCalledWith({
        left: target(),
        right: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RIGHT_RUN_ID },
      }),
    );
    expect(await screen.findByText('Right agent compared to left')).toBeTruthy();
    expect(screen.getAllByText(/left-agent/u)).toHaveLength(2);
    expect(screen.getAllByText(/right-agent/u)).toHaveLength(2);
  });

  it('shows an honest empty state when no other owned terminal worktree is available', async () => {
    listRuns.mockResolvedValue({ ok: true, value: [summary(LEFT_RUN_ID)] });
    render(<GitAgentComparisonPanel target={target()} />);

    expect(
      await screen.findByText(/Run another agent for this project and keep its workspace/u),
    ).toBeTruthy();
    expect(compareAgents).not.toHaveBeenCalled();
  });

  it('keeps a stale main-process denial visible instead of retaining an old comparison', async () => {
    listRuns.mockResolvedValue({ ok: true, value: [summary(RIGHT_RUN_ID)] });
    compareAgents.mockRejectedValue(new Error('An agent worktree changed during the comparison.'));
    render(<GitAgentComparisonPanel target={target()} />);

    fireEvent.change(await screen.findByLabelText('Other agent run'), {
      target: { value: RIGHT_RUN_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Compare committed code' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /changed during the comparison/iu,
    );
    expect(screen.queryByText('Right agent compared to left')).toBeNull();
  });
});

function target() {
  return { kind: 'agent-worktree' as const, projectId: PROJECT_ID, runId: LEFT_RUN_ID };
}

function summary(id: string): RunHistorySummary {
  return {
    id,
    projectId: PROJECT_ID,
    nodeId: id === LEFT_RUN_ID ? 'left-node' : 'right-node',
    adapterId: 'codex',
    model: null,
    permissionProfile: null,
    providerSessionAvailable: false,
    resumeSupported: false,
    resumeCapabilitySource: null,
    action: 'launch',
    parentRunId: null,
    status: 'succeeded',
    branch: 'forgeboard/comparison',
    worktreeState: 'active',
    worktreeAvailable: true,
    supersededByNewerAttempt: false,
    startedAt: '2026-07-18T12:00:00.000Z',
    endedAt: '2026-07-18T12:01:00.000Z',
    exitCode: 0,
    outputDigest: null,
    changedFileCount: 1,
    tokenUsage: null,
    costUsd: null,
    outputPreview: '',
    createdAt: '2026-07-18T12:00:00.000Z',
    updatedAt: '2026-07-18T12:01:00.000Z',
  };
}

function comparisonView() {
  return {
    left: {
      projectId: PROJECT_ID,
      runId: LEFT_RUN_ID,
      nodeId: 'left-node',
      agentId: 'left-agent',
      headCommit: LEFT_HEAD,
    },
    right: {
      projectId: PROJECT_ID,
      runId: RIGHT_RUN_ID,
      nodeId: 'right-node',
      agentId: 'right-agent',
      headCommit: RIGHT_HEAD,
    },
    comparison: {
      baseCommit: LEFT_HEAD,
      headCommit: RIGHT_HEAD,
      ahead: 1,
      behind: 1,
      commitCount: 2,
      commits: [
        { oid: RIGHT_HEAD, relation: 'ahead' as const },
        { oid: LEFT_HEAD, relation: 'behind' as const },
      ],
      commitIdsTruncated: false,
      diff: { files: [], additions: 0, deletions: 0 },
    },
  };
}
