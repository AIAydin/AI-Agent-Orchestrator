import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChangeService } from '../../diff/changes.js';
import type { GitDelegateAuthorizer, GitDelegatePlan } from './contracts.js';
import { GitDelegateApprovalRequiredError } from './error.js';
import { GitExecutor } from '../executor.js';
import { RepositoryService } from '../service.js';
import { WorktreeService } from '../worktrees.js';
import {
  createTemporaryRepository,
  runGit,
  type TemporaryRepository,
} from '../../testing/helpers.js';

describe('external Git delegate boundary', () => {
  const fixtures: TemporaryRepository[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it('forces off repository and global textconv commands during diffs', async () => {
    const fixture = await fixtureWithAttributes(
      'README.md diff=repository-driver\nglobal.txt diff=global-driver\n',
    );
    fixtures.push(fixture);
    const repositorySentinel = path.join(fixture.root, 'repository-textconv-ran');
    const globalSentinel = path.join(fixture.root, 'global-textconv-ran');
    const script = await sentinelScript(fixture.root);
    await writeFile(path.join(fixture.repository, 'global.txt'), 'original\n');
    await runGit(fixture.repository, ['add', '--', 'global.txt']);
    await runGit(fixture.repository, ['commit', '-m', 'Add global textconv fixture']);
    await runGit(fixture.repository, [
      'config',
      'diff.repository-driver.textconv',
      filterCommand(script, repositorySentinel),
    ]);
    const home = await globalConfigHome(fixture.root, [
      '[diff "global-driver"]',
      `\ttextconv = ${filterCommand(script, globalSentinel)}`,
    ]);
    await writeFile(path.join(fixture.repository, 'README.md'), '# changed\n');
    await writeFile(path.join(fixture.repository, 'global.txt'), 'changed\n');

    const repositories = repositoriesWithHome(home);
    const diff = await new ChangeService(repositories).diff(fixture.repository, 'unstaged');

    expect(diff.files.map((file) => file.newPath)).toEqual(['README.md', 'global.txt']);
    await expectMissing(repositorySentinel);
    await expectMissing(globalSentinel);
  });

  it('returns an exact typed plan and executes no clean filter when approval is cancelled', async () => {
    const fixture = await fixtureWithAttributes('README.md filter=hostile\n');
    fixtures.push(fixture);
    const sentinel = path.join(fixture.root, 'clean-ran');
    const script = await sentinelScript(fixture.root);
    await runGit(fixture.repository, [
      'config',
      'filter.hostile.clean',
      filterCommand(script, sentinel),
    ]);
    await writeFile(path.join(fixture.repository, 'README.md'), '# changed\n');
    const repositories = new RepositoryService();
    const canonicalRepository = await realpath(fixture.repository);
    let offeredPlan: GitDelegatePlan | undefined;
    const authorize: GitDelegateAuthorizer = async (plan) => {
      offeredPlan = plan;
      await Promise.resolve();
      return await Promise.resolve(null);
    };

    await expect(
      repositories.git.withDelegateAuthorization(
        authorize,
        async () => await repositories.status(fixture.repository),
      ),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_DRIVER_BLOCKED',
      reason: 'approval-cancelled',
    });
    expect(offeredPlan).toMatchObject({
      schemaVersion: 1,
      operation: 'worktree-inspection',
      repositoryPath: canonicalRepository,
      filters: [
        expect.objectContaining({
          driver: 'hostile',
          executableConfigured: true,
          disclosedPaths: ['README.md'],
        }),
      ],
    });
    expect(offeredPlan?.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    await expectMissing(sentinel);
  });

  it('executes the exact approved clean command and revalidates immediately before diff', async () => {
    const fixture = await fixtureWithAttributes('README.md filter=approved\n');
    fixtures.push(fixture);
    const sentinel = path.join(fixture.root, 'approved-clean-ran');
    const script = await sentinelScript(fixture.root);
    await runGit(fixture.repository, [
      'config',
      'filter.approved.clean',
      filterCommand(script, sentinel),
    ]);
    await writeFile(path.join(fixture.repository, 'README.md'), '# changed\n');
    const repositories = new RepositoryService();
    const assertCurrent = vi.fn();

    const diff = await repositories.git.withDelegateAuthorization(
      async (plan) =>
        await Promise.resolve({ approved: true, fingerprint: plan.fingerprint, assertCurrent }),
      async () => await new ChangeService(repositories).diff(fixture.repository, 'unstaged'),
    );

    expect(diff.files[0]?.newPath).toBe('README.md');
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    await expect(access(sentinel)).resolves.toBeUndefined();
  });

  it('rejects a process-filter plan changed after approval without executing either command', async () => {
    const fixture = await fixtureWithAttributes('README.md filter=changing\n');
    fixtures.push(fixture);
    const firstSentinel = path.join(fixture.root, 'first-process-ran');
    const secondSentinel = path.join(fixture.root, 'second-process-ran');
    const script = await sentinelScript(fixture.root);
    await runGit(fixture.repository, [
      'config',
      'filter.changing.process',
      filterCommand(script, firstSentinel),
    ]);
    const repositories = new RepositoryService();

    await expect(
      repositories.git.withDelegateAuthorization(
        async (plan) => {
          await runGit(fixture.repository, [
            'config',
            'filter.changing.process',
            filterCommand(script, secondSentinel),
          ]);
          return { approved: true, fingerprint: plan.fingerprint, assertCurrent: () => undefined };
        },
        async () => await repositories.status(fixture.repository),
      ),
    ).rejects.toMatchObject({ reason: 'plan-changed' });
    await expectMissing(firstSentinel);
    await expectMissing(secondSentinel);
  });

  it('cancels stage-clean before git add can execute its filter', async () => {
    const fixture = await fixtureWithAttributes('README.md filter=stage-driver\n');
    fixtures.push(fixture);
    const sentinel = path.join(fixture.root, 'stage-clean-ran');
    const script = await sentinelScript(fixture.root);
    await runGit(fixture.repository, [
      'config',
      'filter.stage-driver.clean',
      filterCommand(script, sentinel),
    ]);
    await writeFile(path.join(fixture.repository, 'README.md'), '# stage me\n');
    const repositories = new RepositoryService();
    let operation: string | undefined;

    await expect(
      repositories.git.withDelegateAuthorization(
        async (plan) => {
          operation = plan.operation;
          return await Promise.resolve(null);
        },
        async () =>
          await repositories.git.runGuarded(['-C', fixture.repository, 'add', '--', 'README.md'], {
            repositoryPath: fixture.repository,
            operation: 'stage-clean',
            paths: ['README.md'],
          }),
      ),
    ).rejects.toBeInstanceOf(GitDelegateApprovalRequiredError);
    expect(operation).toBe('stage-clean');
    await expectMissing(sentinel);
    expect(await runGit(fixture.repository, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('cancels worktree smudge before checkout and removes the partial worktree', async () => {
    const fixture = await fixtureWithAttributes('README.md filter=smudge-driver\n');
    fixtures.push(fixture);
    const sentinel = path.join(fixture.root, 'worktree-smudge-ran');
    const script = await sentinelScript(fixture.root);
    await runGit(fixture.repository, [
      'config',
      'filter.smudge-driver.smudge',
      filterCommand(script, sentinel),
    ]);
    const repositories = new RepositoryService();
    const worktrees = new WorktreeService(repositories);

    await expect(
      repositories.git.withDelegateAuthorization(
        () => Promise.resolve(null),
        async () =>
          await worktrees.provision({
            repositoryPath: fixture.repository,
            managedRoot: fixture.managedRoot,
            agentId: 'cancelled-filter',
          }),
      ),
    ).rejects.toMatchObject({ reason: 'approval-cancelled' });
    await expectMissing(sentinel);
    expect(await worktrees.listOwnership(fixture.managedRoot)).toEqual([]);
    expect(await runGit(fixture.repository, ['worktree', 'list', '--porcelain'])).not.toContain(
      fixture.managedRoot,
    );
  });

  it('cancels a globally configured clone smudge filter before checkout', async () => {
    const fixture = await fixtureWithAttributes('README.md filter=clone-driver\n');
    fixtures.push(fixture);
    const sentinel = path.join(fixture.root, 'clone-smudge-ran');
    const script = await sentinelScript(fixture.root);
    const home = await globalConfigHome(fixture.root, [
      '[filter "clone-driver"]',
      `\tsmudge = ${filterCommand(script, sentinel)}`,
    ]);
    const repositories = repositoriesWithHome(home);
    const destination = path.join(fixture.root, 'cloned-repository');

    await repositories.git.run(['clone', '--no-checkout', '--', fixture.repository, destination], {
      cwd: fixture.root,
    });
    await repositories.git.run(['-C', destination, 'read-tree', 'HEAD']);
    await expect(
      repositories.git.withDelegateAuthorization(
        () => Promise.resolve(null),
        async () =>
          await repositories.git.runGuarded(['-C', destination, 'reset', '--hard', 'HEAD'], {
            repositoryPath: destination,
            operation: 'checkout-smudge',
            attributeSource: 'index',
          }),
      ),
    ).rejects.toMatchObject({ reason: 'approval-cancelled' });
    await expectMissing(sentinel);
    await expectMissing(path.join(destination, 'README.md'));
  });

  it('applies an index patch without invoking an active clean filter', async () => {
    const fixture = await fixtureWithAttributes('README.md filter=apply-driver\n');
    fixtures.push(fixture);
    await writeFile(path.join(fixture.repository, 'README.md'), '# patch content\n');
    const patch = await runGit(fixture.repository, ['diff', '--no-textconv', '--', 'README.md']);
    const sentinel = path.join(fixture.root, 'apply-clean-ran');
    const script = await sentinelScript(fixture.root);
    await runGit(fixture.repository, [
      'config',
      'filter.apply-driver.clean',
      filterCommand(script, sentinel),
    ]);

    await new GitExecutor().run(['-C', fixture.repository, 'apply', '--cached', '--recount', '-'], {
      input: patch,
    });

    await expectMissing(sentinel);
    expect(await runGit(fixture.repository, ['diff', '--cached', '--name-only'])).toContain(
      'README.md',
    );
  });

  it('refuses filtered hunk staging without changing the index', async () => {
    const fixture = await fixtureWithAttributes('README.md filter=hunk-driver\n');
    fixtures.push(fixture);
    const sentinel = path.join(fixture.root, 'hunk-clean-ran');
    const script = await sentinelScript(fixture.root);
    await runGit(fixture.repository, [
      'config',
      'filter.hunk-driver.clean',
      filterCommand(script, sentinel),
    ]);
    await writeFile(path.join(fixture.repository, 'README.md'), '# changed\n');
    const repositories = new RepositoryService();
    const changes = new ChangeService(repositories);
    const authorize: GitDelegateAuthorizer = async (plan) =>
      await Promise.resolve({
        approved: true,
        fingerprint: plan.fingerprint,
        assertCurrent: () => undefined,
      });
    const review = await repositories.git.withDelegateAuthorization(
      authorize,
      async () => await changes.diff(fixture.repository, 'unstaged'),
    );
    const hunkId = review.files[0]?.hunks[0]?.id;
    if (hunkId === undefined) throw new Error('Filtered hunk fixture has no diff hunk.');
    const indexBefore = await runGit(fixture.repository, ['ls-files', '--stage']);

    await expect(
      repositories.git.withDelegateAuthorization(
        authorize,
        async () => await changes.stageHunks(fixture.repository, [hunkId]),
      ),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_DRIVER_BLOCKED',
      reason: 'partial-staging-unsupported',
    });

    expect(await runGit(fixture.repository, ['ls-files', '--stage'])).toBe(indexBefore);
    expect(await runGit(fixture.repository, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('fails closed before a configured custom merge driver can run', async () => {
    const fixture = await fixtureWithAttributes('README.md merge=hostile-merge\n');
    fixtures.push(fixture);
    const sentinel = path.join(fixture.root, 'merge-driver-ran');
    const script = await sentinelScript(fixture.root);
    await runGit(fixture.repository, [
      'config',
      'merge.hostile-merge.driver',
      `${filterCommand(script, sentinel)} %O %A %B`,
    ]);
    const repositories = new RepositoryService();

    await expect(
      repositories.git.runGuarded(['-C', fixture.repository, 'merge', '--no-edit', 'HEAD'], {
        repositoryPath: fixture.repository,
        operation: 'history-update',
      }),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_DRIVER_BLOCKED',
      details: { reason: 'custom-merge-driver' },
    });
    await expectMissing(sentinel);
  });

  it('overrides configured commit and sequence editors before Git can invoke them', async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const editorSentinel = path.join(fixture.root, 'editor-ran');
    const sequenceSentinel = path.join(fixture.root, 'sequence-editor-ran');
    const script = await sentinelScript(fixture.root);
    await runGit(fixture.repository, [
      'config',
      'core.editor',
      filterCommand(script, editorSentinel),
    ]);
    await runGit(fixture.repository, [
      'config',
      'sequence.editor',
      filterCommand(script, sequenceSentinel),
    ]);
    const repositories = new RepositoryService();

    await repositories.git.run(['-C', fixture.repository, 'commit', '--allow-empty'], {
      allowNonZeroExit: true,
    });
    await repositories.git.runGuarded(
      ['-C', fixture.repository, 'rebase', '--interactive', 'HEAD'],
      { repositoryPath: fixture.repository, operation: 'history-update' },
      { allowNonZeroExit: true },
    );

    await expectMissing(editorSentinel);
    await expectMissing(sequenceSentinel);
  });
});

async function fixtureWithAttributes(attributes: string): Promise<TemporaryRepository> {
  const fixture = await createTemporaryRepository();
  await writeFile(path.join(fixture.repository, '.gitattributes'), attributes);
  await runGit(fixture.repository, ['add', '--', '.gitattributes']);
  await runGit(fixture.repository, ['commit', '-m', 'Add filter attributes']);
  return fixture;
}

async function sentinelScript(root: string): Promise<string> {
  const script = path.join(root, 'delegate-sentinel.cjs');
  await writeFile(
    script,
    [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.argv[2], 'executed\\n');",
      'process.stdin.pipe(process.stdout);',
      '',
    ].join('\n'),
  );
  return script;
}

function filterCommand(script: string, sentinel: string): string {
  return `${shellLiteral(process.execPath)} ${shellLiteral(script)} ${shellLiteral(sentinel)}`;
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function globalConfigHome(root: string, lines: readonly string[]): Promise<string> {
  const home = path.join(root, `home-${String(Math.random()).slice(2)}`);
  await mkdir(home);
  await writeFile(path.join(home, '.gitconfig'), `${lines.join('\n')}\n`);
  return home;
}

function repositoriesWithHome(home: string): RepositoryService {
  return new RepositoryService(
    new GitExecutor({ environment: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } }),
  );
}

async function expectMissing(candidate: string): Promise<void> {
  await expect(access(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
}
