import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DOCKER_SESSION_IMAGE } from '../../shared/docker/contracts.js';
import {
  dockerSessionContainerCommand,
  dockerSessionRunArguments,
  ensureDockerSessionRuntime,
  resolveDockerSessionLaunch,
  type DockerSessionCommandRunner,
} from './docker-session.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('dockerSessionContainerCommand', () => {
  it('runs built-in CLIs through npx inside the default image', () => {
    expect(dockerSessionContainerCommand('claude', DEFAULT_DOCKER_SESSION_IMAGE, null)).toEqual([
      'npx',
      '--yes',
      '@anthropic-ai/claude-code',
    ]);
    expect(
      dockerSessionContainerCommand('codex', DEFAULT_DOCKER_SESSION_IMAGE, 'gpt-5-codex'),
    ).toEqual(['npx', '--yes', '@openai/codex', '-m', 'gpt-5-codex']);
  });

  it('uses the manifest command name inside a user-chosen image', () => {
    expect(dockerSessionContainerCommand('claude', 'acme/agents:1', 'claude-sonnet-5')).toEqual([
      'claude',
      '--model',
      'claude-sonnet-5',
    ]);
    expect(dockerSessionContainerCommand('opencode', 'acme/agents:1', null)).toEqual(['opencode']);
  });

  it('returns null for adapters without a built-in command shape', () => {
    expect(dockerSessionContainerCommand('custom', DEFAULT_DOCKER_SESSION_IMAGE, null)).toBeNull();
    expect(dockerSessionContainerCommand('acme.agent', 'acme/agents:1', null)).toBeNull();
  });
});

describe('dockerSessionRunArguments', () => {
  const input = {
    containerName: 'forgeboard-agent-abc123',
    image: 'node:22-bookworm',
    worktreePath: '/tmp/managed/worktree-1',
    cpuLimit: 2,
    memoryMb: 4096,
    command: ['npx', '--yes', '@anthropic-ai/claude-code'],
  };

  it('builds the exact docker run argv with the worktree bind-mounted at /workspace', () => {
    expect(dockerSessionRunArguments(input)).toEqual([
      'run',
      '--rm',
      '--interactive',
      '--tty',
      '--name',
      'forgeboard-agent-abc123',
      '--mount',
      'type=bind,source=/tmp/managed/worktree-1,target=/workspace',
      '--workdir',
      '/workspace',
      '--cpus',
      '2',
      '--memory',
      '4096m',
      '--network',
      'bridge',
      'node:22-bookworm',
      'npx',
      '--yes',
      '@anthropic-ai/claude-code',
    ]);
  });

  it('rejects worktree paths Docker mount syntax cannot carry', () => {
    expect(() => dockerSessionRunArguments({ ...input, worktreePath: 'relative/path' })).toThrow(
      /absolute/i,
    );
    expect(() =>
      dockerSessionRunArguments({ ...input, worktreePath: '/tmp/with,comma' }),
    ).toThrow(/bind-mounted/i);
  });

  it('rejects hostile images, names, limits, and empty commands before any process starts', () => {
    expect(() =>
      dockerSessionRunArguments({ ...input, image: 'agent;touch /tmp/escaped' }),
    ).toThrow(/spaces or special characters/i);
    expect(() => dockerSessionRunArguments({ ...input, containerName: '--privileged' })).toThrow(
      /container name/i,
    );
    expect(() => dockerSessionRunArguments({ ...input, cpuLimit: 0 })).toThrow(/limits/i);
    expect(() => dockerSessionRunArguments({ ...input, memoryMb: 1.5 })).toThrow(/limits/i);
    expect(() => dockerSessionRunArguments({ ...input, command: [] })).toThrow(/command/i);
  });
});

describe('ensureDockerSessionRuntime', () => {
  it('reports a stopped daemon tersely', async () => {
    const runCommand = runnerFor({ version: 1 });
    await expect(
      ensureDockerSessionRuntime('/usr/local/bin/docker', 'node:22-bookworm', { runCommand }),
    ).rejects.toThrow(/isn't running/i);
  });

  it('points a missing default image at Settings → Docker', async () => {
    const runCommand = runnerFor({ version: 0, inspect: 1 });
    await expect(
      ensureDockerSessionRuntime('/usr/local/bin/docker', DEFAULT_DOCKER_SESSION_IMAGE, {
        runCommand,
      }),
    ).rejects.toThrow(/isn't downloaded yet/i);
    await expect(
      ensureDockerSessionRuntime('/usr/local/bin/docker', 'acme/agents:1', { runCommand }),
    ).rejects.toThrow(/isn't available locally/i);
  });

  it('passes when the daemon answers and the image exists', async () => {
    const runCommand = runnerFor({ version: 0, inspect: 0 });
    await expect(
      ensureDockerSessionRuntime('/usr/local/bin/docker', 'node:22-bookworm', { runCommand }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(runCommand).mock.calls.map(([, args]) => args)).toEqual([
      ['version', '--format', '{{.Server.Version}}'],
      ['image', 'inspect', '--format', '{{.Id}}', 'node:22-bookworm'],
    ]);
  });
});

describe('resolveDockerSessionLaunch', () => {
  const settings = {
    dockerEnabled: true,
    dockerExecutable: 'docker',
    dockerImage: '',
    dockerCpuLimit: 2,
    dockerMemoryMb: 4096,
    dockerMountHostCredentials: false,
  };

  it('fails closed before touching Docker when the profile is not usable', async () => {
    await expect(
      resolveDockerSessionLaunch({
        settings: { ...settings, dockerEnabled: false },
        adapterId: 'claude',
        model: null,
        worktreePath: '/tmp/worktree',
        containerName: 'forgeboard-agent-1',
      }),
    ).rejects.toThrow(/turn on docker/i);
    await expect(
      resolveDockerSessionLaunch({
        settings: { ...settings, dockerMountHostCredentials: true },
        adapterId: 'claude',
        model: null,
        worktreePath: '/tmp/worktree',
        containerName: 'forgeboard-agent-1',
      }),
    ).rejects.toThrow(/blocked/i);
    await expect(
      resolveDockerSessionLaunch({
        settings,
        adapterId: 'acme.custom',
        model: null,
        worktreePath: '/tmp/worktree',
        containerName: 'forgeboard-agent-1',
      }),
    ).rejects.toThrow(/built-in agents/i);
  });

  it('resolves the docker CLI and returns the container run argv for a ready daemon', async () => {
    if (process.platform === 'win32') return;
    const executable = await fakeDocker();
    const launch = await resolveDockerSessionLaunch(
      {
        settings: { ...settings, dockerExecutable: executable, dockerImage: 'acme/agents:1' },
        adapterId: 'claude',
        model: 'claude-sonnet-5',
        worktreePath: '/tmp/managed/worktree-1',
        containerName: 'forgeboard-agent-1',
      },
      { checkTimeoutMs: 2_000 },
    );
    expect(launch.executable).toMatch(/\/docker$/u);
    expect(launch.arguments.slice(-4)).toEqual([
      'acme/agents:1',
      'claude',
      '--model',
      'claude-sonnet-5',
    ]);
    expect(launch.arguments).toContain('--mount');
    expect(launch.arguments).toContain('type=bind,source=/tmp/managed/worktree-1,target=/workspace');
  });
});

function runnerFor(exitCodes: {
  version: number;
  inspect?: number;
}): DockerSessionCommandRunner {
  return vi.fn((_executable: string, arguments_: readonly string[]) => {
    const exitCode = arguments_[0] === 'version' ? exitCodes.version : (exitCodes.inspect ?? 1);
    return Promise.resolve({ exitCode, stdout: '', stderr: '', timedOut: false });
  });
}

async function fakeDocker(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forgeboard-docker-session-'));
  roots.push(root);
  const executable = path.join(root, 'docker');
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "version" ]; then printf '27.5.1'; exit 0; fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then printf 'sha256:abc'; exit 0; fi
exit 19
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return executable;
}
