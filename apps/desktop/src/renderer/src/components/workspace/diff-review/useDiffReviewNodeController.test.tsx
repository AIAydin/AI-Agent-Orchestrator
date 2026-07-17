// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentDetection, Project } from '../../../../../shared/application/contracts.js';
import type { GitReviewView, GitTargetInput } from '../../../../../shared/git/contracts.js';
import type { RunHistorySummary } from '../../../../../shared/runs/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { useDiffReviewNodeController } from './useDiffReviewNodeController.js';

const PROJECT_ID = '91000000-0000-4000-8000-000000000001';
const RUN_ID = '91000000-0000-4000-8000-000000000002';
const PENDING_RUN_ID = '91000000-0000-4000-8000-000000000004';
const CLEANED_RUN_ID = '91000000-0000-4000-8000-000000000005';

const listRuns = vi.fn();
const reviewGit = vi.fn();

beforeEach(() => {
  listRuns.mockReset();
  reviewGit.mockReset();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { runs: { list: listRuns }, git: { review: reviewGit } },
  });
});

describe('useDiffReviewNodeController', () => {
  it('maps active and cleanup-pending path-free choices while excluding cleaned runs', async () => {
    listRuns.mockResolvedValue({
      ok: true,
      value: [
        runSummary(true),
        { ...runSummary(false), id: crypto.randomUUID() },
        runSummary(false, 'cleanup-pending', PENDING_RUN_ID),
        runSummary(false, 'cleaned', CLEANED_RUN_ID),
      ],
    });
    reviewGit.mockResolvedValue({
      ok: true,
      value: review({ kind: 'primary', projectId: PROJECT_ID }),
    });

    const { result } = renderHook(() =>
      useDiffReviewNodeController({
        project: project(),
        nodes: [agentNode(), diffNode({ kind: 'primary' })],
        agents: agents(),
        selectedNode: diffNode({ kind: 'primary' }),
        workflowRevisionFingerprint: '',
        onError: vi.fn(),
      }),
    );

    await waitFor(() => expect(result.current.agentRunsLoaded).toBe(true));
    await waitFor(() => expect(result.current.authority.state).toBe('ready'));
    expect(result.current.agentRuns).toEqual([
      {
        runId: RUN_ID,
        nodeLabel: 'Implementation agent',
        agentLabel: 'Deterministic test agent',
        status: 'succeeded',
        branch: 'forgeboard/implementation',
        worktreeState: 'active',
        endedAt: '2026-07-16T15:02:00.000Z',
      },
      {
        runId: PENDING_RUN_ID,
        nodeLabel: 'Implementation agent',
        agentLabel: 'Deterministic test agent',
        status: 'succeeded',
        branch: 'forgeboard/implementation',
        worktreeState: 'cleanup-pending',
        endedAt: '2026-07-16T15:02:00.000Z',
      },
    ]);
    expect(result.current.summary?.target).toEqual({ kind: 'primary', projectId: PROJECT_ID });
    expect(JSON.stringify(result.current.agentRuns)).not.toMatch(
      /cwd|repositoryRoot|managedRoot|worktreeId/u,
    );
  });

  it('verifies an exact selected run even when it is outside the bounded recent picker', async () => {
    const target = { kind: 'agent-worktree' as const, projectId: PROJECT_ID, runId: RUN_ID };
    listRuns.mockResolvedValue({ ok: true, value: [] });
    reviewGit.mockResolvedValue({ ok: true, value: review(target) });
    const selected = diffNode({ kind: 'agent-run', runId: RUN_ID });

    const { result } = renderHook(() =>
      useDiffReviewNodeController({
        project: project(),
        nodes: [selected],
        agents: [],
        selectedNode: selected,
        workflowRevisionFingerprint: '',
        onError: vi.fn(),
      }),
    );

    await waitFor(() => expect(result.current.authority.state).toBe('ready'));
    expect(reviewGit).toHaveBeenCalledWith(target);
    expect(result.current.agentRuns).toEqual([]);
    expect(result.current.summary?.target).toEqual(target);
  });
});

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Demo',
    path: '/tmp/demo',
    openedAt: '2026-07-16T15:00:00.000Z',
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function agents(): AgentDetection[] {
  return [
    {
      id: 'test-agent',
      label: 'Deterministic test agent',
      executable: '/Applications/Forgeboard/TestAgent',
      installed: true,
      version: '1.0.0',
      providerDisclosure: 'Local deterministic fixture.',
    },
  ];
}

function runSummary(
  worktreeAvailable: boolean,
  worktreeState: RunHistorySummary['worktreeState'] = 'active',
  id = RUN_ID,
): RunHistorySummary {
  return {
    id,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'test-agent',
    status: 'succeeded',
    branch: 'forgeboard/implementation',
    worktreeState,
    worktreeAvailable,
    startedAt: '2026-07-16T15:01:00.000Z',
    endedAt: '2026-07-16T15:02:00.000Z',
    createdAt: '2026-07-16T15:00:00.000Z',
    updatedAt: '2026-07-16T15:02:00.000Z',
  };
}

function agentNode(): WorkshopNode {
  return node('agent-node', 'agent', 'Implementation agent', {
    runId: RUN_ID,
    status: 'succeeded',
  });
}

function diffNode(reviewTarget: WorkshopNode['data']['reviewTarget']): WorkshopNode {
  return node('diff-node', 'diff', 'Review implementation', {
    ...(reviewTarget === undefined ? {} : { reviewTarget }),
  });
}

function node(
  id: string,
  kind: WorkshopNode['data']['kind'],
  title: string,
  data: Partial<WorkshopNode['data']>,
): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind,
      title,
      description: '',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#778899',
      ...data,
    },
  };
}

function review(target: GitTargetInput): GitReviewView {
  return {
    target:
      target.kind === 'primary'
        ? target
        : {
            ...target,
            nodeId: 'agent-node',
            worktreeId: '91000000-0000-4000-8000-000000000003',
            agentId: 'test-agent',
            baseRef: 'refs/heads/main',
            baseCommit: 'a'.repeat(40),
          },
    branch: target.kind === 'primary' ? 'main' : 'forgeboard/implementation',
    detached: false,
    headOid: 'b'.repeat(40),
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    conflicted: false,
    entries: [],
    staged: { files: [], additions: 0, deletions: 0 },
    unstaged: { files: [], additions: 0, deletions: 0 },
    identity: {
      name: 'Reviewer',
      email: 'reviewer@example.test',
      nameSource: 'settings',
      emailSource: 'settings',
      ready: true,
    },
    refreshedAt: '2026-07-16T15:03:00.000Z',
  };
}
