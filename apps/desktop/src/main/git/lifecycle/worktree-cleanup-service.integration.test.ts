import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RepositoryService, WorktreeService } from '@forgeboard/git-engine';
import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../shared/application/contracts.js';
import { GitTargetResolver } from '../git-target-resolver.js';
import { LocalStore, type StoredRunRecord } from '../../storage.js';
import { summarizePersistedRunHistory } from '../../runs/history/summaries.js';
import { WorktreeCleanupService } from './worktree-cleanup-service.js';

const PROJECT_ID = '82000000-0000-4000-8000-000000000001';
const RUN_ID = '82000000-0000-4000-8000-000000000002';
const NOW = '2026-07-16T16:00:00.000Z';
const roots: string[] = [];
const stores = new Set<LocalStore>();

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('WorktreeCleanupService with a real repository', () => {
  it('removes only a clean merged terminal-run worktree and its exact managed branch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-cleanup-service-'));
    roots.push(root);
    const repository = await createRepository(root);
    const managedRoot = path.join(root, 'managed-worktrees');
    await mkdir(managedRoot);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const ownership = (
      await worktrees.provision({
        repositoryPath: repository,
        managedRoot,
        agentId: 'codex',
        taskId: 'agent-node',
        baseRef: 'main',
        cleanupPolicy: 'manual',
      })
    ).ownership;
    await writeFile(
      path.join(ownership.worktreePath, 'delivered-agent-work.txt'),
      'delivered before cleanup\n',
      'utf8',
    );
    await runGit(ownership.worktreePath, ['add', '--', 'delivered-agent-work.txt']);
    await runGit(ownership.worktreePath, ['commit', '-m', 'Deliver agent work']);
    await runGit(repository, ['merge', '--ff-only', ownership.branch]);
    const store = new LocalStore(path.join(root, 'state', 'forgeboard.sqlite3'));
    stores.add(store);
    store.saveProject(project(repository));
    store.saveRun(runRecord(ownership));
    const targets = new GitTargetResolver(store, repositories, () => ({
      worktreeRoot: managedRoot,
    }));
    let nativeOptions: MessageBoxOptions | undefined;
    const showMessageBox = vi.fn((_window: BrowserWindow, options: MessageBoxOptions) => {
      nativeOptions = options;
      return Promise.resolve({ response: 1, checkboxChecked: false });
    });
    const admission = vi.fn();
    const service = new WorktreeCleanupService(
      { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
      store,
      targets,
      repositories,
      {
        worktrees,
        withCleanupAdmission: async <Output>(operation: () => Promise<Output>) => {
          admission();
          return await operation();
        },
      },
    );

    await expect(access(ownership.worktreePath)).resolves.toBeUndefined();
    await expect(repositories.branchExists(repository, ownership.branch)).resolves.toBe(true);
    const primaryHead = await runGit(repository, ['rev-parse', 'HEAD']);
    const plan = await service.prepare(91, { projectId: PROJECT_ID, runId: RUN_ID });
    if (plan.kind !== 'cleanup-worktree') {
      throw new Error('Expected an active worktree cleanup plan.');
    }

    expect(plan).toMatchObject({ clean: true, mergedIntoBase: true, deleteBranch: true });
    expect(JSON.stringify(plan)).not.toContain(repository);
    expect(JSON.stringify(plan)).not.toContain(managedRoot);

    const result = await service.confirm(
      {
        ownerId: 91,
        parent: { isDestroyed: () => false } as BrowserWindow,
        assertCurrent: vi.fn(),
      },
      plan.planId,
    );

    expect(result).toEqual({
      worktreeRemoved: true,
      branchDeleted: true,
      metadataRemoved: true,
    });
    expect(JSON.stringify(result)).not.toContain(repository);
    expect(admission).toHaveBeenCalledTimes(1);
    expect(nativeOptions).toMatchObject({ defaultId: 0, cancelId: 0 });
    expect(nativeOptions?.detail).toContain(ownership.worktreePath);
    expect(nativeOptions?.detail).toContain(ownership.baseCommit.slice(0, 12));
    expect(nativeOptions?.detail).toContain(primaryHead.slice(0, 12));
    await expect(access(ownership.worktreePath)).rejects.toThrow();
    await expect(repositories.branchExists(repository, ownership.branch)).resolves.toBe(false);
    await expect(worktrees.readOwnership(managedRoot, ownership.id)).rejects.toThrow();
    await expect(runGit(repository, ['rev-parse', 'HEAD'])).resolves.toBe(primaryHead);
    await expect(readFile(path.join(repository, 'delivered-agent-work.txt'), 'utf8')).resolves.toBe(
      'delivered before cleanup\n',
    );
    await expect(repositories.status(repository)).resolves.toMatchObject({
      branch: 'main',
      dirty: false,
      headOid: primaryHead,
    });
    expect(store.getRun(RUN_ID)).toMatchObject({
      worktreeState: 'cleaned',
      worktreeId: ownership.id,
      cwd: ownership.worktreePath,
      branch: ownership.branch,
      repositoryRoot: ownership.repositoryRoot,
      managedRoot: ownership.managedRoot,
      baseRef: ownership.baseRef,
      baseCommit: ownership.baseCommit,
    });
    expect(summarizePersistedRunHistory(store.listProjectRuns(PROJECT_ID))).toMatchObject([
      { id: RUN_ID, worktreeAvailable: false },
    ]);
    await expect(targets.resolve({ projectId: PROJECT_ID, runId: RUN_ID })).rejects.toMatchObject({
      code: 'WORKTREE_LIFECYCLE_INACTIVE',
    });
    expect(
      store
        .listAuditEvents(20)
        .filter((event) => event.category === 'git')
        .map((event) => `${event.action}:${event.outcome}`),
    ).toEqual(
      expect.arrayContaining(['cleanup-worktree-prepare:allowed', 'cleanup-worktree:allowed']),
    );

    await service.dispose();
  });

  it('reconciles a crash after exact engine cleanup without requesting reused consent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-cleanup-reconcile-'));
    roots.push(root);
    const repository = await createRepository(root);
    const managedRoot = path.join(root, 'managed-worktrees');
    await mkdir(managedRoot);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);
    const ownership = (
      await worktrees.provision({
        repositoryPath: repository,
        managedRoot,
        agentId: 'codex',
        taskId: 'agent-node',
        baseRef: 'main',
        cleanupPolicy: 'manual',
      })
    ).ownership;
    await writeFile(
      path.join(ownership.worktreePath, 'reconciled-work.txt'),
      'delivered\n',
      'utf8',
    );
    await runGit(ownership.worktreePath, ['add', '--', 'reconciled-work.txt']);
    await runGit(ownership.worktreePath, ['commit', '-m', 'Deliver reconciled work']);
    await runGit(repository, ['merge', '--ff-only', ownership.branch]);

    const store = new LocalStore(path.join(root, 'state', 'forgeboard.sqlite3'));
    stores.add(store);
    store.saveProject(project(repository));
    store.saveRun({ ...runRecord(ownership), worktreeState: 'cleanup-pending' });
    const impact = await worktrees.cleanupImpact(ownership);
    await worktrees.cleanup(ownership, {
      action: 'cleanup-worktree',
      approved: true,
      approvalId: randomUUID(),
      approvedAt: new Date().toISOString(),
      repositoryRoot: ownership.repositoryRoot,
      expectedHead: impact.expectedHead,
      worktreeId: ownership.id,
      worktreePath: ownership.worktreePath,
      branch: ownership.branch,
      expectedBranchOid: impact.branchOid,
      dirtyPaths: [],
      deleteBranch: true,
      allowDirty: false,
      allowUnmergedBranch: false,
    });

    const targets = new GitTargetResolver(store, repositories, () => ({
      worktreeRoot: managedRoot,
    }));
    const showMessageBox = vi.fn();
    const admission = vi.fn();
    const service = new WorktreeCleanupService(
      { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
      store,
      targets,
      repositories,
      {
        worktrees,
        withCleanupAdmission: async <Output>(operation: () => Promise<Output>) => {
          admission();
          return await operation();
        },
      },
    );

    await expect(service.prepare(92, { projectId: PROJECT_ID, runId: RUN_ID })).resolves.toEqual({
      kind: 'cleanup-reconciled',
      worktreeRemoved: true,
      branchDeleted: true,
      metadataRemoved: true,
    });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(store.getRun(RUN_ID)).toMatchObject({
      worktreeState: 'cleaned',
      worktreeId: ownership.id,
      cwd: ownership.worktreePath,
      branch: ownership.branch,
    });
    expect(
      store
        .listAuditEvents(20)
        .map((event) => `${event.category}:${event.action}:${event.outcome}`),
    ).toContain('git:cleanup-worktree-reconcile:allowed');

    await service.dispose();
  });
});

async function createRepository(root: string): Promise<string> {
  const repository = path.join(root, 'repository');
  await mkdir(repository);
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Forgeboard Cleanup Test']);
  await runGit(repository, ['config', 'user.email', 'cleanup@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# cleanup fixture\n', 'utf8');
  await runGit(repository, ['add', '--', 'README.md']);
  await runGit(repository, ['commit', '-m', 'Initial commit']);
  return await realpath(repository);
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_TERMINAL_PROMPT: '0',
          GIT_WORK_TREE: undefined,
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout.trim());
        else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`, { cause: error }));
      },
    );
  });
}

function project(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Cleanup repository',
    path: repository,
    openedAt: NOW,
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

function runRecord(
  ownership: Awaited<ReturnType<WorktreeService['provision']>>['ownership'],
): StoredRunRecord {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'codex',
    status: 'succeeded',
    cwd: ownership.worktreePath,
    branch: ownership.branch,
    worktreeId: ownership.id,
    worktreeState: 'active',
    repositoryRoot: ownership.repositoryRoot,
    managedRoot: ownership.managedRoot,
    baseRef: ownership.baseRef,
    baseCommit: ownership.baseCommit,
    startedAt: NOW,
    endedAt: '2026-07-16T16:01:00.000Z',
    exitCode: 0,
    createdAt: NOW,
    updatedAt: '2026-07-16T16:01:00.000Z',
  };
}
