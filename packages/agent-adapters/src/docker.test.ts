import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_MANIFEST,
  DockerLaunchOptionsSchema,
  DockerLaunchValidationError,
  PreparedAgentLaunchSchema,
  detectDockerRuntime,
  isForbiddenDockerEnvironmentName,
  mapWorktreePathToContainer,
  planDockerAgentLaunch,
  type ContextAttachment,
  type DockerLaunchOptions,
  type PreparedAgentLaunch,
} from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function temporaryDirectory(prefix = 'forgeboard-docker-planner-'): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const canonicalDirectory = await realpath(directory);
  temporaryDirectories.push(canonicalDirectory);
  return canonicalDirectory;
}

function preparedLaunch(
  worktree: string,
  overrides: {
    arguments?: string[];
    attachments?: ContextAttachment[];
    environment?: Record<string, string>;
    initialStdin?: string;
    runtime?: 'pty' | 'pipes';
    resumeSessionId?: string;
  } = {},
): PreparedAgentLaunch {
  const environment = overrides.environment ?? {};
  return PreparedAgentLaunchSchema.parse({
    apiVersion: 1,
    manifest: CODEX_MANIFEST,
    disclosure: {
      adapterId: CODEX_MANIFEST.id,
      provider: CODEX_MANIFEST.provider.name,
      executable: '/usr/local/bin/codex',
      arguments: overrides.arguments ?? ['--no-alt-screen', 'Review the assigned worktree.'],
      cwd: worktree,
      shell: false,
      runtime: overrides.runtime ?? 'pty',
      environmentVariableNames: Object.keys(environment).sort(),
      contextAttachments: overrides.attachments ?? [],
      permissionProfile: {
        id: 'prepared-worktree',
        name: 'Prepared worktree access',
        mode: 'worktree-write',
        enforcement: 'provider',
        readRoots: [worktree],
        writeRoots: [worktree],
        network: 'provider-controlled',
        approvalPolicy: 'Provider approval applies before Docker transformation.',
        disclosure: 'This input plan has not yet been Docker isolated.',
      },
      warnings: ['Input warning that must not be represented as Docker enforcement.'],
    },
    environment,
    ...(overrides.initialStdin === undefined ? {} : { initialStdin: overrides.initialStdin }),
    ...(overrides.resumeSessionId === undefined
      ? {}
      : { resumeSessionId: overrides.resumeSessionId }),
  });
}

function dockerOptions(
  worktree: string,
  overrides: Partial<DockerLaunchOptions> = {},
): DockerLaunchOptions {
  return {
    assignedWorktreePath: worktree,
    worktreeAccess: 'read-only',
    dockerExecutable: '/opt/Docker App/bin/docker',
    image: 'ghcr.io/forgeboard/agent:1.0.0',
    containerExecutable: '/usr/local/bin/codex',
    userId: 1000,
    groupId: 1001,
    cpuLimit: 1.5,
    memoryLimitMb: 2048,
    pidsLimit: 128,
    tmpfsSizeMb: 64,
    network: { mode: 'none' },
    environmentAllowlist: ['OPENAI_API_KEY', 'SAFE_NAME'],
    ...overrides,
  };
}

describe('Docker agent launch planning', () => {
  it('emits exact shell-free hardened args and rewrites approved paths with spaces', async () => {
    const root = await temporaryDirectory();
    const worktree = path.join(root, 'assigned worktree with spaces');
    await mkdir(worktree);
    const contextPath = path.join(worktree, 'selected file.ts');
    await writeFile(contextPath, 'export const selected = true;\n');
    const secret = 'provider-secret-value';
    const input = preparedLaunch(worktree, {
      arguments: [
        '--no-alt-screen',
        '--context',
        contextPath,
        'argument with spaces',
        '$(touch should-never-run)',
        `Read ${contextPath} without interpolation.`,
      ],
      attachments: [{ path: contextPath, kind: 'file', explicitlyApproved: true }],
      environment: {
        OPENAI_API_KEY: secret,
        SAFE_NAME: 'safe-value',
        UNAPPROVED_SECRET: 'must-not-pass',
      },
      initialStdin: `Use ${contextPath}.\n`,
      resumeSessionId: 'provider-session-7',
    });

    const result = await planDockerAgentLaunch(input, dockerOptions(worktree));
    expect(result.disclosure.arguments).toEqual([
      'run',
      '--pull',
      'never',
      '--rm',
      '--init',
      '--interactive',
      '--tty',
      '--user',
      '1000:1001',
      '--workdir',
      '/workspace',
      '--mount',
      `type=bind,source=${worktree},target=/workspace,readonly`,
      '--cpus',
      '1.5',
      '--memory',
      '2048m',
      '--pids-limit',
      '128',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
      '--tmpfs',
      '/home/forgeboard:rw,noexec,nosuid,nodev,size=64m,mode=0700,uid=1000,gid=1001',
      '--ipc',
      'none',
      '--network',
      'none',
      '--entrypoint',
      '/usr/local/bin/codex',
      '--env',
      'HOME=/home/forgeboard',
      '--env',
      'XDG_CONFIG_HOME=/home/forgeboard/.config',
      '--env',
      'XDG_CACHE_HOME=/home/forgeboard/.cache',
      '--env',
      'TMPDIR=/tmp',
      '--env',
      'OPENAI_API_KEY',
      '--env',
      'SAFE_NAME',
      'ghcr.io/forgeboard/agent:1.0.0',
      '--no-alt-screen',
      '--context',
      '/workspace/selected file.ts',
      'argument with spaces',
      '$(touch should-never-run)',
      'Read /workspace/selected file.ts without interpolation.',
    ]);
    expect(result.disclosure).toMatchObject({
      executable: '/opt/Docker App/bin/docker',
      cwd: worktree,
      shell: false,
      runtime: 'pty',
      environmentVariableNames: [
        'HOME',
        'OPENAI_API_KEY',
        'SAFE_NAME',
        'TMPDIR',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
      ],
      contextAttachments: [
        { path: '/workspace/selected file.ts', kind: 'file', explicitlyApproved: true },
      ],
      permissionProfile: {
        mode: 'docker-isolated',
        enforcement: 'docker',
        readRoots: [worktree],
        writeRoots: [],
        network: 'blocked',
      },
    });
    expect(result.environment).toEqual({
      OPENAI_API_KEY: secret,
      SAFE_NAME: 'safe-value',
    });
    expect(result.initialStdin).toBe('Use /workspace/selected file.ts.\n');
    expect(result.resumeSessionId).toBe('provider-session-7');
    expect(result.manifest).toEqual(input.manifest);
    expect(JSON.stringify(result.disclosure)).not.toContain(secret);
    expect(JSON.stringify(result.disclosure)).not.toContain('safe-value');
    expect(JSON.stringify(result.disclosure.arguments)).not.toMatch(
      /docker\.sock|Keychains|\.ssh|SSH_AUTH_SOCK/u,
    );
    expect(result.disclosure.arguments.filter((argument) => argument === '--mount')).toHaveLength(
      1,
    );
    expect(result.disclosure.arguments).not.toContain('--volume');
    expect(result.disclosure.warnings.join(' ')).toContain('HOME=/home/forgeboard');
  });

  it('switches only the worktree mount and explicitly approved network policy', async () => {
    const worktree = await temporaryDirectory();
    const input = preparedLaunch(worktree, { runtime: 'pipes', initialStdin: 'prompt\n' });
    const result = await planDockerAgentLaunch(
      input,
      dockerOptions(worktree, {
        worktreeAccess: 'read-write',
        network: { mode: 'bridge', explicitlyApproved: true },
        environmentAllowlist: [],
      }),
    );

    const mountIndex = result.disclosure.arguments.indexOf('--mount');
    expect(result.disclosure.arguments[mountIndex + 1]).toBe(
      `type=bind,source=${worktree},target=/workspace`,
    );
    expect(result.disclosure.arguments).not.toContain('--tty');
    expect(result.disclosure.arguments).toContain('bridge');
    expect(result.initialStdin).toBe('prompt\n');
    expect(result.disclosure.permissionProfile).toMatchObject({
      enforcement: 'docker',
      writeRoots: [worktree],
      network: 'allowed',
    });
    expect(result.disclosure.warnings.join(' ')).toContain('explicit approval');
  });

  it('requires non-root IDs, explicit bridge approval, and safe environment names', async () => {
    const worktree = await temporaryDirectory();
    const input = preparedLaunch(worktree);

    await expect(
      planDockerAgentLaunch(input, dockerOptions(worktree, { userId: 0 })),
    ).rejects.toThrow();
    expect(() =>
      DockerLaunchOptionsSchema.parse({
        ...dockerOptions(worktree),
        network: { mode: 'bridge' },
      }),
    ).toThrow();
    await expect(
      planDockerAgentLaunch(
        input,
        dockerOptions(worktree, { environmentAllowlist: ['SSH_AUTH_SOCK'] }),
      ),
    ).rejects.toThrow('host credentials or a host control socket');
    await expect(
      planDockerAgentLaunch(
        preparedLaunch(worktree, { environment: { CONFIG_PATH: '/Users/user/.ssh/config' } }),
        dockerOptions(worktree, { environmentAllowlist: ['CONFIG_PATH'] }),
      ),
    ).rejects.toThrow('unsupported host path');

    expect(isForbiddenDockerEnvironmentName('docker_host', 'win32')).toBe(true);
    expect(isForbiddenDockerEnvironmentName('DoCkEr_CoNtExT', 'win32')).toBe(true);
    expect(isForbiddenDockerEnvironmentName('home', 'win32')).toBe(true);
    expect(isForbiddenDockerEnvironmentName('docker_host', 'linux')).toBe(false);
    expect(isForbiddenDockerEnvironmentName('home', 'darwin')).toBe(false);
    expect(isForbiddenDockerEnvironmentName('DOCKER_host', 'linux')).toBe(true);

    const caseVariantEnvironment = DockerLaunchOptionsSchema.safeParse({
      ...dockerOptions(worktree),
      environmentAllowlist: ['docker_host'],
    });
    expect(caseVariantEnvironment.success).toBe(process.platform !== 'win32');
    const caseVariantDuplicates = DockerLaunchOptionsSchema.safeParse({
      ...dockerOptions(worktree),
      environmentAllowlist: ['SAFE_NAME', 'safe_name'],
    });
    expect(caseVariantDuplicates.success).toBe(process.platform !== 'win32');
  });

  it('rejects punctuation-wrapped traversal and host paths without rejecting web URLs', async () => {
    const worktree = await temporaryDirectory();

    await expect(
      planDockerAgentLaunch(
        preparedLaunch(worktree, {
          arguments: ['Review [../outside/secrets.txt] before continuing.'],
        }),
        dockerOptions(worktree),
      ),
    ).rejects.toThrow('path traversal');
    await expect(
      planDockerAgentLaunch(
        preparedLaunch(worktree, {
          arguments: ['Read {/etc/passwd} before continuing.'],
        }),
        dockerOptions(worktree),
      ),
    ).rejects.toThrow('unsupported host path');
    await expect(
      planDockerAgentLaunch(
        preparedLaunch(worktree, {
          arguments: ['Read <C:\\Users\\someone\\.ssh\\config> before continuing.'],
        }),
        dockerOptions(worktree),
      ),
    ).rejects.toThrow('Windows host path');

    await expect(
      planDockerAgentLaunch(
        preparedLaunch(worktree, {
          arguments: ['Review https://example.test/docs/v1.2/path?q=../literal safely.'],
        }),
        dockerOptions(worktree),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects traversal, foreign attachments, unsupported paths, and symlink escape', async () => {
    const root = await temporaryDirectory();
    const worktree = path.join(root, 'worktree');
    const outside = path.join(root, 'outside');
    await mkdir(worktree);
    await mkdir(outside);
    const outsideFile = path.join(outside, 'foreign.txt');
    await writeFile(outsideFile, 'foreign\n');

    await expect(
      planDockerAgentLaunch(
        preparedLaunch(worktree, { arguments: ['../outside/foreign.txt'] }),
        dockerOptions(worktree),
      ),
    ).rejects.toThrow('escapes the assigned worktree');
    await expect(
      planDockerAgentLaunch(
        preparedLaunch(worktree, { arguments: [`--file=${outsideFile}`] }),
        dockerOptions(worktree),
      ),
    ).rejects.toThrow('escapes the assigned worktree');

    if (process.platform === 'win32') {
      const insideFile = path.join(worktree, 'inside.txt');
      await writeFile(insideFile, 'inside\n');
      const insidePlan = await planDockerAgentLaunch(
        preparedLaunch(worktree, { arguments: [`--file=${insideFile}`] }),
        dockerOptions(worktree),
      );
      expect(insidePlan.disclosure.arguments).toContain('--file=/workspace/inside.txt');
    }
    await expect(
      planDockerAgentLaunch(
        preparedLaunch(worktree, {
          attachments: [{ path: outsideFile, kind: 'file', explicitlyApproved: true }],
        }),
        dockerOptions(worktree),
      ),
    ).rejects.toThrow('escapes the assigned worktree');

    if (process.platform !== 'win32') {
      const link = path.join(worktree, 'linked-outside');
      await symlink(outside, link, 'dir');
      const worktreeAlias = path.join(root, 'worktree-alias');
      await symlink(worktree, worktreeAlias, 'dir');
      await expect(
        planDockerAgentLaunch(preparedLaunch(worktreeAlias), dockerOptions(worktreeAlias)),
      ).rejects.toThrow('non-symlink directory');
      await expect(
        planDockerAgentLaunch(
          preparedLaunch(worktree, { arguments: ['linked-outside/foreign.txt'] }),
          dockerOptions(worktree),
        ),
      ).rejects.toThrow('crosses a symbolic link');
      await expect(
        planDockerAgentLaunch(
          preparedLaunch(worktree, {
            arguments: ['Review linked-outside/foreign.txt before continuing.'],
          }),
          dockerOptions(worktree),
        ),
      ).rejects.toThrow('crosses a symbolic link');
      await expect(
        planDockerAgentLaunch(
          preparedLaunch(worktree, {
            attachments: [
              {
                path: path.join(link, 'foreign.txt'),
                kind: 'file',
                explicitlyApproved: true,
              },
            ],
          }),
          dockerOptions(worktree),
        ),
      ).rejects.toThrow('crosses a symbolic link');
    }
  });

  it('maps canonical Windows worktree paths without allowing drive or parent escape', () => {
    expect(
      mapWorktreePathToContainer(
        'C:\\Users\\Aydin\\Work Tree',
        'C:\\Users\\Aydin\\Work Tree\\src\\file.ts',
        'win32',
      ),
    ).toBe('/workspace/src/file.ts');
    expect(() =>
      mapWorktreePathToContainer('C:\\Users\\Aydin\\Work Tree', 'D:\\foreign\\file.ts', 'win32'),
    ).toThrow(DockerLaunchValidationError);
    expect(() =>
      mapWorktreePathToContainer(
        'C:\\Users\\Aydin\\Work Tree',
        'C:\\Users\\Aydin\\outside.ts',
        'win32',
      ),
    ).toThrow('escapes the assigned worktree');
  });

  it('detects an absolute Docker executable and verifies compatible local image metadata', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryDirectory();
    const executableDirectory = path.join(root, 'Docker CLI With Spaces');
    await mkdir(executableDirectory);
    const executable = path.join(executableDirectory, 'docker');
    await writeFile(
      executable,
      `#!/bin/sh
if [ "$1" = "version" ]; then
  printf '27.1.0'
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ] && [ "$3" = "local/test:1" ] && [ "$4" = "" ]; then
  printf '[{"Id":"sha256:abc123","Os":"linux","Architecture":"amd64","Config":{"Volumes":null}}]'
  exit 0
fi
exit 9
`,
    );
    await chmod(executable, 0o700);

    await expect(
      detectDockerRuntime({ dockerExecutable: executable, image: 'image;touch /tmp/bad' }),
    ).rejects.toThrow('CLI metacharacters');
    await expect(
      detectDockerRuntime({ dockerExecutable: 'docker', image: 'local/test:1' }),
    ).rejects.toThrow('must be absolute');

    const detection = await detectDockerRuntime({
      dockerExecutable: executable,
      image: 'local/test:1',
      timeoutMs: 2_000,
    });
    expect(detection).toMatchObject({
      executable,
      image: 'local/test:1',
      executableAvailable: true,
      daemonAvailable: true,
      imageAvailable: true,
      imageCompatible: true,
      available: true,
      daemonVersion: '27.1.0',
      imageId: 'sha256:abc123',
    });
  });

  it('keeps local images unavailable when inspect metadata declares volumes or is incompatible', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryDirectory();
    const executable = path.join(root, 'docker');
    await writeFile(
      executable,
      `#!/bin/sh
if [ "$1" = "version" ]; then
  printf '27.1.0'
  exit 0
fi
if [ "$1" != "image" ] || [ "$2" != "inspect" ] || [ "$4" != "" ]; then
  printf 'unexpected probe' >&2
  exit 19
fi
case "$3" in
  local/volumes:1)
    printf '[{"Id":"sha256:volumes","Os":"linux","Architecture":"amd64","Config":{"Volumes":{"/data":{},"/var/lib/tool":{}}}}]'
    ;;
  local/windows:1)
    printf '[{"Id":"sha256:windows","Os":"windows","Architecture":"amd64","Config":{"Volumes":null}}]'
    ;;
  local/malformed:1)
    printf '{not-json'
    ;;
  local/incomplete:1)
    printf '[{"Id":"sha256:incomplete","Os":"linux","Config":null}]'
    ;;
  local/missing:1)
    printf '\\033[31mmissing local image\\nsecond line' >&2
    exit 1
    ;;
  *)
    printf 'missing local image' >&2
    exit 1
    ;;
esac
`,
    );
    await chmod(executable, 0o700);

    const volumeDetection = await detectDockerRuntime({
      dockerExecutable: executable,
      image: 'local/volumes:1',
      timeoutMs: 2_000,
    });
    expect(volumeDetection).toMatchObject({
      executableAvailable: true,
      daemonAvailable: true,
      imageAvailable: true,
      imageCompatible: false,
      available: false,
    });
    expect(volumeDetection.reason).toContain('declares Docker volumes');
    expect(volumeDetection.reason).toContain('/data');

    const windowsDetection = await detectDockerRuntime({
      dockerExecutable: executable,
      image: 'local/windows:1',
      timeoutMs: 2_000,
    });
    expect(windowsDetection).toMatchObject({
      imageAvailable: true,
      imageCompatible: false,
      available: false,
    });
    expect(windowsDetection.reason).toContain('requires a Linux image');

    const malformedDetection = await detectDockerRuntime({
      dockerExecutable: executable,
      image: 'local/malformed:1',
      timeoutMs: 2_000,
    });
    expect(malformedDetection).toMatchObject({
      imageAvailable: true,
      imageCompatible: false,
      available: false,
    });
    expect(malformedDetection.reason).toBe(
      'Docker returned malformed metadata for the configured local image.',
    );

    const incompleteDetection = await detectDockerRuntime({
      dockerExecutable: executable,
      image: 'local/incomplete:1',
      timeoutMs: 2_000,
    });
    expect(incompleteDetection).toMatchObject({
      imageAvailable: true,
      imageCompatible: false,
      available: false,
    });
    expect(incompleteDetection.reason).toContain('metadata is incomplete');

    const missingDetection = await detectDockerRuntime({
      dockerExecutable: executable,
      image: 'local/missing:1',
      timeoutMs: 2_000,
    });
    expect(missingDetection).toMatchObject({
      imageAvailable: false,
      imageCompatible: false,
      available: false,
    });
    expect(missingDetection.reason).toContain('missing local image second line');
    expect(missingDetection.reason).not.toContain('\u001b');
    expect(missingDetection.reason).not.toContain('\r');
    expect(missingDetection.reason).not.toContain('\n');
  });
});
