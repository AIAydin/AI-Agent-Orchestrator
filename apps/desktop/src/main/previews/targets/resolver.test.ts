import { describe, expect, it, vi } from 'vitest';

import type { RepositoryService } from '@forgeboard/git-engine';

import type { Project } from '../../../shared/application/contracts.js';
import type { StoredRunRecord } from '../../storage.js';
import {
  PreviewTargetResolver,
  type PreviewAgentRunTargetResolver,
  type PreviewTargetResolverStore,
} from './resolver.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-07-17T12:00:00.000Z';

const project: Project = {
  id: PROJECT_ID,
  name: 'Artemis',
  path: '/canonical/project',
  openedAt: NOW,
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

const run: StoredRunRecord = {
  id: RUN_ID,
  projectId: PROJECT_ID,
  nodeId: 'agent-node',
  adapterId: 'codex',
  status: 'succeeded',
  cwd: '/managed/private/worktree',
  branch: 'forgeboard/agent-node',
  worktreeId: '33333333-3333-4333-8333-333333333333',
  worktreeState: 'active',
  repositoryRoot: project.path,
  managedRoot: '/managed/private',
  baseRef: 'main',
  baseCommit: 'a'.repeat(40),
  startedAt: NOW,
  endedAt: NOW,
  exitCode: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

function fixture(options: { canonicalRoot?: string; gitError?: Error } = {}) {
  const store: PreviewTargetResolverStore = {
    getProject: (id) => (id === PROJECT_ID ? project : undefined),
    getRun: (id) => (id === RUN_ID ? run : undefined),
    listProjectRuns: () => [run],
  };
  const repositories = {
    resolveRepositoryRoot: vi.fn(() => Promise.resolve(options.canonicalRoot ?? project.path)),
  } as unknown as RepositoryService;
  const resolveAgentRun = vi.fn(({ projectId, runId }: { projectId: string; runId: string }) => {
    if (options.gitError) return Promise.reject(options.gitError);
    if (projectId !== PROJECT_ID || runId !== RUN_ID) {
      return Promise.reject(new Error('Unknown target.'));
    }
    return Promise.resolve({ project, run, worktreeRepositoryPath: run.cwd });
  });
  const gitTargets: PreviewAgentRunTargetResolver = {
    resolveActiveWorktree: resolveAgentRun,
  };
  return {
    resolveAgentRun,
    resolver: new PreviewTargetResolver(
      store,
      repositories,
      () => ({ worktreeRoot: '/configured/worktrees' }),
      gitTargets,
    ),
  };
}

describe('PreviewTargetResolver', () => {
  it('resolves only a canonical primary repository root', async () => {
    const { resolver } = fixture();
    await expect(resolver.resolve(PROJECT_ID, { kind: 'primary' })).resolves.toEqual({
      project,
      target: { kind: 'primary' },
      root: project.path,
      run: null,
    });

    await expect(
      fixture({ canonicalRoot: '/canonical' }).resolver.resolve(PROJECT_ID, { kind: 'primary' }),
    ).rejects.toThrow('canonical Git repository root');
  });

  it('delegates opaque agent-run ownership and returns the root only to main-process callers', async () => {
    const { resolver, resolveAgentRun } = fixture();
    await expect(
      resolver.resolve(PROJECT_ID, { kind: 'agent-run', runId: RUN_ID }),
    ).resolves.toMatchObject({
      target: { kind: 'agent-run', runId: RUN_ID },
      root: run.cwd,
      run: { id: RUN_ID },
    });
    expect(resolveAgentRun).toHaveBeenCalledWith({ projectId: PROJECT_ID, runId: RUN_ID });
  });

  it('lists path-free target views and keeps unavailable worktrees selectable as explanations', async () => {
    const { resolver } = fixture({ gitError: new Error('The owned worktree is missing.') });
    const views = await resolver.list(PROJECT_ID);

    expect(views).toEqual([
      {
        target: { kind: 'primary' },
        label: 'Artemis',
        badge: 'Primary checkout',
        available: true,
      },
      {
        target: { kind: 'agent-run', runId: RUN_ID },
        label: 'codex · agent-node',
        badge: 'Agent worktree',
        available: false,
        unavailableReason: 'The owned worktree is missing.',
      },
    ]);
    expect(JSON.stringify(views)).not.toContain('/canonical/project');
    expect(JSON.stringify(views)).not.toContain('/managed/private/worktree');
  });

  it('rejects path-bearing target identities before delegating', async () => {
    const { resolver, resolveAgentRun } = fixture();
    await expect(
      resolver.resolve(PROJECT_ID, {
        kind: 'agent-run',
        runId: RUN_ID,
        worktreePath: '/renderer/chosen',
      } as never),
    ).rejects.toThrow();
    expect(resolveAgentRun).not.toHaveBeenCalled();
  });
});
