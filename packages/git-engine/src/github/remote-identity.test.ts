import { describe, expect, it } from 'vitest';

import {
  assertGitHubRepositoryIdentity,
  assertGitHubResultUrl,
  parseGitHubRemoteIdentity,
} from './remote-identity.js';

describe('GitHub remote identity', () => {
  it('normalizes standard SSH and HTTPS remotes without exposing an account component', () => {
    expect(
      parseGitHubRemoteIdentity('origin', 'git@github.com:AIAydin/AI-Agent-Orchestrator.git'),
    ).toEqual({
      remote: 'origin',
      remoteUrl: 'ssh://github.com/AIAydin/AI-Agent-Orchestrator.git',
      hostname: 'github.com',
      ownerRepository: 'AIAydin/AI-Agent-Orchestrator',
    });
    expect(
      parseGitHubRemoteIdentity('upstream', 'https://github.com/AIAydin/AI-Agent-Orchestrator'),
    ).toMatchObject({
      remote: 'upstream',
      remoteUrl: 'https://github.com/AIAydin/AI-Agent-Orchestrator.git',
    });
  });

  it('rejects credentials, query values, fragments, malformed repositories, and other protocols', () => {
    const rejected = [
      'https://token@github.com/owner/repository.git',
      'https://github.com/owner/repository.git?token=secret',
      'https://github.com/owner/repository.git#secret',
      'http://github.com/owner/repository.git',
      'ssh://other@github.com/owner/repository.git',
      'git@good.-bad.example:owner/repository.git',
      'https://github.com/owner/too/many.git',
      'ext::ssh -oProxyCommand=bad',
    ];
    for (const remote of rejected) {
      expect(() => parseGitHubRemoteIdentity('origin', remote)).toThrow();
    }
  });

  it('binds repository and result URLs to the selected credential-free host and repository', () => {
    const identity = parseGitHubRemoteIdentity(
      'origin',
      'https://github.example/owner/repository.git',
    );
    expect(
      assertGitHubRepositoryIdentity(
        identity,
        'owner/repository',
        'https://github.example/owner/repository',
      ),
    ).toEqual({
      ownerRepository: 'owner/repository',
      url: 'https://github.example/owner/repository',
    });
    expect(
      assertGitHubResultUrl(
        identity,
        'https://github.example/owner/repository/pull/42',
        'pull-request',
      ),
    ).toBe('https://github.example/owner/repository/pull/42');
    expect(() =>
      assertGitHubResultUrl(
        identity,
        'https://github.example/another/repository/pull/42',
        'pull-request',
      ),
    ).toThrow();
    expect(() =>
      assertGitHubRepositoryIdentity(
        identity,
        'owner/repository',
        'https://token@github.example/owner/repository',
      ),
    ).toThrow();
  });
});
