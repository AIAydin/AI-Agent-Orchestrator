import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GitExecutor } from './executor.js';
import { RepositoryService } from './service.js';
import { WorktreeService } from './worktrees.js';
import { createTemporaryRepository, runGit, type TemporaryRepository } from '../testing/helpers.js';

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

  it('allows only the bounded effective-author Git var query', async () => {
    const executor = new GitExecutor();
    const result = await executor.run([
      '-c',
      'user.name=Forgeboard Author',
      '-c',
      'user.email=author@example.invalid',
      'var',
      'GIT_AUTHOR_IDENT',
    ]);

    expect(result.stdout).toMatch(/^Forgeboard Author <author@example\.invalid> /u);
    await expect(executor.run(['var', '-l'])).rejects.toMatchObject({
      code: 'EXTERNAL_DRIVER_BLOCKED',
    });
  });

  it('keeps executable search-path wiring behind the trusted runtime boundary', async () => {
    expect(
      () => new GitExecutor({ environment: { GIT_EXEC_PATH: '/untrusted/git-core' } }),
    ).toThrow(/unsafe git environment override/iu);
    expect(
      () => new GitExecutor({ environment: { GIT_AUTHOR_NAME: 'Unapproved identity' } }),
    ).toThrow(/unsafe git environment override/iu);
    expect(() => new GitExecutor({ environment: { EMAIL: 'ambient@example.invalid' } })).toThrow(
      /unsafe git environment override/iu,
    );
    expect(
      () => new GitExecutor({ environment: { GIT_TRACE_CURL: '/tmp/unreviewed-trace' } }),
    ).toThrow(/unsafe git environment override/iu);
    expect(
      () => new GitExecutor({ environment: { GIT_SSL_CERT: '/tmp/unreviewed-client-cert' } }),
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

  it('reports an early stdin close as a controlled Git command failure', async () => {
    const executor = new GitExecutor({ executable: process.execPath });

    await expect(
      executor.run(['--version'], { input: 'x'.repeat(8 * 1_024 * 1_024) }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });

  it('does not launch an already-aborted Git command', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const executable = path.join(fixture.root, 'must-not-launch');
    const marker = path.join(fixture.root, 'launched');
    await writeFile(executable, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      new GitExecutor({ executable }).run(['--version'], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(access(marker)).rejects.toThrow();
  });

  it('waits for an aborted Git child to be force-terminated without leaving it running', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const executable = path.join(fixture.root, 'ignore-term-git');
    const pidFile = path.join(fixture.root, 'ignore-term-git.pid');
    await writeFile(
      executable,
      `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1_000);\n`,
      { mode: 0o755 },
    );
    const controller = new AbortController();
    const running = new GitExecutor({ executable }).run(['--version'], {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    await waitForFile(pidFile);
    const childPid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(Number.isSafeInteger(childPid)).toBe(true);
    const abortedAt = Date.now();
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(750);
    expect(() => process.kill(childPid, 0)).toThrow();
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

  it.each([
    ['cat-file', '--filters', 'HEAD:README.md'],
    ['cat-file', '--filters=HEAD:README.md'],
    ['cat-file', '--textconv', 'HEAD:README.md'],
    ['cat-file', '--textconv=HEAD:README.md'],
    ['grep', '--textconv', 'fixture'],
    ['grep', '--open-files-in-pager=less', 'fixture'],
    ['show', 'HEAD'],
    ['show', '--ext-diff', 'HEAD'],
    ['log', '-1'],
    ['diff-files'],
    ['diff-index', 'HEAD'],
    ['diff-tree', 'HEAD'],
    ['checkout-index', '--all'],
    ['read-tree', '-u', 'HEAD'],
    ['update-index', '--refresh'],
    ['restore', '--staged', '--worktree', 'README.md'],
    ['hash-object', 'README.md'],
    ['merge', '--abort'],
    ['repository-defined-alias'],
    ['--paginate', 'status'],
    ['-p', 'status'],
  ])('fails closed for unguarded delegated-process form: git %s', async (...args) => {
    await expect(new GitExecutor().run(args)).rejects.toMatchObject({
      code: 'EXTERNAL_DRIVER_BLOCKED',
    });
  });
});

async function waitForFile(filePath: string): Promise<void> {
  for (let attempts = 0; attempts < 200; attempts += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Timed out waiting for the Git fixture process to start.');
}
