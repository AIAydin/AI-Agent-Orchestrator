import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RepositoryService, WorktreeService, type WorktreeOwnership } from '@forgeboard/git-engine';
import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../../shared/application/contracts.js';
import type { StoredRunRecord } from '../../storage.js';
import type { ResolvedGitTarget } from '../git-target-resolver.js';
import { GitAgentComparisonService } from './service.js';

const PROJECT_ID = '97300000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '97300000-0000-4000-8000-000000000002';
const LEFT_RUN_ID = '97300000-0000-4000-8000-000000000003';
const RIGHT_RUN_ID = '97300000-0000-4000-8000-000000000004';
const NOW = '2026-07-18T12:00:00.000Z';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('GitAgentComparisonService with real owned worktrees', () => {
  it('compares two immutable owned heads without returning machine paths', async () => {
    const fixture = await createFixture();
    const service = new GitAgentComparisonService(
      resolver(
        new Map([
          [LEFT_RUN_ID, fixture.left],
          [RIGHT_RUN_ID, fixture.right],
        ]),
      ),
      fixture.repositories,
    );

    const view = await service.compare(input());

    expect(view.left.headCommit).toBe(fixture.left.state.branchOid);
    expect(view.right.headCommit).toBe(fixture.right.state.branchOid);
    expect(view.comparison).toMatchObject({ ahead: 1, behind: 1, commitCount: 2 });
    expect(view.comparison.diff.files.map((file) => file.newPath ?? file.oldPath).sort()).toEqual([
      'left.txt',
      'right.txt',
    ]);
    expect(JSON.stringify(view)).not.toContain(fixture.root);
  });

  it('rejects resolver output that crosses project ownership', async () => {
    const fixture = await createFixture();
    const wrongProject = {
      ...fixture.right,
      project: { ...fixture.right.project, id: OTHER_PROJECT_ID },
    };
    const service = new GitAgentComparisonService(
      resolver(
        new Map([
          [LEFT_RUN_ID, fixture.left],
          [RIGHT_RUN_ID, wrongProject],
        ]),
      ),
      fixture.repositories,
    );

    await expect(service.compare(input())).rejects.toThrow(/same project/iu);
  });

  it('rejects a worktree binding that changes after the immutable comparison', async () => {
    const fixture = await createFixture();
    let leftResolutions = 0;
    const service = new GitAgentComparisonService(
      {
        resolve: (target) => {
          const resolved = target.runId === LEFT_RUN_ID ? fixture.left : fixture.right;
          if (target.runId !== LEFT_RUN_ID) return Promise.resolve(resolved);
          leftResolutions += 1;
          if (leftResolutions === 1) return Promise.resolve(resolved);
          const changedHead = 'f'.repeat(40);
          return Promise.resolve({
            ...resolved,
            state: {
              ...resolved.state,
              branchOid: changedHead,
              status: { ...resolved.state.status!, headOid: changedHead },
            },
          });
        },
      },
      fixture.repositories,
    );

    await expect(service.compare(input())).rejects.toThrow(/changed during the comparison/iu);
  });
});

interface Fixture {
  readonly root: string;
  readonly repositories: RepositoryService;
  readonly left: ResolvedGitTarget;
  readonly right: ResolvedGitTarget;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-agent-comparison-'));
  temporaryRoots.push(root);
  const repository = path.join(root, 'repository');
  const managedRoot = path.join(root, 'managed');
  await mkdir(repository);
  await mkdir(managedRoot);
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Forgeboard Comparison Test']);
  await git(repository, ['config', 'user.email', 'comparison@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# comparison\n');
  await git(repository, ['add', '--', 'README.md']);
  await git(repository, ['commit', '-m', 'Initial commit']);
  const canonicalRepository = await realpath(repository);
  const repositories = new RepositoryService();
  const worktrees = new WorktreeService(repositories);
  const leftOwnership = (
    await worktrees.provision({
      repositoryPath: canonicalRepository,
      managedRoot,
      agentId: 'left-agent',
      taskId: 'left-node',
    })
  ).ownership;
  const rightOwnership = (
    await worktrees.provision({
      repositoryPath: canonicalRepository,
      managedRoot,
      agentId: 'right-agent',
      taskId: 'right-node',
    })
  ).ownership;
  await commitFile(leftOwnership.worktreePath, 'left.txt', 'left\n', 'Left implementation');
  await commitFile(rightOwnership.worktreePath, 'right.txt', 'right\n', 'Right implementation');
  const project = projectView(canonicalRepository);
  const commonDirectory = await repositories.commonDirectory(canonicalRepository);
  return {
    root,
    repositories,
    left: await resolvedTarget(
      repositories,
      project,
      runRecord(LEFT_RUN_ID, leftOwnership),
      leftOwnership,
      commonDirectory,
      managedRoot,
    ),
    right: await resolvedTarget(
      repositories,
      project,
      runRecord(RIGHT_RUN_ID, rightOwnership),
      rightOwnership,
      commonDirectory,
      managedRoot,
    ),
  };
}

async function resolvedTarget(
  repositories: RepositoryService,
  project: Project,
  run: StoredRunRecord,
  ownership: WorktreeOwnership,
  commonDirectory: string,
  managedRoot: string,
): Promise<ResolvedGitTarget> {
  const state = await new WorktreeService(repositories).inspect(ownership);
  return {
    project,
    run,
    ownership: state.ownership,
    state,
    primaryRepositoryRoot: project.path,
    worktreeRepositoryPath: ownership.worktreePath,
    commonDirectory,
    configuredManagedRoot: managedRoot,
    usesConfiguredManagedRoot: true,
  };
}

function resolver(targets: ReadonlyMap<string, ResolvedGitTarget>) {
  return {
    resolve: (input: { projectId: string; runId: string }) => {
      const target = targets.get(input.runId);
      if (target === undefined) return Promise.reject(new Error('Run not found.'));
      return Promise.resolve(target);
    },
  };
}

function input() {
  return {
    left: { kind: 'agent-worktree' as const, projectId: PROJECT_ID, runId: LEFT_RUN_ID },
    right: { kind: 'agent-worktree' as const, projectId: PROJECT_ID, runId: RIGHT_RUN_ID },
  };
}

function projectView(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Comparison project',
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

function runRecord(id: string, ownership: WorktreeOwnership): StoredRunRecord {
  return {
    id,
    projectId: PROJECT_ID,
    nodeId: ownership.taskId ?? 'agent-node',
    adapterId: 'test-agent',
    status: 'succeeded',
    cwd: ownership.worktreePath,
    branch: ownership.branch,
    worktreeId: ownership.id,
    worktreeAuthority: 'owned',
    worktreeState: 'active',
    repositoryRoot: ownership.repositoryRoot,
    managedRoot: ownership.managedRoot,
    baseRef: ownership.baseRef,
    baseCommit: ownership.baseCommit,
    startedAt: NOW,
    endedAt: '2026-07-18T12:01:00.000Z',
    exitCode: 0,
    createdAt: NOW,
    updatedAt: '2026-07-18T12:01:00.000Z',
  };
}

async function commitFile(
  worktree: string,
  filename: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(path.join(worktree, filename), content);
  await git(worktree, ['add', '--', filename]);
  await git(worktree, ['commit', '-m', message]);
}

function git(cwd: string, args: readonly string[]): Promise<string> {
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
