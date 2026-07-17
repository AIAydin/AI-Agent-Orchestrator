import { GitEngineError } from '../model/errors.js';

const SAFE_REMOTE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_REPOSITORY_PART = /^(?=.{1,100}$)[a-zA-Z0-9_.-]+$/u;
const MAX_REMOTE_URL = 2_048;

export interface GitHubRemoteIdentity {
  readonly remote: string;
  readonly remoteUrl: string;
  readonly hostname: string;
  readonly ownerRepository: string;
}

export function parseGitHubRemoteIdentity(
  remoteName: string,
  remoteUrlValue: string,
): GitHubRemoteIdentity {
  if (!SAFE_REMOTE_NAME.test(remoteName)) {
    throw invalid('The selected Git remote name is not safe.');
  }
  const remoteUrl = boundedSingleLine(remoteUrlValue, 'Git remote URL', MAX_REMOTE_URL);
  const scp = /^(?:([^@/:\s]+)@)?([^/:\s]+):([^\s]+)$/u.exec(remoteUrl);
  if (scp !== null && !remoteUrl.includes('://')) {
    const username = scp[1];
    const hostname = normalizedHost(scp[2] ?? '');
    if (username !== undefined && username !== 'git') {
      throw invalid('GitHub SSH remotes may use only the standard git account name.');
    }
    const ownerRepository = normalizedOwnerRepository(scp[3] ?? '');
    return {
      remote: remoteName,
      remoteUrl: `ssh://${hostname}/${ownerRepository}.git`,
      hostname,
      ownerRepository,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch (error) {
    throw new GitEngineError(
      'INVALID_ARGUMENT',
      'The selected remote is not a supported GitHub URL.',
      {},
      { cause: error },
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
    throw invalid('GitHub integration accepts only HTTPS or SSH remotes.');
  }
  if (
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.port !== '' ||
    (parsed.username !== '' && !(parsed.protocol === 'ssh:' && parsed.username === 'git'))
  ) {
    throw invalid(
      'GitHub remote URLs containing credentials, query values, or fragments are not accepted.',
    );
  }
  const hostname = normalizedHost(parsed.hostname);
  const ownerRepository = normalizedOwnerRepository(parsed.pathname);
  return {
    remote: remoteName,
    remoteUrl: `${parsed.protocol}//${hostname}/${ownerRepository}.git`,
    hostname,
    ownerRepository,
  };
}

export function assertGitHubRepositoryIdentity(
  expected: Pick<GitHubRemoteIdentity, 'hostname' | 'ownerRepository'>,
  ownerRepositoryValue: string,
  webUrlValue: string,
): { readonly ownerRepository: string; readonly url: string } {
  const ownerRepository = normalizedOwnerRepository(ownerRepositoryValue);
  if (ownerRepository.toLowerCase() !== expected.ownerRepository.toLowerCase()) {
    throw invalid('GitHub CLI returned a repository that does not match the selected remote.');
  }
  const webUrl = boundedSingleLine(webUrlValue, 'GitHub repository URL', MAX_REMOTE_URL);
  let parsed: URL;
  try {
    parsed = new URL(webUrl);
  } catch (error) {
    throw new GitEngineError(
      'COMMAND_FAILED',
      'GitHub CLI returned an invalid repository URL.',
      {},
      { cause: error },
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.port !== '' ||
    normalizedHost(parsed.hostname) !== expected.hostname
  ) {
    throw invalid(
      'GitHub CLI returned a repository URL outside the selected credential-free host.',
    );
  }
  const urlRepository = normalizedOwnerRepository(parsed.pathname);
  if (urlRepository.toLowerCase() !== expected.ownerRepository.toLowerCase()) {
    throw invalid('GitHub CLI returned a repository URL for another repository.');
  }
  return {
    ownerRepository: expected.ownerRepository,
    url: parsed.toString().replace(/\/$/u, ''),
  };
}

export function assertGitHubResultUrl(
  expected: Pick<GitHubRemoteIdentity, 'hostname' | 'ownerRepository'>,
  value: string,
  kind: 'pull-request' | 'workflow-run',
): string {
  const candidate = boundedSingleLine(value, 'GitHub result URL', MAX_REMOTE_URL);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error) {
    throw new GitEngineError(
      'COMMAND_FAILED',
      'GitHub CLI returned an invalid result URL.',
      {},
      { cause: error },
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.port !== '' ||
    normalizedHost(parsed.hostname) !== expected.hostname
  ) {
    throw invalid('GitHub CLI returned a result URL outside the selected credential-free host.');
  }
  const escapedRepository = expected.ownerRepository.split('/').map(escapeRegExp).join('/');
  const suffix = kind === 'pull-request' ? 'pull/[1-9][0-9]*' : 'actions/runs/[1-9][0-9]*';
  if (!new RegExp(`^/${escapedRepository}/${suffix}/?$`, 'iu').test(parsed.pathname)) {
    throw invalid('GitHub CLI returned a result URL for another repository or resource.');
  }
  return parsed.toString().replace(/\/$/u, '');
}

export function assertGitBranchName(value: string, label: string): string {
  const branch = boundedSingleLine(value, label, 1_024);
  if (
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.includes('[') ||
    /[~^:?*\\\s]/u.test(branch)
  ) {
    throw invalid(`${label} is not a safe Git branch name.`);
  }
  return branch;
}

function normalizedHost(value: string): string {
  const host = value.trim().toLowerCase();
  const labels = host.split('.');
  if (
    host.length < 1 ||
    host.length > 253 ||
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
    )
  ) {
    throw invalid('The selected GitHub remote hostname is invalid.');
  }
  return host;
}

function normalizedOwnerRepository(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\.git$/iu, '');
  const parts = normalized.split('/');
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !SAFE_REPOSITORY_PART.test(part) ||
        part === '.' ||
        part === '..' ||
        part.startsWith('.') ||
        part.endsWith('.'),
    )
  ) {
    throw invalid('GitHub remotes must identify exactly one bounded owner/repository.');
  }
  return `${parts[0]}/${parts[1]}`;
}

function boundedSingleLine(value: string, label: string, maximum: number): string {
  const bounded = value.trim();
  if (
    bounded.length < 1 ||
    bounded.length > maximum ||
    [...bounded].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  ) {
    throw invalid(`${label} must be a bounded single-line value.`);
  }
  return bounded;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function invalid(message: string): GitEngineError {
  return new GitEngineError('INVALID_ARGUMENT', message);
}
