import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { runGit } from '../../testing/helpers.js';
import {
  assertGitRemoteConfigurationName,
  classifyConfiguredRemoteTarget,
  resolveGitRemoteTarget,
} from './identity.js';

describe('managed Git remote identity', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map(async (directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('accepts portable remote names and rejects ref/config ambiguities', () => {
    for (const name of ['origin', 'upstream-2', 'team.remote_name']) {
      expect(() => assertGitRemoteConfigurationName(name)).not.toThrow();
    }
    for (const name of ['', '.origin', 'origin.', 'origin..backup', 'origin.lock', '-origin']) {
      expect(() => assertGitRemoteConfigurationName(name)).toThrow(/remote names/iu);
    }
  });

  it.each([
    [
      'https://github.com/owner/repository.git',
      {
        transport: 'https',
        endpoint: 'github.com',
        resource: 'owner/repository.git',
      },
    ],
    [
      'ssh://git@github.com/owner/repository.git',
      {
        transport: 'ssh',
        endpoint: 'github.com',
        resource: 'owner/repository.git',
      },
    ],
    [
      'git@github.com:owner/repository.git',
      {
        transport: 'ssh',
        endpoint: 'github.com',
        resource: 'owner/repository.git',
      },
    ],
    [
      'ssh://git@example.test:2222/owner/repository.git',
      {
        transport: 'ssh',
        endpoint: 'example.test:2222',
        resource: 'owner/repository.git',
      },
    ],
  ])('accepts a credential-free network target: %s', async (url, expected) => {
    await expect(resolveGitRemoteTarget({ kind: 'network', url })).resolves.toMatchObject({
      kind: 'network',
      exactUrl: url,
      ...expected,
    });
  });

  it.each([
    'http://example.test/owner/repository.git',
    'git://example.test/owner/repository.git',
    'https://token@example.test/owner/repository.git',
    'ssh://root@example.test/owner/repository.git',
    'https://example.test/owner/repository.git?token=secret',
    'https://example.test/owner/%2e%2e/repository.git',
    'https://example.test/owner/my repository.git',
    'https://example.test/owner\\repository.git',
    'ext::sh -c evil',
    '../relative/repository.git',
    ' https://example.test/owner/repository.git',
  ])('rejects an unsafe managed network target without echoing it: %s', async (url) => {
    const result = resolveGitRemoteTarget({ kind: 'network', url });
    await expect(result).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(result).rejects.not.toThrow(url);
  });

  it('accepts worktree and bare local repositories but rejects a plain directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-remote-target-'));
    temporaryDirectories.push(root);
    const plain = path.join(root, 'plain');
    const worktree = path.join(root, 'worktree');
    const bare = path.join(root, 'bare.git');
    await mkdir(plain);
    await runGit(root, ['init', '-b', 'main', worktree]);
    await runGit(root, ['init', '--bare', bare]);
    const canonicalWorktree = await realpath(worktree);
    const canonicalBare = await realpath(bare);

    await expect(
      resolveGitRemoteTarget({ kind: 'local-filesystem', path: plain }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const worktreeTarget = await resolveGitRemoteTarget({
      kind: 'local-filesystem',
      path: worktree,
    });
    expect(worktreeTarget).toMatchObject({
      kind: 'local-filesystem',
      exactUrl: canonicalWorktree,
      resource: canonicalWorktree,
      endpoint: 'local-filesystem',
      repositoryIdentity: {
        repositoryKind: 'worktree',
        repositoryRoot: canonicalWorktree,
        commonDirectory: path.join(canonicalWorktree, '.git'),
      },
    });
    if (
      worktreeTarget.kind !== 'local-filesystem' ||
      worktreeTarget.repositoryIdentity === undefined
    ) {
      throw new Error('Expected a local worktree identity.');
    }
    for (const identityPart of [
      worktreeTarget.repositoryIdentity.repositoryRootDevice,
      worktreeTarget.repositoryIdentity.repositoryRootInode,
      worktreeTarget.repositoryIdentity.commonDirectoryDevice,
      worktreeTarget.repositoryIdentity.commonDirectoryInode,
    ]) {
      expect(identityPart).toMatch(/^\d+$/u);
    }
    await expect(
      resolveGitRemoteTarget({ kind: 'local-filesystem', path: bare }),
    ).resolves.toMatchObject({
      kind: 'local-filesystem',
      exactUrl: canonicalBare,
      resource: canonicalBare,
      endpoint: 'local-filesystem',
      repositoryIdentity: {
        repositoryKind: 'bare',
        repositoryRoot: canonicalBare,
        commonDirectory: canonicalBare,
      },
    });

    const foreign = process.platform === 'win32' ? '/tmp/foreign-repository' : 'C:\\foreign\\repo';
    await expect(
      resolveGitRemoteTarget({ kind: 'local-filesystem', path: foreign }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      resolveGitRemoteTarget({
        kind: 'local-filesystem',
        path: process.platform === 'win32' ? '\\\\server\\repo' : '//server/repo',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('canonicalizes a nested worktree selection to the repository root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-remote-target-'));
    temporaryDirectories.push(root);
    const worktree = path.join(root, 'worktree');
    const nested = path.join(worktree, 'nested', 'directory');
    await runGit(root, ['init', '-b', 'main', worktree]);
    await mkdir(nested, { recursive: true });
    const canonicalWorktree = await realpath(worktree);

    await expect(
      resolveGitRemoteTarget({ kind: 'local-filesystem', path: nested }),
    ).resolves.toMatchObject({
      exactUrl: canonicalWorktree,
      resource: canonicalWorktree,
      repositoryIdentity: { repositoryRoot: canonicalWorktree },
    });
  });

  it('classifies existing remotes without disclosing an unsafe target as supported', () => {
    expect(
      classifyConfiguredRemoteTarget('/tmp/project', ['https://github.com/owner/repository.git']),
    ).toMatchObject({ state: 'supported', target: { kind: 'network' } });
    expect(classifyConfiguredRemoteTarget('/tmp/project', [])).toEqual({
      state: 'missing-url',
      target: null,
    });
    expect(
      classifyConfiguredRemoteTarget('/tmp/project', [
        'https://a.test/a.git',
        'https://b.test/b.git',
      ]),
    ).toEqual({ state: 'multiple-urls', target: null });
    expect(
      classifyConfiguredRemoteTarget('/tmp/project', [
        'https://token@example.test/owner/repository.git',
      ]),
    ).toEqual({ state: 'embedded-credentials', target: null });
    expect(classifyConfiguredRemoteTarget('/tmp/project', ['ext::sh -c evil'])).toEqual({
      state: 'unsupported',
      target: null,
    });
  });
});
