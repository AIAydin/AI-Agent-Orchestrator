import { describe, expect, it } from 'vitest';

import { AppSettingsSchema } from '../application/contracts.js';
import {
  DockerPullResultSchema,
  DockerReadinessInputSchema,
  DockerReadinessSchema,
} from './contracts.js';

describe('Docker IPC contracts', () => {
  const input = {
    dockerExecutable: '/usr/local/bin/docker',
    image: 'registry.example/agent:1',
    containerExecutable: '/usr/local/bin/codex',
  };

  it('accepts only strict, shell-inert readiness input', () => {
    expect(DockerReadinessInputSchema.parse(input)).toEqual(input);
    expect(
      DockerReadinessInputSchema.safeParse({ ...input, image: 'agent;touch /tmp/escaped' }).success,
    ).toBe(false);
    expect(
      DockerReadinessInputSchema.safeParse({ ...input, containerExecutable: '../../bin/codex' })
        .success,
    ).toBe(false);
    expect(
      DockerReadinessInputSchema.safeParse({ ...input, containerExecutable: '/usr/./bin/codex' })
        .success,
    ).toBe(false);
    expect(
      DockerReadinessInputSchema.safeParse({ ...input, containerExecutable: '/' }).success,
    ).toBe(false);
    expect(DockerReadinessInputSchema.safeParse({ ...input, timeoutMs: 999_999 }).success).toBe(
      false,
    );
  });

  it('bounds readiness and pull results crossing into the renderer', () => {
    const readiness = {
      executable: input.dockerExecutable,
      image: input.image,
      containerExecutable: input.containerExecutable,
      executableAvailable: true,
      daemonAvailable: true,
      imageAvailable: true,
      imageCompatible: true,
      containerExecutableAvailable: true,
      available: true,
      status: 'ready' as const,
      checkedAt: '2026-07-14T16:00:00.000Z',
      agentVersion: 'codex 1.2.3',
    };
    expect(DockerReadinessSchema.parse(readiness)).toEqual(readiness);
    expect(DockerReadinessSchema.safeParse({ ...readiness, commandOutput: 'secret' }).success).toBe(
      false,
    );
    expect(DockerPullResultSchema.parse({ outcome: 'pulled', readiness })).toMatchObject({
      outcome: 'pulled',
      readiness: { available: true },
    });
  });
});

describe('Docker settings defaults', () => {
  const base = {
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'worktree-write',
    worktreeRoot: '/tmp/worktrees',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH'],
    previewPortStart: 41_000,
    previewPortEnd: 41_999,
    transcriptRetentionDays: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
  } as const;

  it('does not claim a generic image contains an agent CLI by default', () => {
    const settings = AppSettingsSchema.parse(base);
    expect(settings).toMatchObject({
      dockerEnabled: false,
      dockerExecutable: 'docker',
      dockerImage: '',
      dockerContainerExecutable: '',
    });
  });

  it('requires explicit image configuration before enabling Docker', () => {
    expect(AppSettingsSchema.safeParse({ ...base, dockerEnabled: true }).success).toBe(false);
    expect(
      AppSettingsSchema.safeParse({
        ...base,
        dockerEnabled: true,
        dockerImage: 'registry.example/agent:1',
        dockerContainerExecutable: '/usr/local/bin/codex',
      }).success,
    ).toBe(true);
    expect(
      AppSettingsSchema.safeParse({
        ...base,
        defaultPermissionProfile: 'docker-isolated',
        dockerEnabled: false,
      }).success,
    ).toBe(false);
  });
});
