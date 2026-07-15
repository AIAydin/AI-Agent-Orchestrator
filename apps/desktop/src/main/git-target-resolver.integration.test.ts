import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RepositoryService, WorktreeService, type WorktreeOwnership } from '@forgeboard/git-engine';
import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../shared/contracts.js';
import { GitTargetResolver, type GitTargetResolutionErrorCode } from './git-target-resolver.js';
import { LocalStore, type StoredRunRecord } from './storage.js';

const PROJECT_ID = '60000000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '60000000-0000-4000-8000-000000000002';
const RUN_ID = '60000000-0000-4000-8000-000000000003';
const NOW = '2026-07-15T12:00:00.000Z';

const stores = new Set<LocalStore>();
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

interface ResolverFixture {
  readonly root: string;
  readonly databasePath: string;
  readonly repository: string;
  readonly managedRoot: string;
  readonly repositories: RepositoryService;
  readonly ownership: WorktreeOwnership;
  readonly run: StoredRunRecord;
  store: LocalStore;
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
        if (error === null) resolve(stdout);
        else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`, { cause: error }));
      },
    );
  });
}

async function createRepository(root: string, name: string): Promise<string> {
  const repository = path.join(root, name);
  await mkdir(repository);
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Forgeboard Resolver Test']);
  await runGit(repository, ['config', 'user.email', 'resolver@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), `# ${name}\n`, 'utf8');
  await runGit(repository, ['add', '--', 'README.md']);
  await runGit(repository, ['commit', '-m', 'Initial commit']);
  return await realpath(repository);
}

function project(id: string, repository: string): Project {
  return {
    id,
    name: path.basename(repository),
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
  ownership: WorktreeOwnership,
  overrides: Partial<StoredRunRecord> = {},
): StoredRunRecord {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'test-agent',
    status: 'succeeded',
    cwd: ownership.worktreePath,
    branch: ownership.branch,
    worktreeId: ownership.id,
    repositoryRoot: ownership.repositoryRoot,
    managedRoot: ownership.managedRoot,
    baseRef: ownership.baseRef,
    baseCommit: ownership.baseCommit,
    startedAt: NOW,
    endedAt: '2026-07-15T12:01:00.000Z',
    exitCode: 0,
    createdAt: NOW,
    updatedAt: '2026-07-15T12:01:00.000Z',
    ...overrides,
  };
}

function openStore(databasePath: string): LocalStore {
  const store = new LocalStore(databasePath);
  stores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  stores.delete(store);
}

async function createFixture(
  runOverrides: Partial<StoredRunRecord> = {},
): Promise<ResolverFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-target-resolver-'));
  temporaryRoots.push(root);
  const repository = await createRepository(root, 'repository');
  const managedRoot = path.join(root, 'managed-worktrees');
  await mkdir(managedRoot);
  const repositories = new RepositoryService();
  const ownership = (
    await new WorktreeService(repositories).provision({
      repositoryPath: repository,
      managedRoot,
      agentId: 'test-agent',
      taskId: 'agent-node',
    })
  ).ownership;
  const databasePath = path.join(root, 'state', 'forgeboard.sqlite3');
  const store = openStore(databasePath);
  store.saveProject(project(PROJECT_ID, repository));
  const run = runRecord(ownership, runOverrides);
  store.saveRun(run);
  return { root, databasePath, repository, managedRoot, repositories, ownership, run, store };
}

function resolver(
  fixture: ResolverFixture,
  configuredRoot = fixture.managedRoot,
): GitTargetResolver {
  return new GitTargetResolver(fixture.store, fixture.repositories, () => ({
    worktreeRoot: configuredRoot,
  }));
}

async function expectResolutionCode(
  operation: Promise<unknown>,
  code: GitTargetResolutionErrorCode,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

describe('GitTargetResolver', () => {
  it('recovers the persisted owned worktree after restart even when the configured root changes', async () => {
    const fixture = await createFixture();
    const replacementRoot = path.join(fixture.root, 'new-managed-worktrees');
    await mkdir(replacementRoot);
    closeStore(fixture.store);
    fixture.store = openStore(fixture.databasePath);

    const target = await resolver(fixture, replacementRoot).resolve({
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });

    expect(target.primaryRepositoryRoot).toBe(fixture.repository);
    expect(target.worktreeRepositoryPath).toBe(fixture.ownership.worktreePath);
    expect(target.ownership).toEqual(fixture.ownership);
    expect(target.run).toEqual(fixture.run);
    expect(target.state).toMatchObject({ missing: false, branchExists: true });
    expect(target.usesConfiguredManagedRoot).toBe(false);
    expect(target.configuredManagedRoot).toBe(replacementRoot);
  });

  it('rejects a run requested through another project identity', async () => {
    const fixture = await createFixture();
    const otherRepository = await createRepository(fixture.root, 'other-repository');
    fixture.store.saveProject(project(OTHER_PROJECT_ID, otherRepository));

    await expectResolutionCode(
      resolver(fixture).resolve({ projectId: OTHER_PROJECT_ID, runId: RUN_ID }),
      'RUN_PROJECT_MISMATCH',
    );
  });

  it('rejects legacy worktree runs that lack a durable ownership binding', async () => {
    const fixture = await createFixture({
      repositoryRoot: null,
      managedRoot: null,
      baseRef: null,
      baseCommit: null,
    });

    await expectResolutionCode(
      resolver(fixture).resolve({ projectId: PROJECT_ID, runId: RUN_ID }),
      'LEGACY_RUN_BINDING',
    );
  });

  it('rejects a missing worktree even when its ownership metadata and branch remain', async () => {
    const fixture = await createFixture();
    await rm(fixture.ownership.worktreePath, { recursive: true, force: true });

    await expectResolutionCode(
      resolver(fixture).resolve({ projectId: PROJECT_ID, runId: RUN_ID }),
      'WORKTREE_MISSING',
    );
  });

  it('rejects run metadata that does not match authoritative ownership', async () => {
    const fixture = await createFixture({ baseRef: 'main' });

    await expectResolutionCode(
      resolver(fixture).resolve({ projectId: PROJECT_ID, runId: RUN_ID }),
      'OWNERSHIP_MISMATCH',
    );
  });

  it('rejects a renderer-opaque run whose persisted base commit no longer matches ownership', async () => {
    const fixture = await createFixture({ baseCommit: 'f'.repeat(40) });

    await expectResolutionCode(
      resolver(fixture).resolve({ projectId: PROJECT_ID, runId: RUN_ID }),
      'OWNERSHIP_MISMATCH',
    );
  });

  it('rejects a run that has not reached a persisted terminal state', async () => {
    const fixture = await createFixture({ status: 'running', endedAt: null, exitCode: null });

    await expectResolutionCode(
      resolver(fixture).resolve({ projectId: PROJECT_ID, runId: RUN_ID }),
      'RUN_NOT_TERMINAL',
    );
  });
});
