import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GitEngineError } from '../model/errors.js';
import type { ExactPushDestination } from '../model/types.js';
import type { GitExecutor } from './executor.js';

const REPOSITORY_PUSH_OVERRIDE_PATTERN =
  '^(credential\\.|http\\.|url\\..*\\.(insteadof|pushinsteadof)$)';
const PUSH_URL_REWRITE_PATTERN = '^url\\..*\\.(insteadof|pushinsteadof)$';
const MAX_REMOTE_URL_BYTES = 2_048;
const MAX_URL_REWRITE_RULES = 256;
const MAX_REMOTE_CONFIG_KEYS = 1_024;

/** Rejects repository-owned configuration that can alter push identity, routing, or credentials. */
export async function assertNoRepositoryPushOverrides(
  git: GitExecutor,
  repositoryPath: string,
): Promise<void> {
  const local = await repositoryOverrideQuery(
    git,
    repositoryPath,
    '--local',
    REPOSITORY_PUSH_OVERRIDE_PATTERN,
  );
  const worktreeConfig = await git.run(
    [
      '-C',
      repositoryPath,
      'config',
      '--local',
      '--includes',
      '--type=bool',
      '--get',
      'extensions.worktreeConfig',
    ],
    { allowNonZeroExit: true, maxOutputBytes: 1_024 },
  );
  if (worktreeConfig.exitCode !== 0 && worktreeConfig.exitCode !== 1) {
    throw pushConfigVerificationError();
  }
  const worktreeEnabled = worktreeConfig.exitCode === 0 && worktreeConfig.stdout.trim() === 'true';
  if (
    worktreeConfig.exitCode === 0 &&
    worktreeConfig.stdout.trim() !== 'true' &&
    worktreeConfig.stdout.trim() !== 'false'
  ) {
    throw pushConfigVerificationError();
  }
  const worktree = worktreeEnabled
    ? await repositoryOverrideQuery(
        git,
        repositoryPath,
        '--worktree',
        REPOSITORY_PUSH_OVERRIDE_PATTERN,
      )
    : null;
  const results = worktree === null ? [local] : [local, worktree];
  if (results.some((result) => result.exitCode !== 0 && result.exitCode !== 1)) {
    throw pushConfigVerificationError();
  }
  if (results.some((result) => result.exitCode === 0)) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'Repository-owned credential, HTTP, and URL rewrite settings are unsupported for exact pushes.',
    );
  }
}

async function repositoryOverrideQuery(
  git: GitExecutor,
  repositoryPath: string,
  scope: '--local' | '--worktree',
  pattern: string,
) {
  return await git.run(
    ['-C', repositoryPath, 'config', scope, '--includes', '--name-only', '--get-regexp', pattern],
    { allowNonZeroExit: true, maxOutputBytes: 64 * 1_024 },
  );
}

function pushConfigVerificationError(): GitEngineError {
  return new GitEngineError(
    'APPROVAL_MISMATCH',
    'Forgeboard could not verify repository-owned push transport configuration.',
  );
}

/** Reads the one exact effective push URL without trimming or disclosing it in failures. */
export async function readExactRemotePushUrl(
  git: GitExecutor,
  repositoryPath: string,
  remoteName: string,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(remoteName)) {
    throw new GitEngineError('INVALID_ARGUMENT', 'Remote name is not safe.');
  }
  const result = await git.run(
    ['-C', repositoryPath, 'remote', 'get-url', '--push', '--all', remoteName],
    { allowNonZeroExit: true, maxOutputBytes: 2 * (MAX_REMOTE_URL_BYTES + 1) },
  );
  if (result.exitCode !== 0 || !result.stdout.endsWith('\n')) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'Forgeboard could not resolve one exact push destination for the selected remote.',
    );
  }
  const records = result.stdout.slice(0, -1).split('\n');
  if (records.length !== 1) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'The selected Git remote does not have exactly one push destination.',
    );
  }
  return boundedExactValue(records[0] ?? '', 'Git push destination');
}

/** Converts an exact effective remote URL into an unambiguous literal native push target. */
export function exactPushDestination(
  effectiveUrl: string,
  repositoryPath: string,
): ExactPushDestination {
  const expectedRemoteUrl = boundedExactValue(effectiveUrl, 'Git push destination');
  if (expectedRemoteUrl.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(expectedRemoteUrl);
    } catch (error) {
      throw invalidDestination(error);
    }
    if (
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      (parsed.username !== '' && !(parsed.protocol === 'ssh:' && parsed.username === 'git'))
    ) {
      throw invalidDestination();
    }
    if (parsed.protocol === 'file:') {
      if (parsed.hostname !== '') throw invalidDestination();
      let literal: string;
      try {
        literal = fileURLToPath(parsed);
      } catch (error) {
        throw invalidDestination(error);
      }
      return localPushDestination(expectedRemoteUrl, literal);
    }
    if (expectedRemoteUrl.includes('%')) throw invalidDestination();
    if (parsed.hostname === '' || (parsed.protocol !== 'ssh:' && parsed.protocol !== 'https:')) {
      throw invalidDestination();
    }
    if (!parsed.hostname.startsWith('[')) assertDnsHost(parsed.hostname);
    assertNetworkResource(parsed.pathname);
    return {
      expectedRemoteUrl,
      pushTarget: expectedRemoteUrl,
      protocol: parsed.protocol === 'ssh:' ? 'ssh' : 'https',
    };
  }
  if (isNetworkSharePath(expectedRemoteUrl)) throw invalidDestination();
  if (path.isAbsolute(expectedRemoteUrl)) {
    return localPushDestination(expectedRemoteUrl, expectedRemoteUrl);
  }
  if (path.win32.isAbsolute(expectedRemoteUrl)) throw invalidDestination();
  if (/^[A-Za-z]:/u.test(expectedRemoteUrl)) throw invalidDestination();
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/u.test(expectedRemoteUrl)) throw invalidDestination();
  const scp = /^(?:([^@/:\s]+)@)?([^/:\s]+):(.+)$/u.exec(expectedRemoteUrl);
  if (scp !== null) {
    if (scp[1] !== undefined && scp[1] !== 'git') throw invalidDestination();
    assertDnsHost(scp[2] ?? '');
    assertNetworkResource(scp[3] ?? '');
    return { expectedRemoteUrl, pushTarget: expectedRemoteUrl, protocol: 'ssh' };
  }
  return localPushDestination(expectedRemoteUrl, path.resolve(repositoryPath, expectedRemoteUrl));
}

/** Re-derives and compares every native-only exact destination field. */
export function assertExactPushDestination(
  approved: ExactPushDestination,
  currentEffectiveUrl: string,
  repositoryPath: string,
): void {
  const current = exactPushDestination(currentEffectiveUrl, repositoryPath);
  if (
    approved.expectedRemoteUrl !== current.expectedRemoteUrl ||
    approved.pushTarget !== current.pushTarget ||
    approved.protocol !== current.protocol
  ) {
    throw new GitEngineError('STALE_APPROVAL', 'The approved Git push destination changed.');
  }
}

/** Rejects active all-scope URL rewrites that would retarget the exact literal at spawn time. */
export async function assertNoMatchingPushUrlRewrites(
  git: GitExecutor,
  repositoryPath: string,
  pushTarget: string,
): Promise<void> {
  const result = await git.run(
    [
      '-C',
      repositoryPath,
      'config',
      '--includes',
      '--null',
      '--get-regexp',
      PUSH_URL_REWRITE_PATTERN,
    ],
    { allowNonZeroExit: true, maxOutputBytes: 256 * 1_024 },
  );
  if (result.exitCode === 1) return;
  if (result.exitCode !== 0 || !result.stdout.endsWith('\0')) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'Forgeboard could not verify effective Git URL rewrite configuration.',
    );
  }
  const records = result.stdout.slice(0, -1).split('\0');
  if (records.length > MAX_URL_REWRITE_RULES) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'Too many Git URL rewrite rules are active to verify an exact push.',
    );
  }
  for (const record of records) {
    const separator = record.indexOf('\n');
    const key = separator < 0 ? '' : record.slice(0, separator);
    const value = separator < 0 ? '' : record.slice(separator + 1);
    if (!/^url\..+\.(?:insteadof|pushinsteadof)$/u.test(key)) {
      throw new GitEngineError(
        'APPROVAL_MISMATCH',
        'Forgeboard could not verify effective Git URL rewrite configuration.',
      );
    }
    if (value === '' || pushTarget.startsWith(value)) {
      throw new GitEngineError(
        'APPROVAL_MISMATCH',
        'An active Git URL rewrite can retarget the exact approved push destination.',
      );
    }
  }
}

/** Rejects Git's remote-name precedence when a configured name equals the approved literal URL. */
export async function assertNoPushTargetRemoteNameCollision(
  git: GitExecutor,
  repositoryPath: string,
  pushTarget: string,
): Promise<void> {
  boundedExactValue(pushTarget, 'Git push target');
  const result = await git.run(
    [
      '-C',
      repositoryPath,
      'config',
      '--includes',
      '--null',
      '--name-only',
      '--get-regexp',
      '^remote\\..*\\.(url|pushurl|vcs)$',
    ],
    { allowNonZeroExit: true, maxOutputBytes: 256 * 1_024 },
  );
  if (result.exitCode === 1) return;
  if (result.exitCode !== 0 || !result.stdout.endsWith('\0')) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'Forgeboard could not verify configured Git remote names.',
    );
  }
  const keys = result.stdout.slice(0, -1).split('\0');
  if (keys.length > MAX_REMOTE_CONFIG_KEYS) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'Too many Git remote settings are active to verify an exact push.',
    );
  }
  const collision = keys.some((key) => {
    const match = /^remote\.(.*)\.(?:url|pushurl|vcs)$/u.exec(key);
    if (match === null || match[1] === '') {
      throw new GitEngineError(
        'APPROVAL_MISMATCH',
        'Forgeboard could not verify configured Git remote names.',
      );
    }
    return match[1] === pushTarget;
  });
  if (collision) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'A configured Git remote name collides with the exact approved push destination.',
    );
  }
}

function localPushDestination(expectedRemoteUrl: string, value: string): ExactPushDestination {
  const pushTarget = path.resolve(boundedExactValue(value, 'Local Git push destination'));
  if (!path.isAbsolute(pushTarget) || isNetworkSharePath(pushTarget)) throw invalidDestination();
  return { expectedRemoteUrl, pushTarget, protocol: 'file' };
}

function boundedExactValue(value: string, label: string): string {
  if (
    value.length < 1 ||
    value.length > MAX_REMOTE_URL_BYTES ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  ) {
    throw new GitEngineError('APPROVAL_MISMATCH', `${label} is not an exact bounded value.`);
  }
  return value;
}

function isNetworkSharePath(value: string): boolean {
  return value.startsWith('\\\\') || value.startsWith('//');
}

function assertDnsHost(value: string): void {
  if (
    value.length < 1 ||
    value.length > 253 ||
    value
      .toLowerCase()
      .split('.')
      .some(
        (label) =>
          label.length < 1 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
      )
  ) {
    throw invalidDestination();
  }
}

function assertNetworkResource(value: string): void {
  const normalized = boundedExactValue(value, 'Git push resource').replace(/^\/+|\/+$/gu, '');
  if (
    normalized === '' ||
    normalized.startsWith('-') ||
    normalized.includes('%') ||
    normalized.includes('\\') ||
    normalized.includes('@') ||
    normalized.includes('?') ||
    normalized.includes('#') ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw invalidDestination();
  }
}

function invalidDestination(cause?: unknown): GitEngineError {
  return new GitEngineError(
    'APPROVAL_MISMATCH',
    'The selected Git push destination is unsupported or ambiguous.',
    {},
    cause === undefined ? undefined : { cause },
  );
}
