import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GitExecutor } from './executor.js';
import { RepositoryService } from './repository.js';
import { WorktreeService } from './worktrees.js';
import {
  createTemporaryRepository,
  runGit,
  type TemporaryRepository,
} from './__tests__/helpers.js';

describe('RepositoryService and GitExecutor', () => {
  const fixtures: TemporaryRepository[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it('detects health, scripts, frameworks, remotes, and sensitive paths without reading secrets', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    await writeFile(
      path.join(fixture.repository, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@11.13.0',
        scripts: { dev: 'vite --host', test: 'vitest run' },
        dependencies: { react: '19.1.0', vite: '6.3.5' },
      }),
      'utf8',
    );
    await writeFile(path.join(fixture.repository, '.env.local'), 'SECRET=do-not-read\n', 'utf8');
    await runGit(fixture.repository, ['add', '--', 'package.json', '.env.local']);
    await runGit(fixture.repository, ['commit', '-m', 'Add package metadata']);
    await runGit(fixture.repository, [
      'remote',
      'add',
      'origin',
      'https://token:secret@example.test/org/repo.git',
    ]);

    const health = await new RepositoryService().health(fixture.repository);

    expect(health.packageManager).toBe('pnpm');
    expect(health.frameworks).toEqual(['React', 'Vite']);
    expect(health.scripts[0]?.command).toEqual({ executable: 'pnpm', args: ['run', 'dev'] });
    expect(health.sensitivePaths).toContainEqual({
      path: '.env.local',
      reason: 'Environment file',
      tracked: true,
    });
    expect(health.remotes[0]).toMatchObject({ hasRedactedCredentials: true });
    expect(JSON.stringify(health)).not.toContain('secret');
  });

  it('passes metacharacters as literal arguments and never invokes a shell', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const sentinel = path.join(fixture.root, `must-not-exist-${randomUUID()}`);
    await writeFile(path.join(fixture.repository, 'literal.txt'), 'literal\n', 'utf8');
    await runGit(fixture.repository, ['add', '--', 'literal.txt']);
    const message = `literal $(touch ${sentinel}) ; touch ${sentinel}`;

    await new GitExecutor().run([
      '-C',
      fixture.repository,
      'commit',
      '--no-gpg-sign',
      '-m',
      message,
    ]);

    const subject = await runGit(fixture.repository, ['log', '-1', '--pretty=%s']);
    expect(subject.trim()).toBe(message);
    await expect(access(sentinel)).rejects.toThrow();
  });

  it('keeps executable search-path wiring behind the trusted runtime boundary', async () => {
    expect(
      () => new GitExecutor({ environment: { GIT_EXEC_PATH: '/untrusted/git-core' } }),
    ).toThrow(/unsafe git environment override/iu);
    expect(
      () =>
        new GitExecutor({
          trustedRuntimeEnvironment: { FORGEBOARD_UNTRUSTED: '/tmp/value' },
        }),
    ).toThrow(/unsupported bundled git runtime environment name/iu);

    const result = await new GitExecutor({
      trustedRuntimeEnvironment: { PATH: process.env.PATH },
    }).run(['--version']);
    expect(result.stdout).toMatch(/^git version /u);
  });

  it('rejects non-repositories with a structured error', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const service = new RepositoryService();

    await expect(service.resolveRepositoryRoot(fixture.managedRoot)).rejects.toMatchObject({
      code: 'NOT_A_REPOSITORY',
    });
  });

  it('rejects a managed root inside the checkout before creating it', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const unsafeRoot = path.join(fixture.repository, 'nested-managed-root');

    await expect(
      new WorktreeService().provision({
        repositoryPath: fixture.repository,
        managedRoot: unsafeRoot,
        agentId: 'unsafe-root-test',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MANAGED_ROOT' });
    await expect(access(unsafeRoot)).rejects.toThrow();
  });
});
