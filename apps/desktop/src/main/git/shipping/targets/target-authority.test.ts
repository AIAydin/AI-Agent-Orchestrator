import type { ChangeService, RepositoryService } from '@forgeboard/git-engine';
import { describe, expect, it, vi } from 'vitest';

import type { GitTargetResolver, ResolvedGitTarget } from '../../git-target-resolver.js';
import {
  GitShippingService,
  type GitShippingReadinessAuthority,
  type PendingGitShippingPlan,
} from '../git-shipping-service.js';

const PROJECT_ID = '84000000-0000-4000-8000-000000000001';
const RUN_ID = '84000000-0000-4000-8000-000000000002';
const WORKTREE_ID = '84000000-0000-4000-8000-000000000003';
const HEAD = 'a'.repeat(40);

describe('GitShippingService target authority', () => {
  it.each([
    ['node identity', (source: MutableSource) => (source.run.nodeId = 'replacement-node')],
    ['agent identity', (source: MutableSource) => (source.ownership.agentId = 'replacement-agent')],
  ])('rejects current %s drift before shipping', async (_label, mutate) => {
    const source = currentSource();
    mutate(source);
    const resolve = vi.fn().mockResolvedValue(source as unknown as ResolvedGitTarget);
    const revalidate = vi.fn();
    const service = new GitShippingService(
      { resolve } as unknown as GitTargetResolver,
      {
        status: vi.fn().mockResolvedValue(cleanStatus('main')),
      } as unknown as RepositoryService,
      {
        continuationState: vi.fn().mockResolvedValue({ operation: null }),
      } as unknown as ChangeService,
      { bind: vi.fn(), revalidate } as unknown as GitShippingReadinessAuthority,
    );

    await expect(service.assertCurrent(reviewedPlan())).rejects.toThrow(
      /managed agent worktree changed after review/iu,
    );
    expect(revalidate).not.toHaveBeenCalled();
  });
});

interface MutableSource {
  project: { id: string };
  run: { id: string; nodeId: string };
  ownership: {
    id: string;
    agentId: string;
    branch: string;
    baseRef: string;
    baseCommit: string;
  };
  state: { status: ReturnType<typeof cleanStatus>; branchOid: string };
  primaryRepositoryRoot: string;
  worktreeRepositoryPath: string;
}

function currentSource(): MutableSource {
  return {
    project: { id: PROJECT_ID },
    run: { id: RUN_ID, nodeId: 'reviewed-node' },
    ownership: {
      id: WORKTREE_ID,
      agentId: 'reviewed-agent',
      branch: 'agent/reviewed',
      baseRef: 'main',
      baseCommit: HEAD,
    },
    state: { status: cleanStatus('agent/reviewed'), branchOid: HEAD },
    primaryRepositoryRoot: '/primary',
    worktreeRepositoryPath: '/worktree',
  };
}

function reviewedPlan(): PendingGitShippingPlan {
  return {
    kind: 'ship-agent-commits',
    id: '84000000-0000-4000-8000-000000000004',
    ownerId: 1,
    target: {
      kind: 'agent-worktree',
      projectId: PROJECT_ID,
      runId: RUN_ID,
      nodeId: 'reviewed-node',
      worktreeId: WORKTREE_ID,
      agentId: 'reviewed-agent',
      baseRef: 'main',
      baseCommit: HEAD,
    },
    repositoryRoot: '/primary',
    sourceRepositoryRoot: '/worktree',
    expiresAtMs: Date.now() + 60_000,
    strategy: 'fast-forward-only',
    projectName: 'Project',
    sourceBranch: 'agent/reviewed',
    targetBranch: 'main',
    baseRef: 'main',
    baseCommit: HEAD,
    sourceHead: HEAD,
    targetHead: HEAD,
    commits: [HEAD],
    affectedPaths: ['README.md'],
    identity: {
      name: 'Reviewer',
      email: 'reviewer@example.invalid',
      nameSource: 'settings',
      emailSource: 'settings',
      ready: true,
    },
    readinessApprovalId: '84000000-0000-4000-8000-000000000005',
    readiness: {} as never,
  };
}

function cleanStatus(branch: string) {
  return {
    branch,
    detached: false,
    headOid: HEAD,
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
    dirty: false,
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
  };
}
