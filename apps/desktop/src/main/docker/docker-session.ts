import path from 'node:path';

import { getBuiltInAgentManifest } from '@forgeboard/agent-adapters';

import type { AppSettings } from '../../shared/application/contracts.js';
import {
  DEFAULT_DOCKER_SESSION_IMAGE,
  DockerImageReferenceSchema,
} from '../../shared/docker/contracts.js';
import { builtInAgentSessionArguments } from '../../shared/terminal/index.js';
import {
  resolveDockerExecutable,
  runBoundedDockerCommand,
  type BeforeDockerCommand,
  type DockerCommandResult,
} from './docker-runtime.js';

/** The bind-mount target and working directory for every interactive Docker agent session. */
export const DOCKER_SESSION_WORKDIR = '/workspace';

const DEFAULT_SESSION_CHECK_TIMEOUT_MS = 5_000;
const MAX_SESSION_CHECK_OUTPUT = 16_384;
const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

/**
 * npm packages that install each built-in agent CLI. Inside the default image the CLI is not
 * preinstalled, so the session runs it through `npx --yes <package>`.
 */
const NPX_PACKAGE_BY_ADAPTER: Readonly<Record<string, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
  opencode: 'opencode-ai',
};

export interface DockerSessionRunInput {
  readonly containerName: string;
  readonly image: string;
  readonly worktreePath: string;
  readonly cpuLimit: number;
  readonly memoryMb: number;
  readonly command: readonly string[];
}

export interface DockerSessionLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export type DockerSessionCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
  maximumOutput: number,
  beforeCommand?: BeforeDockerCommand,
) => Promise<DockerCommandResult>;

export interface DockerSessionRuntimeOptions {
  readonly checkTimeoutMs?: number;
  readonly runCommand?: DockerSessionCommandRunner;
  readonly beforeCommand?: BeforeDockerCommand;
}

/**
 * The command that runs inside the session container. `null` means the adapter is not built in,
 * so no deterministic container command exists. The default image gets the CLI through npx; a
 * user-chosen image is expected to already have the CLI on its PATH.
 */
export function dockerSessionContainerCommand(
  adapterId: string,
  image: string,
  model: string | null | undefined,
): string[] | null {
  const manifest = getBuiltInAgentManifest(adapterId);
  const npxPackage = NPX_PACKAGE_BY_ADAPTER[adapterId];
  const sessionArguments = builtInAgentSessionArguments(adapterId, model, 'docker-isolated');
  if (manifest === undefined || npxPackage === undefined || sessionArguments === null) return null;
  return image === DEFAULT_DOCKER_SESSION_IMAGE
    ? ['npx', '--yes', npxPackage, ...sessionArguments]
    : [manifest.executable.command, ...sessionArguments];
}

/**
 * Exact `docker run` argv for one interactive agent session: a fresh named container with the
 * managed worktree bind-mounted at /workspace and nothing else shared from the host. Bridge
 * networking stays on because the agent CLI must reach its provider.
 */
export function dockerSessionRunArguments(input: DockerSessionRunInput): string[] {
  if (!CONTAINER_NAME_PATTERN.test(input.containerName)) {
    throw new Error('The Docker session container name is invalid.');
  }
  const image = DockerImageReferenceSchema.parse(input.image);
  if (!path.isAbsolute(input.worktreePath)) {
    throw new Error('The Docker session worktree path must be absolute.');
  }
  if (/[\0\r\n,]/u.test(input.worktreePath)) {
    throw new Error('The worktree path cannot be bind-mounted. Move it to a plainer path.');
  }
  if (
    !Number.isFinite(input.cpuLimit) ||
    input.cpuLimit <= 0 ||
    input.cpuLimit > 128 ||
    !Number.isInteger(input.memoryMb) ||
    input.memoryMb < 128 ||
    input.memoryMb > 1_048_576
  ) {
    throw new Error('The Docker CPU and memory limits are out of range. Fix them in Settings.');
  }
  if (input.command.length === 0 || input.command.some((argument) => /[\0]/u.test(argument))) {
    throw new Error('The Docker session command is invalid.');
  }
  return [
    'run',
    '--rm',
    '--interactive',
    '--tty',
    '--name',
    input.containerName,
    '--mount',
    `type=bind,source=${input.worktreePath},target=${DOCKER_SESSION_WORKDIR}`,
    '--workdir',
    DOCKER_SESSION_WORKDIR,
    '--cpus',
    String(input.cpuLimit),
    '--memory',
    `${String(input.memoryMb)}m`,
    '--network',
    'bridge',
    image,
    ...input.command,
  ];
}

/**
 * Verifies the daemon answers and the image exists locally, with bounded timeouts so a stuck
 * daemon becomes a terse error instead of a hung "Starting…" node. Never pulls.
 */
export async function ensureDockerSessionRuntime(
  executable: string,
  image: string,
  options: DockerSessionRuntimeOptions = {},
): Promise<void> {
  const runCommand = options.runCommand ?? runBoundedDockerCommand;
  const timeoutMs = options.checkTimeoutMs ?? DEFAULT_SESSION_CHECK_TIMEOUT_MS;
  const daemon = await runCommand(
    executable,
    ['version', '--format', '{{.Server.Version}}'],
    timeoutMs,
    MAX_SESSION_CHECK_OUTPUT,
    options.beforeCommand,
  );
  if (daemon.exitCode !== 0) {
    throw new Error("Docker isn't running. Start it and retry.");
  }
  const inspected = await runCommand(
    executable,
    ['image', 'inspect', '--format', '{{.Id}}', image],
    timeoutMs,
    MAX_SESSION_CHECK_OUTPUT,
    options.beforeCommand,
  );
  if (inspected.exitCode !== 0) {
    throw new Error(
      image === DEFAULT_DOCKER_SESSION_IMAGE
        ? `The default image ${image} isn't downloaded yet. Get it in Settings → Docker.`
        : `Image ${image} isn't available locally. Pull it in Settings → Docker.`,
    );
  }
}

/**
 * Resolves everything a Docker-isolated agent session needs: the docker CLI, a present image, and
 * the exact `docker run` argv. Every failure is a terse thrown error the agent node can show.
 */
export async function resolveDockerSessionLaunch(
  input: {
    readonly settings: Pick<
      AppSettings,
      | 'dockerEnabled'
      | 'dockerExecutable'
      | 'dockerImage'
      | 'dockerCpuLimit'
      | 'dockerMemoryMb'
      | 'dockerMountHostCredentials'
    >;
    readonly adapterId: string;
    readonly model: string | null;
    readonly worktreePath: string;
    readonly containerName: string;
  },
  options: DockerSessionRuntimeOptions = {},
): Promise<DockerSessionLaunch> {
  const { settings } = input;
  if (!settings.dockerEnabled) {
    throw new Error('Turn on Docker in Settings to use Docker isolated.');
  }
  if (settings.dockerMountHostCredentials) {
    throw new Error('Docker launches are blocked while host credentials sharing is on in Settings.');
  }
  const image = settings.dockerImage.trim() === '' ? DEFAULT_DOCKER_SESSION_IMAGE : settings.dockerImage.trim();
  const command = dockerSessionContainerCommand(input.adapterId, image, input.model);
  if (command === null) {
    throw new Error('Docker isolated supports the built-in agents only.');
  }
  const executable = await resolveDockerExecutable(settings.dockerExecutable);
  await ensureDockerSessionRuntime(executable, image, options);
  return {
    executable,
    arguments: dockerSessionRunArguments({
      containerName: input.containerName,
      image,
      worktreePath: input.worktreePath,
      cpuLimit: settings.dockerCpuLimit,
      memoryMb: settings.dockerMemoryMb,
      command,
    }),
  };
}
