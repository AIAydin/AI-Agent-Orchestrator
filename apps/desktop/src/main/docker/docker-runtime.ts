import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';

import { detectDockerRuntime } from '@forgeboard/agent-adapters';

import {
  DockerImageReferenceSchema,
  DockerLocalListSchema,
  DockerReadinessInputSchema,
  DockerReadinessSchema,
  type DockerLocalContainer,
  type DockerLocalImage,
  type DockerLocalList,
  type DockerReadiness,
  type DockerReadinessInput,
  type DockerReadinessStatus,
} from '../../shared/docker/contracts.js';

const DEFAULT_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_PULL_TIMEOUT_MS = 10 * 60_000;
const MAX_CHECK_OUTPUT = 16_384;
const MAX_PULL_OUTPUT = 131_072;
const MAX_LIST_OUTPUT = 262_144;
const MAX_LOCAL_LIST_ENTRIES = 256;

export interface DockerCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  reason?: string;
}

type CommandResult = DockerCommandResult;

interface RuntimeLimits {
  checkTimeoutMs?: number;
  pullTimeoutMs?: number;
  probeContainerName?: string;
}

export type BeforeDockerCommand = () => void | Promise<void>;

export interface DockerPullExecution {
  executable: string;
  image: string;
  output: string;
}

export async function resolveDockerExecutable(configured: string): Promise<string> {
  const command = configured.trim();
  if (command === '' || command.includes('\0') || /[\r\n]/u.test(command)) {
    throw new Error('The Docker executable setting is invalid.');
  }
  if (path.isAbsolute(command)) {
    const canonical = await realpath(command);
    if (process.platform !== 'win32') await access(canonical, fsConstants.X_OK);
    return canonical;
  }
  if (command.includes('/') || command.includes('\\')) {
    throw new Error(
      'Choose the full path to the Docker executable or a command name such as docker.',
    );
  }

  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(
        directory,
        process.platform === 'win32' && path.extname(command) === ''
          ? `${command}${extension}`
          : command,
      );
      try {
        const canonical = await realpath(candidate);
        if (process.platform !== 'win32') await access(canonical, fsConstants.X_OK);
        return canonical;
      } catch {
        // Keep searching the configured PATH without invoking a shell.
      }
    }
  }
  throw new Error('Docker was not found. Choose its executable in Settings.');
}

export async function checkDockerReadiness(
  input: DockerReadinessInput,
  limits: RuntimeLimits = {},
  beforeCommand?: BeforeDockerCommand,
): Promise<DockerReadiness> {
  const configuration = DockerReadinessInputSchema.parse(input);
  const checkedAt = new Date().toISOString();
  let executable: string;
  try {
    executable = await resolveDockerExecutable(configuration.dockerExecutable);
  } catch (error) {
    return readinessResult(configuration, {
      executable: configuration.dockerExecutable,
      checkedAt,
      status: 'executable-unavailable',
      reason: safeText(error instanceof Error ? error.message : String(error)),
    });
  }

  const runtime = await detectDockerRuntime(
    {
      dockerExecutable: executable,
      image: configuration.image,
      timeoutMs: boundedTimeout(limits.checkTimeoutMs, DEFAULT_CHECK_TIMEOUT_MS, 100, 30_000),
    },
    beforeCommand === undefined ? {} : { beforeProbe: beforeCommand },
  );
  if (!runtime.available) {
    return readinessResult(configuration, {
      executable,
      checkedAt: runtime.checkedAt,
      executableAvailable: runtime.executableAvailable,
      daemonAvailable: runtime.daemonAvailable,
      imageAvailable: runtime.imageAvailable,
      imageCompatible: runtime.imageCompatible,
      status: runtimeStatus(runtime),
      ...(runtime.daemonVersion === undefined ? {} : { daemonVersion: runtime.daemonVersion }),
      ...(runtime.imageId === undefined ? {} : { imageId: runtime.imageId }),
      reason: safeText(runtime.reason ?? 'Docker readiness check failed.'),
    });
  }

  const containerName = limits.probeContainerName ?? `forgeboard-readiness-${randomUUID()}`;
  const probe = await runBoundedDockerCommand(
    executable,
    [
      'run',
      '--rm',
      '--pull',
      'never',
      '--name',
      containerName,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '32',
      '--memory',
      '256m',
      '--cpus',
      '0.5',
      '--user',
      '65534:65534',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=16m',
      '--entrypoint',
      configuration.containerExecutable,
      configuration.image,
      '--version',
    ],
    boundedTimeout(limits.checkTimeoutMs, DEFAULT_CHECK_TIMEOUT_MS, 100, 30_000),
    MAX_CHECK_OUTPUT,
    beforeCommand,
  );
  if (probe.timedOut) await removeProbeContainer(executable, containerName, beforeCommand);

  const version = safeText([probe.stdout, probe.stderr].filter(Boolean).join(' '), 2_048);
  if (probe.exitCode !== 0) {
    const detail =
      probe.reason ?? (version || `The version check exited with code ${String(probe.exitCode)}.`);
    return readinessResult(configuration, {
      executable,
      checkedAt,
      executableAvailable: true,
      daemonAvailable: true,
      imageAvailable: true,
      imageCompatible: true,
      status: 'agent-unavailable',
      daemonVersion: runtime.daemonVersion,
      imageId: runtime.imageId,
      reason: `The configured agent program could not start inside the image: ${safeText(detail)}`,
    });
  }

  return readinessResult(configuration, {
    executable,
    checkedAt,
    executableAvailable: true,
    daemonAvailable: true,
    imageAvailable: true,
    imageCompatible: true,
    containerExecutableAvailable: true,
    available: true,
    status: 'ready',
    daemonVersion: runtime.daemonVersion,
    imageId: runtime.imageId,
    ...(version === '' ? {} : { agentVersion: version }),
  });
}

export async function pullDockerImage(
  input: DockerReadinessInput,
  limits: RuntimeLimits = {},
  beforeCommand?: BeforeDockerCommand,
): Promise<DockerPullExecution> {
  const configuration = DockerReadinessInputSchema.parse(input);
  const executable = await resolveDockerExecutable(configuration.dockerExecutable);
  const result = await runBoundedDockerCommand(
    executable,
    ['pull', configuration.image],
    boundedTimeout(limits.pullTimeoutMs, DEFAULT_PULL_TIMEOUT_MS, 1_000, DEFAULT_PULL_TIMEOUT_MS),
    MAX_PULL_OUTPUT,
    beforeCommand,
  );
  if (result.exitCode !== 0) {
    const detail = result.reason ?? safeText([result.stderr, result.stdout].join(' '));
    throw new Error(
      `Docker could not pull ${configuration.image}: ${detail || `exit ${String(result.exitCode)}`}`,
    );
  }
  return {
    executable,
    image: configuration.image,
    output: safeText([result.stdout, result.stderr].filter(Boolean).join(' '), MAX_PULL_OUTPUT),
  };
}

/**
 * Enumerates local images and containers for the Settings picker. Read-only: it never starts a
 * container or reaches the network, so an unavailable daemon degrades to an empty, reasoned list.
 */
export async function listLocalDocker(
  configuredExecutable: string,
  limits: RuntimeLimits = {},
  beforeCommand?: BeforeDockerCommand,
): Promise<DockerLocalList> {
  const timeoutMs = boundedTimeout(limits.checkTimeoutMs, DEFAULT_CHECK_TIMEOUT_MS, 100, 30_000);
  let executable: string;
  try {
    executable = await resolveDockerExecutable(configuredExecutable);
  } catch (error) {
    return unavailableLocalList(error);
  }
  const images = await runBoundedDockerCommand(
    executable,
    ['images', '--format', '{{json .}}'],
    timeoutMs,
    MAX_LIST_OUTPUT,
    beforeCommand,
  );
  if (images.exitCode !== 0) {
    const detail = images.reason ?? safeText(images.stderr);
    return unavailableLocalList(
      new Error(detail === '' ? 'Docker is not running. Start it and sync again.' : detail),
    );
  }
  const containers = await runBoundedDockerCommand(
    executable,
    ['ps', '--all', '--format', '{{json .}}'],
    timeoutMs,
    MAX_LIST_OUTPUT,
    beforeCommand,
  );
  return DockerLocalListSchema.parse({
    daemonAvailable: true,
    images: parseDockerImageListOutput(images.stdout),
    containers: containers.exitCode === 0 ? parseDockerContainerListOutput(containers.stdout) : [],
  });
}

/** Parses `docker images --format '{{json .}}'` lines, skipping untagged or malformed rows. */
export function parseDockerImageListOutput(output: string): DockerLocalImage[] {
  const images: DockerLocalImage[] = [];
  const seen = new Set<string>();
  for (const row of jsonLines(output)) {
    if (images.length >= MAX_LOCAL_LIST_ENTRIES) break;
    const repository = typeof row['Repository'] === 'string' ? row['Repository'] : '';
    const tag = typeof row['Tag'] === 'string' ? row['Tag'] : '';
    if (repository === '' || repository === '<none>' || tag === '' || tag === '<none>') continue;
    const reference = DockerImageReferenceSchema.safeParse(`${repository}:${tag}`);
    if (!reference.success || seen.has(reference.data)) continue;
    seen.add(reference.data);
    const id = typeof row['ID'] === 'string' ? safeText(row['ID'], 512) : '';
    images.push({ reference: reference.data, ...(id === '' ? {} : { imageId: id }) });
  }
  return images;
}

/** Parses `docker ps --all --format '{{json .}}'` lines, skipping malformed rows. */
export function parseDockerContainerListOutput(output: string): DockerLocalContainer[] {
  const containers: DockerLocalContainer[] = [];
  for (const row of jsonLines(output)) {
    if (containers.length >= MAX_LOCAL_LIST_ENTRIES) break;
    const name = typeof row['Names'] === 'string' ? safeText(row['Names'], 256) : '';
    const state = typeof row['State'] === 'string' ? safeText(row['State'], 64) : '';
    const image = DockerImageReferenceSchema.safeParse(
      typeof row['Image'] === 'string' ? row['Image'] : '',
    );
    if (name === '' || state === '' || !image.success) continue;
    containers.push({ name, image: image.data, state });
  }
  return containers;
}

function jsonLines(output: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A truncated or non-JSON line is skipped rather than failing the whole listing.
    }
  }
  return rows;
}

function unavailableLocalList(error: unknown): DockerLocalList {
  const reason = safeText(error instanceof Error ? error.message : String(error));
  return DockerLocalListSchema.parse({
    daemonAvailable: false,
    images: [],
    containers: [],
    ...(reason === '' ? {} : { reason }),
  });
}

function readinessResult(
  configuration: DockerReadinessInput,
  values: Partial<DockerReadiness> & Pick<DockerReadiness, 'executable' | 'checkedAt' | 'status'>,
): DockerReadiness {
  return DockerReadinessSchema.parse({
    executable: values.executable,
    image: configuration.image,
    containerExecutable: configuration.containerExecutable,
    executableAvailable: values.executableAvailable ?? false,
    daemonAvailable: values.daemonAvailable ?? false,
    imageAvailable: values.imageAvailable ?? false,
    imageCompatible: values.imageCompatible ?? false,
    containerExecutableAvailable: values.containerExecutableAvailable ?? false,
    available: values.available ?? false,
    status: values.status,
    checkedAt: values.checkedAt,
    ...(values.daemonVersion === undefined ? {} : { daemonVersion: values.daemonVersion }),
    ...(values.imageId === undefined ? {} : { imageId: values.imageId }),
    ...(values.agentVersion === undefined ? {} : { agentVersion: values.agentVersion }),
    ...(values.reason === undefined ? {} : { reason: values.reason }),
  });
}

function runtimeStatus(runtime: {
  executableAvailable: boolean;
  daemonAvailable: boolean;
  imageAvailable: boolean;
  imageCompatible: boolean;
}): DockerReadinessStatus {
  if (!runtime.executableAvailable) return 'executable-unavailable';
  if (!runtime.daemonAvailable) return 'daemon-unavailable';
  if (!runtime.imageAvailable) return 'image-missing';
  return runtime.imageCompatible ? 'agent-unavailable' : 'image-incompatible';
}

async function removeProbeContainer(
  executable: string,
  name: string,
  beforeCommand?: BeforeDockerCommand,
): Promise<void> {
  await runBoundedDockerCommand(executable, ['rm', '--force', name], 2_000, 2_048, beforeCommand).catch(
    () => undefined,
  );
}

export async function runBoundedDockerCommand(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
  maximumOutput: number,
  beforeCommand?: BeforeDockerCommand,
): Promise<DockerCommandResult> {
  await beforeCommand?.();
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const environment: NodeJS.ProcessEnv = {};
    if (process.platform === 'win32' && process.env['SYSTEMROOT'] !== undefined) {
      environment['SYSTEMROOT'] = process.env['SYSTEMROOT'];
    }
    const child = spawn(executable, [...arguments_], {
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut: true,
        reason: 'The Docker command took too long and was stopped.',
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maximumOutput) {
        stdout += chunk.toString('utf8').slice(0, maximumOutput - stdout.length);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maximumOutput) {
        stderr += chunk.toString('utf8').slice(0, maximumOutput - stderr.length);
      }
    });
    child.on('error', (error) =>
      finish({ exitCode: null, stdout, stderr, timedOut: false, reason: error.message }),
    );
    child.on('close', (exitCode) => finish({ exitCode, stdout, stderr, timedOut: false }));
  });
}

function boundedTimeout(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return value === undefined ? fallback : Math.max(minimum, Math.min(maximum, value));
}

function safeText(value: string, maximumLength = 4_096): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximumLength);
}
