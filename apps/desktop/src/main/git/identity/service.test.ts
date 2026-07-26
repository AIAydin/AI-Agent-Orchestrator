import type { RepositoryService } from '@forgeboard/git-engine';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../shared/application/contracts.js';
import { GitIdentityService } from './service.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const project = {
  id: projectId,
  name: 'Fixture',
  path: '/canonical/repository',
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
} satisfies Project;

describe('GitIdentityService', () => {
  it('checks an exact Settings override with literal Git configuration arguments', async () => {
    const fixture = createFixture();

    const result = await fixture.service.check({
      source: 'settings',
      name: 'Artemis Author',
      email: 'author@example.invalid',
    });

    expect(fixture.run).toHaveBeenCalledWith(
      [
        '-c',
        'user.name=Artemis Author',
        '-c',
        'user.email=author@example.invalid',
        'var',
        'GIT_AUTHOR_IDENT',
      ],
      { allowNonZeroExit: true, maxOutputBytes: 4_096 },
    );
    expect(result).toMatchObject({
      identity: {
        name: 'Artemis Author',
        email: 'author@example.invalid',
        nameSource: 'settings',
        emailSource: 'settings',
        ready: true,
      },
      checkedAt: '2026-07-18T16:00:00.000Z',
    });
    expect(result).not.toHaveProperty('repositoryPath');
  });

  it('resolves repository fallback only through the stored canonical primary project', async () => {
    const fixture = createFixture();

    const result = await fixture.service.check({ source: 'git-config', projectId });

    expect(fixture.resolveRepositoryRoot).toHaveBeenCalledWith(project.path);
    expect(fixture.run).toHaveBeenCalledWith(['-C', project.path, 'config', '--get', 'user.name'], {
      allowNonZeroExit: true,
      maxOutputBytes: 4_096,
    });
    expect(fixture.run).toHaveBeenCalledWith(
      ['-C', project.path, 'config', '--get', 'user.email'],
      { allowNonZeroExit: true, maxOutputBytes: 4_096 },
    );
    expect(result.identity).toEqual({
      name: 'Repository Author',
      email: 'repository@example.invalid',
      nameSource: 'git-config',
      emailSource: 'git-config',
      ready: true,
    });
    expect(JSON.stringify(result)).not.toContain(project.path);
  });

  it('reports incomplete repository configuration without inventing an identity', async () => {
    const fixture = createFixture({ email: '' });

    await expect(fixture.service.check({ source: 'git-config', projectId })).resolves.toMatchObject(
      {
        identity: {
          name: 'Repository Author',
          email: '',
          nameSource: 'git-config',
          emailSource: 'missing',
          ready: false,
        },
      },
    );
    expect(fixture.run.mock.calls).toHaveLength(2);
  });

  it('rejects Git failures, unknown projects, missing projects, and canonical root drift', async () => {
    const rejected = createFixture({ identityExitCode: 1 });
    await expect(
      rejected.service.check({
        source: 'settings',
        name: 'Artemis Author',
        email: 'author@example.invalid',
      }),
    ).rejects.toThrow('Git rejected');

    const unknown = createFixture({ storedProject: undefined });
    await expect(unknown.service.check({ source: 'git-config', projectId })).rejects.toThrow(
      'no longer exists',
    );

    const missing = createFixture({ storedProject: { ...project, missing: true } });
    await expect(missing.service.check({ source: 'git-config', projectId })).rejects.toThrow(
      'Locate the missing project',
    );

    const drifted = createFixture({ resolvedRoot: '/different/repository' });
    await expect(drifted.service.check({ source: 'git-config', projectId })).rejects.toThrow(
      'Reopen the project',
    );
  });
});

function createFixture(
  options: {
    readonly email?: string;
    readonly identityExitCode?: number;
    readonly effectiveName?: string;
    readonly storedProject?: Project | undefined;
    readonly resolvedRoot?: string;
  } = {},
) {
  const storedProject = Object.hasOwn(options, 'storedProject') ? options.storedProject : project;
  const resolveRepositoryRoot = vi.fn(() => Promise.resolve(options.resolvedRoot ?? project.path));
  const run = vi.fn((arguments_: readonly string[]) => {
    const key = arguments_.at(-1);
    const configuredName = arguments_.find((argument) => argument.startsWith('user.name='));
    const configuredEmail = arguments_.find((argument) => argument.startsWith('user.email='));
    const stdout =
      key === 'user.name'
        ? `${configuredName?.slice('user.name='.length) ?? 'Repository Author'}\n`
        : key === 'user.email'
          ? `${configuredEmail?.slice('user.email='.length) ?? options.email ?? 'repository@example.invalid'}\n`
          : `${options.effectiveName ?? configuredName?.slice('user.name='.length) ?? 'Repository Author'} <${configuredEmail?.slice('user.email='.length) ?? 'repository@example.invalid'}> 0 +0000\n`;
    return Promise.resolve({
      executable: '/bundled/git',
      args: arguments_,
      cwd: project.path,
      stdout,
      stderr: '',
      exitCode: key === 'GIT_AUTHOR_IDENT' ? (options.identityExitCode ?? 0) : 0,
    });
  });
  const repositories = {
    resolveRepositoryRoot,
    git: { run },
  } as unknown as RepositoryService;
  const service = new GitIdentityService(
    { getProject: () => storedProject },
    repositories,
    () => new Date('2026-07-18T16:00:00.000Z'),
  );
  return { service, resolveRepositoryRoot, run };
}
