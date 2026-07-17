import { lstat, stat, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { GitEngineError } from '../../model/errors.js';
import { RepositoryService } from '../service.js';
import type {
  GitConfiguredRemoteTargetState,
  GitLocalRepositoryIdentity,
  GitManagedRemoteTarget,
  GitRemoteTargetInput,
} from './contracts.js';

const MAX_REMOTE_NAME_CHARACTERS = 128;
const MAX_REMOTE_URL_CHARACTERS = 2_048;
const MAX_LOCAL_PATH_CHARACTERS = 32_768;

export interface ConfiguredRemoteTargetClassification {
  readonly state: GitConfiguredRemoteTargetState;
  readonly target: GitManagedRemoteTarget | null;
}

export function assertGitRemoteConfigurationName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_REMOTE_NAME_CHARACTERS ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) ||
    value.endsWith('.') ||
    value.toLowerCase().endsWith('.lock') ||
    value.includes('..')
  ) {
    throw invalid('Git remote names must be bounded, portable, and unambiguous.');
  }
}

export async function resolveGitRemoteTarget(
  input: GitRemoteTargetInput,
  repositories = new RepositoryService(),
): Promise<GitManagedRemoteTarget> {
  if (!isRecord(input)) throw invalid('Git remote target input is invalid.');
  if (input.kind === 'network') {
    assertExactKeys(input, ['kind', 'url']);
    if (typeof input.url !== 'string') throw invalid('Git remote target input is invalid.');
    return parseNetworkTarget(input.url);
  }
  if (input.kind !== 'local-filesystem') throw invalid('Git remote target input is invalid.');
  assertExactKeys(input, ['kind', 'path']);
  if (typeof input.path !== 'string') throw invalid('Git remote target input is invalid.');
  const candidate = boundedExactValue(
    input.path,
    'Local Git destination',
    MAX_LOCAL_PATH_CHARACTERS,
  );
  if (!isNativeAbsolutePath(candidate)) {
    throw invalid('Local Git destinations must use a native absolute path selected in the UI.');
  }
  if (isNetworkShare(candidate)) {
    throw invalid('Network-share paths are not accepted as local Git destinations.');
  }
  let canonical: string;
  try {
    canonical = await realpath(candidate);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new GitEngineError(
      'INVALID_ARGUMENT',
      'The selected local Git destination is unavailable or is not a directory.',
      {},
      { cause: error },
    );
  }
  return await resolveLocalRepositoryTarget(repositories, canonical);
}

export function classifyConfiguredRemoteTarget(
  repositoryRoot: string,
  urls: readonly string[],
): ConfiguredRemoteTargetClassification {
  if (urls.length === 0) return { state: 'missing-url', target: null };
  if (urls.length !== 1) return { state: 'multiple-urls', target: null };
  const value = urls[0];
  if (value === undefined) return { state: 'missing-url', target: null };
  try {
    return {
      state: 'supported',
      target: parseConfiguredTarget(repositoryRoot, value),
    };
  } catch {
    return {
      state: containsEmbeddedCredentials(value) ? 'embedded-credentials' : 'unsupported',
      target: null,
    };
  }
}

function parseConfiguredTarget(repositoryRoot: string, value: string): GitManagedRemoteTarget {
  const exact = boundedExactValue(value, 'Configured Git remote', MAX_REMOTE_URL_CHARACTERS);
  if (exact.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(exact);
    } catch (error) {
      throw invalid('The configured Git remote target is invalid.', error);
    }
    if (parsed.protocol === 'file:') {
      if (
        parsed.hostname !== '' ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.search !== '' ||
        parsed.hash !== ''
      ) {
        throw invalid('Hosted or credential-bearing file remotes are unsupported.');
      }
      let localPath: string;
      try {
        localPath = fileURLToPath(parsed);
      } catch (error) {
        throw invalid('The configured local Git target is invalid.', error);
      }
      if (isNetworkShare(localPath)) throw invalid('Network-share Git targets are unsupported.');
      return localTarget(exact, path.resolve(localPath));
    }
    return parseNetworkTarget(exact);
  }
  if (path.isAbsolute(exact)) {
    if (isNetworkShare(exact)) throw invalid('Network-share Git targets are unsupported.');
    return localTarget(exact, path.resolve(exact));
  }
  if (path.win32.isAbsolute(exact) || /^[A-Za-z]:/u.test(exact) || isNetworkShare(exact)) {
    throw invalid('The configured local Git target is unsupported on this platform.');
  }
  if (looksLikeScpTarget(exact)) return parseNetworkTarget(exact);
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/u.test(exact)) {
    throw invalid('Custom Git remote helpers are unsupported.');
  }
  return localTarget(exact, path.resolve(repositoryRoot, exact));
}

function parseNetworkTarget(value: string): GitManagedRemoteTarget {
  const exact = boundedExactValue(value, 'Network Git destination', MAX_REMOTE_URL_CHARACTERS);
  if (exact.includes('%') || /[\s\\]/u.test(exact)) {
    throw invalid(
      'Encoded, whitespace-bearing, or backslash network destinations are unsupported.',
    );
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/u.test(exact)) {
    throw invalid('Custom Git remote helpers are unsupported.');
  }
  if (!exact.includes('://')) return parseScpTarget(exact);

  let parsed: URL;
  try {
    parsed = new URL(exact);
  } catch (error) {
    throw invalid('The network Git destination is invalid.', error);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
    throw invalid('Only credential-free HTTPS and SSH Git destinations are supported.');
  }
  if (
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.username !== '' && !(parsed.protocol === 'ssh:' && parsed.username === 'git'))
  ) {
    throw invalid('Credential-bearing or parameterized Git destinations are unsupported.');
  }
  const hostname = normalizedHost(parsed.hostname);
  const endpoint = parsed.port === '' ? hostname : `${hostname}:${validatedPort(parsed.port)}`;
  const resource = normalizedResource(parsed.pathname);
  return {
    kind: 'network',
    exactUrl: exact,
    transport: parsed.protocol === 'https:' ? 'https' : 'ssh',
    endpoint,
    resource,
  };
}

function parseScpTarget(value: string): GitManagedRemoteTarget {
  if (path.win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw invalid('A native path cannot be used as a network Git destination.');
  }
  const match = /^(?:([^@/:\s]+)@)?([^/:\s]+):(.+)$/u.exec(value);
  if (match === null) throw invalid('The network Git destination is invalid.');
  const username = match[1];
  if (username !== undefined && username !== 'git') {
    throw invalid('SSH Git destinations may use only the standard git account name.');
  }
  return {
    kind: 'network',
    exactUrl: value,
    transport: 'ssh',
    endpoint: normalizedHost(match[2] ?? ''),
    resource: normalizedResource(match[3] ?? ''),
  };
}

function normalizedHost(value: string): string {
  const hostname = value.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    if (isIP(hostname.slice(1, -1)) !== 6) throw invalid('The Git destination host is invalid.');
    return hostname;
  }
  if (isIP(hostname) === 4) return hostname;
  const labels = hostname.split('.');
  if (
    hostname.length < 1 ||
    hostname.length > 253 ||
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
    )
  ) {
    throw invalid('The Git destination host is invalid.');
  }
  return hostname;
}

function validatedPort(value: string): string {
  if (!/^[0-9]{1,5}$/u.test(value)) throw invalid('The Git destination port is invalid.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw invalid('The Git destination port is invalid.');
  }
  return String(port);
}

function normalizedResource(value: string): string {
  const resource = boundedExactValue(
    value,
    'Git destination resource',
    MAX_REMOTE_URL_CHARACTERS,
  ).replace(/^\/+|\/+$/gu, '');
  if (
    resource === '' ||
    resource.startsWith('-') ||
    resource.includes('//') ||
    resource.includes('\\') ||
    resource.includes('@') ||
    resource.includes('?') ||
    resource.includes('#') ||
    resource.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw invalid('The Git destination resource is invalid.');
  }
  return resource;
}

async function resolveLocalRepositoryTarget(
  repositories: RepositoryService,
  selectedPath: string,
): Promise<GitManagedRemoteTarget> {
  const bareResult = await repositories.git.run(
    ['-C', selectedPath, 'rev-parse', '--is-bare-repository'],
    { allowNonZeroExit: true },
  );
  const repositoryKind = bareResult.stdout.trim();
  if (bareResult.exitCode !== 0 || (repositoryKind !== 'true' && repositoryKind !== 'false')) {
    throw invalid('The selected local Git destination is not a Git repository.');
  }
  const bare = repositoryKind === 'true';
  const [rootResult, commonResult] = await Promise.all([
    repositories.git.run([
      '-C',
      selectedPath,
      'rev-parse',
      '--path-format=absolute',
      bare ? '--git-dir' : '--show-toplevel',
    ]),
    repositories.git.run([
      '-C',
      selectedPath,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]),
  ]);
  let repositoryRoot: string;
  let commonDirectory: string;
  try {
    [repositoryRoot, commonDirectory] = await Promise.all([
      realpath(rootResult.stdout.trim()),
      realpath(commonResult.stdout.trim()),
    ]);
    const [rootStats, commonStats] = await Promise.all([
      lstat(repositoryRoot, { bigint: true }),
      lstat(commonDirectory, { bigint: true }),
    ]);
    if (!rootStats.isDirectory() || !commonStats.isDirectory()) throw new Error('not directories');
    const identity: GitLocalRepositoryIdentity = {
      repositoryKind: bare ? 'bare' : 'worktree',
      repositoryRoot,
      repositoryRootDevice: rootStats.dev.toString(),
      repositoryRootInode: rootStats.ino.toString(),
      commonDirectory,
      commonDirectoryDevice: commonStats.dev.toString(),
      commonDirectoryInode: commonStats.ino.toString(),
    };
    return localTarget(repositoryRoot, repositoryRoot, identity);
  } catch (error) {
    throw new GitEngineError(
      'INVALID_ARGUMENT',
      'The selected local Git destination identity is unavailable.',
      {},
      { cause: error },
    );
  }
}

function localTarget(
  exactUrl: string,
  resolvedPath: string,
  repositoryIdentity?: GitLocalRepositoryIdentity,
): GitManagedRemoteTarget {
  const resource = boundedExactValue(
    resolvedPath,
    'Local Git destination',
    MAX_LOCAL_PATH_CHARACTERS,
  );
  if (!path.isAbsolute(resource) || isNetworkShare(resource)) {
    throw invalid('The local Git destination is invalid.');
  }
  return {
    kind: 'local-filesystem',
    exactUrl,
    transport: 'local',
    endpoint: 'local-filesystem',
    resource,
    ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
  };
}

function looksLikeScpTarget(value: string): boolean {
  return /^(?:[^@/:\s]+@)?[^/:\s]+:.+$/u.test(value);
}

function containsEmbeddedCredentials(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/iu.test(value)) return true;
  const scp = /^([^@/:\s]+)@[^/:\s]+:/u.exec(value);
  return scp !== null && scp[1] !== 'git';
}

function boundedExactValue(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  ) {
    throw invalid(`${label} must be a bounded exact single-line value.`);
  }
  return value;
}

function isNetworkShare(value: string): boolean {
  return value.startsWith('\\\\') || value.startsWith('//');
}

function isNativeAbsolutePath(value: string): boolean {
  if (process.platform === 'win32') {
    return path.win32.isAbsolute(value) && /^[A-Za-z]:[\\/]/u.test(value);
  }
  return path.posix.isAbsolute(value) && !/^[A-Za-z]:[\\/]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw invalid('Git remote target input contains unsupported fields.');
  }
}

function invalid(message: string, cause?: unknown): GitEngineError {
  return new GitEngineError(
    'INVALID_ARGUMENT',
    message,
    {},
    cause === undefined ? undefined : { cause },
  );
}
