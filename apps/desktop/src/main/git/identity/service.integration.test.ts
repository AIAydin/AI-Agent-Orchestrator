import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { RepositoryService } from '@forgeboard/git-engine';
import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../../shared/application/contracts.js';
import { GitIdentityService } from './service.js';

const execute = promisify(execFile);
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('GitIdentityService with real Git', () => {
  it('checks Settings and repository identities without mutating repository configuration', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-git-identity-')));
    fixtureRoots.push(root);
    await runGit(root, ['init', '--initial-branch=main']);
    await runGit(root, ['config', 'user.name', 'Repository Author']);
    await runGit(root, ['config', 'user.email', 'repository@example.invalid']);
    const project = createProject(root);
    const service = new GitIdentityService(
      { getProject: (projectId) => (projectId === project.id ? project : undefined) },
      new RepositoryService(),
    );
    const configurationPath = join(root, '.git', 'config');
    const before = await readFile(configurationPath, 'utf8');

    await expect(
      service.check({
        source: 'settings',
        name: 'Unsaved Settings Author',
        email: 'unsaved@example.invalid',
      }),
    ).resolves.toMatchObject({
      identity: {
        name: 'Unsaved Settings Author',
        email: 'unsaved@example.invalid',
        nameSource: 'settings',
        emailSource: 'settings',
        ready: true,
      },
    });
    await expect(
      service.check({ source: 'git-config', projectId: project.id }),
    ).resolves.toMatchObject({
      identity: {
        name: 'Repository Author',
        email: 'repository@example.invalid',
        nameSource: 'git-config',
        emailSource: 'git-config',
        ready: true,
      },
    });
    await expect(
      service.check({
        source: 'settings',
        name: 'Rewritten <Author>',
        email: 'rewritten@example.invalid',
      }),
    ).rejects.toThrow(/Git rejected/iu);
    expect(await readFile(configurationPath, 'utf8')).toBe(before);
  });
});

function createProject(path: string): Project {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Fixture',
    path,
    openedAt: '2026-07-18T16:00:00.000Z',
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

async function runGit(cwd: string, arguments_: readonly string[]): Promise<void> {
  await execute('git', arguments_, { cwd });
}
