import type { RepositoryService, WorktreeService } from '@forgeboard/git-engine';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../shared/application/contracts.js';
import type { StoredRunRecord } from '../../storage.js';
import { WorktreeCleanupRecoveryResolver } from './worktree-cleanup-recovery.js';

const PROJECT_ID = '82000000-0000-4000-8000-000000000001';
const RUN_ID = '82000000-0000-4000-8000-000000000002';
const WORKTREE_ID = '82000000-0000-4000-8000-000000000003';
const REPOSITORY_ROOT = '/private/authority/repository';

describe('WorktreeCleanupRecoveryResolver', () => {
  it('derives exact engine recovery authority only from a terminal pending run binding', async () => {
    const inspection = {
      kind: 'unsafe' as const,
      reason: 'inspection-failed' as const,
    };
    const inspectCleanupRecovery = vi.fn().mockResolvedValue(inspection);
    const resolveRepositoryRoot = vi.fn().mockResolvedValue(REPOSITORY_ROOT);
    const resolver = createResolver({ inspectCleanupRecovery, resolveRepositoryRoot });

    await expect(resolver.resolvePending(target())).resolves.toEqual({
      run: runRecord(),
      binding: exactBinding(),
      inspection,
    });
    expect(resolveRepositoryRoot).toHaveBeenCalledWith(REPOSITORY_ROOT);
    expect(inspectCleanupRecovery).toHaveBeenCalledWith(exactBinding());
  });

  it.each(['active', 'cleaned'] as const)(
    'does not grant recovery authority to a %s lifecycle',
    async (worktreeState) => {
      const inspectCleanupRecovery = vi.fn();
      const resolver = createResolver({
        run: runRecord({ worktreeState }),
        inspectCleanupRecovery,
      });

      await expect(resolver.resolvePending(target())).rejects.toMatchObject({
        code: worktreeState === 'cleaned' ? 'RECOVERY_ALREADY_CLEANED' : 'RECOVERY_STATE_CHANGED',
      });
      expect(inspectCleanupRecovery).not.toHaveBeenCalled();
    },
  );

  it('refuses pending legacy metadata before invoking the engine recovery inspector', async () => {
    const inspectCleanupRecovery = vi.fn();
    const resolver = createResolver({
      run: runRecord({ baseCommit: null }),
      inspectCleanupRecovery,
    });

    await expect(resolver.resolvePending(target())).rejects.toMatchObject({
      code: 'RECOVERY_LEGACY_RUN_BINDING',
    });
    expect(inspectCleanupRecovery).not.toHaveBeenCalled();
  });
});

function createResolver(options: {
  readonly run?: StoredRunRecord;
  readonly inspectCleanupRecovery?: ReturnType<typeof vi.fn>;
  readonly resolveRepositoryRoot?: ReturnType<typeof vi.fn>;
}): WorktreeCleanupRecoveryResolver {
  const project = projectRecord();
  return new WorktreeCleanupRecoveryResolver(
    {
      getProject: (id: string) => (id === PROJECT_ID ? project : undefined),
      getRun: (id: string) => (id === RUN_ID ? (options.run ?? runRecord()) : undefined),
    },
    {
      resolveRepositoryRoot:
        options.resolveRepositoryRoot ?? vi.fn().mockResolvedValue(REPOSITORY_ROOT),
    } as unknown as RepositoryService,
    {
      inspectCleanupRecovery: options.inspectCleanupRecovery ?? vi.fn(),
    } as unknown as WorktreeService,
  );
}

function target() {
  return { projectId: PROJECT_ID, runId: RUN_ID };
}

function projectRecord(): Project {
  return {
    id: PROJECT_ID,
    name: 'Recovery repository',
    path: REPOSITORY_ROOT,
    openedAt: '2026-07-16T15:00:00.000Z',
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function runRecord(overrides: Partial<StoredRunRecord> = {}): StoredRunRecord {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'test-agent',
    status: 'succeeded',
    cwd: '/private/authority/managed/agent-worktree',
    branch: 'forgeboard/test-agent/agent-node',
    worktreeId: WORKTREE_ID,
    worktreeState: 'cleanup-pending',
    repositoryRoot: REPOSITORY_ROOT,
    managedRoot: '/private/authority/managed',
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    startedAt: '2026-07-16T14:00:00.000Z',
    endedAt: '2026-07-16T15:00:00.000Z',
    exitCode: 0,
    createdAt: '2026-07-16T14:00:00.000Z',
    updatedAt: '2026-07-16T15:00:00.000Z',
    ...overrides,
  };
}

function exactBinding() {
  return {
    worktreeId: WORKTREE_ID,
    repositoryRoot: REPOSITORY_ROOT,
    managedRoot: '/private/authority/managed',
    worktreePath: '/private/authority/managed/agent-worktree',
    branch: 'forgeboard/test-agent/agent-node',
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    agentId: 'test-agent',
    taskId: 'agent-node',
  };
}
