import { describe, expect, it } from 'vitest';

import { dockerPullDisclosure, gitCloneDisclosure } from './destinations.js';

describe('outbound destination disclosure', () => {
  it('resolves Docker Hub defaults and preserves the exact image resource', () => {
    expect(
      dockerPullDisclosure(
        {
          dockerExecutable: '/usr/local/bin/docker',
          image: 'forgeboard/agent:1',
          containerExecutable: '/usr/local/bin/codex',
        },
        '/opt/forgeboard/docker',
      ),
    ).toMatchObject({
      action: 'docker-image-pull',
      destination: {
        endpoint: 'registry-1.docker.io',
        resource: 'forgeboard/agent:1',
      },
    });
    expect(
      dockerPullDisclosure(
        {
          dockerExecutable: 'docker',
          image: 'ubuntu:24.04',
          containerExecutable: '/usr/bin/env',
        },
        '/opt/forgeboard/docker',
      ).destination,
    ).toEqual({
      kind: 'container-registry',
      endpoint: 'registry-1.docker.io',
      resource: 'ubuntu:24.04',
      transport: 'Docker Registry API',
    });
    expect(
      dockerPullDisclosure(
        {
          dockerExecutable: 'docker',
          image: 'localhost:5000/team/agent:1',
          containerExecutable: '/usr/local/bin/codex',
        },
        '/opt/forgeboard/docker',
      ).destination.endpoint,
    ).toBe('localhost:5000');
  });

  it('discloses HTTPS and SSH Git destinations without accepting embedded credentials', () => {
    expect(
      gitCloneDisclosure('https://github.com/AIAydin/AI-Agent-Orchestrator.git', '/tmp/project'),
    ).toMatchObject({
      action: 'git-clone',
      destination: {
        endpoint: 'github.com',
        resource: '/AIAydin/AI-Agent-Orchestrator.git',
        transport: 'HTTPS',
      },
    });
    expect(
      gitCloneDisclosure('git@github.com:AIAydin/AI-Agent-Orchestrator.git', '/tmp/project'),
    ).toMatchObject({
      destination: {
        endpoint: 'github.com',
        resource: 'git@github.com:AIAydin/AI-Agent-Orchestrator.git',
        transport: 'SSH',
      },
    });
    expect(() =>
      gitCloneDisclosure('https://token@github.com/owner/repository.git', '/tmp/project'),
    ).toThrow(/credentials/u);
    expect(() =>
      gitCloneDisclosure('https://github.com/owner/repository.git?token=secret', '/tmp/project'),
    ).toThrow(/query/u);
  });
});
