import process from 'node:process';

import { describe, expect, it } from 'vitest';

import type { GitRemote } from '@forgeboard/git-engine';

import {
  gitHubCiDisclosure,
  gitHubPullRequestDisclosure,
  gitHubStatusDisclosure,
  gitPushDisclosure,
  gitRemoteDestination,
  type GitPushDisclosureInput,
} from './disclosures.js';

describe('remote Git outbound disclosures', () => {
  it('keeps a local bare-remote path native-only while preserving exact confirmation impact', () => {
    const destination = gitRemoteDestination(
      remote('/tmp/private/local-fixture.git'),
      '/tmp/project',
    );
    expect(destination).toMatchObject({
      kind: 'local-filesystem',
      endpoint: 'local-filesystem',
      resource: '/tmp/private/local-fixture.git',
      publicResource: 'Local Git repository',
    });
    const disclosure = gitPushDisclosure(pushInput(destination));
    expect(disclosure.destination.resource).toBe('/tmp/private/local-fixture.git');
    expect(disclosure.warning).toMatch(/receive hooks.*operating-system user/iu);
    expect(disclosure.details).toContainEqual({
      label: 'Force',
      value: 'Disabled',
    });
    expect(disclosure.details.find((detail) => detail.label === 'Files')?.value).toContain(
      'src/feature.ts',
    );
  });

  it('rejects credential-bearing network remotes rather than disclosing redacted authority', () => {
    expect(() =>
      gitRemoteDestination(
        {
          ...remote('https://REDACTED@github.com/owner/repository.git'),
          hasRedactedCredentials: true,
        },
        '/tmp/project',
      ),
    ).toThrow(/embedded credentials/u);
    expect(() =>
      gitRemoteDestination(remote('https://token@github.com/owner/repository.git'), '/tmp/project'),
    ).toThrow(/credential-free/u);
    expect(() =>
      gitRemoteDestination(remote('deploy@github.com:owner/repository.git'), '/tmp/project'),
    ).toThrow(/credential-free git account/u);
    expect(() =>
      gitRemoteDestination(remote('file://server/share/repository.git'), '/tmp/project'),
    ).toThrow(/hosted file URLs/iu);
  });

  it('rejects multiple destinations, helpers, foreign drive paths, and unsafe scp hosts', () => {
    expect(() =>
      gitRemoteDestination(
        {
          ...remote('https://github.com/owner/repository.git'),
          hasMultiplePushUrls: true,
        },
        '/tmp/project',
      ),
    ).toThrow(/multiple push destinations/iu);
    expect(() =>
      gitRemoteDestination(remote('ext::ssh -oProxyCommand=evil host'), '/tmp/project'),
    ).toThrow(/remote-helper/iu);
    if (process.platform === 'win32') {
      expect(gitRemoteDestination(remote('C:\\private\\repo.git'), 'C:\\project')).toMatchObject({
        kind: 'local-filesystem',
        endpoint: 'local-filesystem',
        publicResource: 'Local Git repository',
      });
    } else {
      expect(() => gitRemoteDestination(remote('C:\\private\\repo.git'), '/tmp/project')).toThrow(
        /another operating system/iu,
      );
    }
    expect(() => gitRemoteDestination(remote('C:private\\repo.git'), '/tmp/project')).toThrow(
      /drive-relative/iu,
    );
    expect(() =>
      gitRemoteDestination(remote('\\\\server\\share\\repository.git'), '/tmp/project'),
    ).toThrow(/network-share/iu);
    expect(() =>
      gitRemoteDestination(remote('//server/share/repository.git'), '/tmp/project'),
    ).toThrow(/network-share/iu);
    expect(() =>
      gitRemoteDestination(remote('-oProxyCommand=evil:owner/repo'), '/tmp/project'),
    ).toThrow(/hostname/iu);
    expect(() => gitRemoteDestination(remote('bad..host:owner/repo'), '/tmp/project')).toThrow(
      /hostname/iu,
    );
  });

  it('rejects ambiguous or control-bearing decoded file URL paths', () => {
    expect(() =>
      gitRemoteDestination(remote('file:////server/share/repository.git'), '/tmp/project'),
    ).toThrow(/network-share|ambiguous/iu);
    expect(() =>
      gitRemoteDestination(remote('file:///tmp/repository%00.git'), '/tmp/project'),
    ).toThrow(/bounded single-line/iu);
    expect(() =>
      gitRemoteDestination(remote('file:///tmp/repository%0A.git'), '/tmp/project'),
    ).toThrow(/bounded single-line/iu);
    expect(() =>
      gitRemoteDestination(remote('file:///tmp/repository%.git'), '/tmp/project'),
    ).toThrow(/invalid path encoding/iu);
    expect(() =>
      gitRemoteDestination(remote('file:///tmp/encoded%2Frepository.git'), '/tmp/project'),
    ).toThrow(/invalid path encoding/iu);
  });

  it('rejects percent-encoded network resources before Git can decode a different path', () => {
    for (const encoded of [
      '%2F..%2Fother.git',
      '%0Aother.git',
      '%5cother.git',
      '%2e/other.git',
      '%2E%2E/other.git',
    ]) {
      expect(() =>
        gitRemoteDestination(
          remote(`ssh://git@example.test/owner/repository${encoded}`),
          '/tmp/project',
        ),
      ).toThrow(/resource|unsupported|ambiguous/iu);
    }
  });

  it('binds GitHub compatibility to the identity parser while allowing standard SSH git users', () => {
    expect(
      gitRemoteDestination(remote('ssh://git@github.com/owner/repository.git'), '/tmp/project'),
    ).toMatchObject({
      endpoint: 'github.com',
      publicResource: 'owner/repository.git',
      githubCompatible: true,
    });
    expect(
      gitRemoteDestination(remote('ssh://github.com:2222/owner/repository.git'), '/tmp/project'),
    ).toMatchObject({ endpoint: 'github.com:2222', githubCompatible: false });
    expect(
      gitRemoteDestination(remote('ssh://git@[::1]/owner/repository.git'), '/tmp/project'),
    ).toMatchObject({ endpoint: '[::1]', githubCompatible: false });
  });

  it('rejects schema-unsafe network resources before they can poison path-free discovery', () => {
    expect(() => gitRemoteDestination(remote('https://example.test'), '/tmp/project')).toThrow(
      /resource/iu,
    );
    expect(() => gitRemoteDestination(remote('host:owner/repo?token'), '/tmp/project')).toThrow(
      /resource/iu,
    );
    expect(() =>
      gitRemoteDestination(
        { ...remote('host:owner/repository.git'), name: 'unsafe/remote' },
        '/tmp/project',
      ),
    ).toThrow(/remote name/iu);
    expect(() =>
      gitRemoteDestination(remote('http://example.test/owner/repository.git'), '/tmp/project'),
    ).toThrow(/supported credential-free destination/iu);
    expect(() =>
      gitRemoteDestination(remote('git://example.test/owner/repository.git'), '/tmp/project'),
    ).toThrow(/supported credential-free destination/iu);
  });

  it('resolves a relative local remote against the selected repository, not process cwd', () => {
    expect(gitRemoteDestination(remote('../remote.git'), '/tmp/project/worktree')).toMatchObject({
      kind: 'local-filesystem',
      resource: '/tmp/project/remote.git',
      publicResource: 'Local Git repository',
    });
  });

  it('puts the exact bounded pull request body in the native-owned disclosure', () => {
    const destination = gitRemoteDestination(
      remote('https://github.com/owner/repository.git'),
      '/tmp/project',
    );
    const body = 'Exact first line\n\n- reviewed impact';
    const disclosure = gitHubPullRequestDisclosure({
      ...pushInput(destination),
      snapshot: {
        remote: 'origin',
        remoteUrl: 'https://github.com/owner/repository.git',
        hostname: 'github.com',
        ownerRepository: 'owner/repository',
        url: 'https://github.com/owner/repository',
        defaultBranch: 'main',
        baseBranch: 'main',
        headBranch: 'forgeboard/task/agent-1',
        baseOid: 'a'.repeat(40),
        headOid: 'b'.repeat(40),
      },
      title: 'Reviewed title',
      body,
      bodySha256: 'c'.repeat(64),
      bodyCharacters: body.length,
      draft: false,
    });
    expect(disclosure.details).toContainEqual({
      label: 'Exact pull request body',
      value: body,
    });
  });

  it('discloses GitHub CLI HTTPS API transport even when the selected Git remote uses SSH', () => {
    const destination = gitRemoteDestination(
      remote('git@github.com:owner/repository.git'),
      '/tmp/project',
    );
    const snapshot = {
      remote: 'origin',
      remoteUrl: 'git@github.com:owner/repository.git',
      hostname: 'github.com',
      ownerRepository: 'owner/repository',
      url: 'https://github.com/owner/repository',
      defaultBranch: 'main',
      baseBranch: 'main',
      headBranch: 'forgeboard/task/agent-1',
      baseOid: 'a'.repeat(40),
      headOid: 'b'.repeat(40),
    };
    const disclosures = [
      gitHubStatusDisclosure({
        projectName: 'Fixture',
        destination,
        baseBranch: 'main',
        headBranch: 'forgeboard/task/agent-1',
        sourceHead: 'b'.repeat(40),
      }),
      gitHubPullRequestDisclosure({
        ...pushInput(destination),
        snapshot,
        title: 'Reviewed title',
        body: '',
        bodySha256: 'c'.repeat(64),
        bodyCharacters: 0,
        draft: false,
      }),
      gitHubCiDisclosure({
        projectName: 'Fixture',
        destination,
        snapshot,
        sourceHead: 'b'.repeat(40),
      }),
    ];
    for (const disclosure of disclosures) {
      expect(disclosure.destination).toMatchObject({
        kind: 'github',
        endpoint: 'github.com',
        resource: 'owner/repository',
        transport: 'GitHub CLI HTTPS API',
      });
    }
  });

  it('chunks the full advertised file-path disclosure into bounded native fields', () => {
    const destination = gitRemoteDestination(
      remote('/tmp/private/local-fixture.git'),
      '/tmp/project',
    );
    const files = Array.from(
      { length: 256 },
      (_, index) => `${String(index).padStart(3, '0')}-${'p'.repeat(245)}.ts`,
    );
    const disclosure = gitPushDisclosure({ ...pushInput(destination), files });
    const fileDetails = disclosure.details.filter((detail) => detail.label.startsWith('Files'));
    expect(fileDetails.length).toBeGreaterThan(1);
    expect(fileDetails.length).toBeLessThanOrEqual(3);
    expect(fileDetails.every((detail) => detail.value.length <= 24 * 1_024)).toBe(true);
    expect(fileDetails.map((detail) => detail.value).join('\n')).toContain(files.at(-1));
  });
});

function remote(url: string): GitRemote {
  return {
    name: 'origin',
    fetchUrl: url,
    pushUrl: url,
    hasRedactedCredentials: false,
    hasMultiplePushUrls: false,
  };
}

function pushInput(destination: ReturnType<typeof gitRemoteDestination>): GitPushDisclosureInput {
  return {
    projectName: 'Fixture',
    destination,
    sourceBranch: 'forgeboard/task/agent-1',
    destinationBranch: 'forgeboard/task/agent-1',
    baseCommit: 'a'.repeat(40),
    sourceHead: 'b'.repeat(40),
    commits: ['b'.repeat(40)],
    files: ['src/feature.ts'],
    additions: 2,
    deletions: 1,
    readinessEvidence: 'c'.repeat(64),
  };
}
