import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { GitEngineError } from '../../model/errors.js';
import type { RepositoryService } from '../service.js';
import {
  GIT_REMOTE_CONFIGURATION_MAX_ENTRIES,
  GIT_REMOTE_CONFIGURATION_MAX_ENTRIES_PER_REMOTE,
  GIT_REMOTE_CONFIGURATION_MAX_REMOTES,
  GIT_REMOTE_CONFIGURATION_MAX_TRACKING_REFS,
  type GitCommonDirectoryIdentity,
  type GitConfiguredRemote,
  type GitRemoteConfigurationEntry,
  type GitRemoteConfigurationScope,
  type GitRemoteConfigurationSnapshot,
  type GitRemoteTrackingRef,
} from './contracts.js';
import { classifyConfiguredRemoteTarget } from './identity.js';

const CONFIG_OUTPUT_LIMIT = 512 * 1_024;
const REF_OUTPUT_LIMIT = 2 * 1_024 * 1_024;
const MAX_TOTAL_TRACKING_REFS =
  GIT_REMOTE_CONFIGURATION_MAX_REMOTES * (GIT_REMOTE_CONFIGURATION_MAX_TRACKING_REFS + 1);
const CONFIGURATION_SCOPES = new Set<GitRemoteConfigurationScope>([
  'system',
  'global',
  'local',
  'worktree',
  'command',
]);

export async function inspectGitRemoteConfiguration(
  repositories: RepositoryService,
  repositoryPath: string,
): Promise<GitRemoteConfigurationSnapshot> {
  const repositoryRoot = await repositories.resolveRepositoryRoot(repositoryPath);
  const identity = await readCommonDirectoryIdentity(repositories, repositoryRoot);
  const [entries, names, trackingRefs] = await Promise.all([
    readRemoteEntries(repositories, repositoryRoot),
    readRemoteNames(repositories, repositoryRoot),
    readTrackingRefs(repositories, repositoryRoot),
  ]);
  for (const entry of entries) {
    const name = remoteEntryName(entry.key);
    if (name !== null) names.add(name);
  }
  for (const ref of trackingRefs) {
    const name = orphanTrackingRefRemoteName(ref.name, names);
    if (name !== null) names.add(name);
  }
  if (names.size > GIT_REMOTE_CONFIGURATION_MAX_REMOTES) {
    throw mismatch('The repository exposes too many Git remotes to inspect safely.');
  }

  const sortedNames = [...names].sort(compareText);
  const foldedCounts = new Map<string, number>();
  for (const name of sortedNames) {
    const folded = name.toLowerCase();
    foldedCounts.set(folded, (foldedCounts.get(folded) ?? 0) + 1);
  }
  const refsByRemote = assignTrackingRefs(sortedNames, trackingRefs);
  const remotes = sortedNames.map((name) => {
    const remoteEntries = entries.filter((entry) => remoteEntryName(entry.key) === name);
    if (remoteEntries.length > GIT_REMOTE_CONFIGURATION_MAX_ENTRIES_PER_REMOTE) {
      throw mismatch('A Git remote has too many configuration entries to approve exactly.');
    }
    const urls = entryValues(remoteEntries, 'url');
    const pushUrls = entryValues(remoteEntries, 'pushurl');
    const refs = refsByRemote.get(name) ?? [];
    const target = classifyConfiguredRemoteTarget(repositoryRoot, urls);
    const directLocalConfiguration =
      remoteEntries.length > 0 &&
      remoteEntries.every(
        (entry) => entry.scope === 'local' && entry.origin === identity.configurationPath,
      );
    return {
      name,
      entries: remoteEntries,
      urls,
      pushUrls,
      fetchRefspecs: entryValues(remoteEntries, 'fetch'),
      target: target.target,
      targetState: target.state,
      directLocalConfiguration,
      ambiguous: !directLocalConfiguration || (foldedCounts.get(name.toLowerCase()) ?? 0) !== 1,
      trackingRefCount: refs.length,
      trackingRefs: refs.slice(0, GIT_REMOTE_CONFIGURATION_MAX_TRACKING_REFS),
      trackingRefsTruncated: refs.length > GIT_REMOTE_CONFIGURATION_MAX_TRACKING_REFS,
    } satisfies GitConfiguredRemote;
  });
  return {
    identity,
    configurationRevision: configurationRevision(identity, entries, sortedNames),
    remotes,
  };
}

function orphanTrackingRefRemoteName(
  refName: string,
  configuredNames: ReadonlySet<string>,
): string | null {
  if ([...configuredNames].some((name) => refName.startsWith(`refs/remotes/${name}/`))) {
    return null;
  }
  const match = /^refs\/remotes\/([^/]+)\//u.exec(refName);
  return match?.[1] ?? null;
}

async function readCommonDirectoryIdentity(
  repositories: RepositoryService,
  repositoryRoot: string,
): Promise<GitCommonDirectoryIdentity> {
  const [commonDirectory, configurationResult] = await Promise.all([
    repositories.commonDirectory(repositoryRoot),
    repositories.git.run([
      '-C',
      repositoryRoot,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'config',
    ]),
  ]);
  const configurationCandidate = configurationResult.stdout.trim();
  if (configurationCandidate === '') {
    throw mismatch('Git did not identify the repository configuration file.');
  }
  let configurationPath: string;
  try {
    configurationPath = await realpath(configurationCandidate);
  } catch (error) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'The repository configuration file is unavailable.',
      {},
      { cause: error },
    );
  }
  const [commonStats, configurationStats] = await Promise.all([
    lstat(commonDirectory, { bigint: true }),
    lstat(configurationPath, { bigint: true }),
  ]);
  if (!commonStats.isDirectory() || !configurationStats.isFile()) {
    throw mismatch('The repository configuration identity is invalid.');
  }
  return {
    repositoryRoot,
    commonDirectory,
    configurationPath,
    commonDirectoryDevice: commonStats.dev.toString(),
    commonDirectoryInode: commonStats.ino.toString(),
    configurationDevice: configurationStats.dev.toString(),
    configurationInode: configurationStats.ino.toString(),
  };
}

async function readRemoteEntries(
  repositories: RepositoryService,
  repositoryRoot: string,
): Promise<readonly GitRemoteConfigurationEntry[]> {
  const result = await repositories.git.run(
    [
      '-C',
      repositoryRoot,
      'config',
      '--includes',
      '--show-origin',
      '--show-scope',
      '--null',
      '--get-regexp',
      '^remote\\..*\\.',
    ],
    { allowNonZeroExit: true, maxOutputBytes: CONFIG_OUTPUT_LIMIT },
  );
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0 || !result.stdout.endsWith('\0')) {
    throw mismatch('Git remote configuration could not be read exactly.');
  }
  const fields = result.stdout.slice(0, -1).split('\0');
  if (fields.length % 3 !== 0 || fields.length / 3 > GIT_REMOTE_CONFIGURATION_MAX_ENTRIES) {
    throw mismatch('Git remote configuration exceeds the bounded inspection format.');
  }
  const originCache = new Map<string, Promise<string>>();
  const entries: GitRemoteConfigurationEntry[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index] ?? '';
    const origin = fields[index + 1] ?? '';
    const keyValue = fields[index + 2] ?? '';
    const separator = keyValue.indexOf('\n');
    const key = separator < 0 ? '' : keyValue.slice(0, separator);
    const value = separator < 0 ? '' : keyValue.slice(separator + 1);
    if (!CONFIGURATION_SCOPES.has(scope as GitRemoteConfigurationScope)) {
      throw mismatch('Git returned an unsupported configuration scope.');
    }
    if (remoteEntryName(key) === null || key.length > 512 || value.length > 32_768) {
      throw mismatch('Git returned an invalid or oversized remote configuration entry.');
    }
    let normalizedOrigin = origin;
    if (origin.startsWith('file:')) {
      let pending = originCache.get(origin);
      if (pending === undefined) {
        pending = canonicalConfigOrigin(repositoryRoot, origin.slice('file:'.length));
        originCache.set(origin, pending);
      }
      normalizedOrigin = await pending;
    }
    entries.push({
      scope: scope as GitRemoteConfigurationScope,
      origin: normalizedOrigin,
      key,
      value,
    });
  }
  return entries;
}

async function readRemoteNames(
  repositories: RepositoryService,
  repositoryRoot: string,
): Promise<Set<string>> {
  const result = await repositories.git.run(['-C', repositoryRoot, 'remote'], {
    maxOutputBytes: 64 * 1_024,
  });
  const names = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const name = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (name === '') continue;
    if (name.length > 512 || [...name].some((character) => (character.codePointAt(0) ?? 0) <= 31)) {
      throw mismatch('Git returned an invalid remote name.');
    }
    names.add(name);
  }
  return names;
}

async function readTrackingRefs(
  repositories: RepositoryService,
  repositoryRoot: string,
): Promise<readonly GitRemoteTrackingRef[]> {
  const result = await repositories.git.run(
    [
      '-C',
      repositoryRoot,
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(symref)',
      'refs/remotes',
    ],
    { maxOutputBytes: REF_OUTPUT_LIMIT },
  );
  const refs: GitRemoteTrackingRef[] = [];
  for (const lineValue of result.stdout.split('\n')) {
    const line = lineValue.endsWith('\r') ? lineValue.slice(0, -1) : lineValue;
    if (line === '') continue;
    const fields = line.split('\0');
    if (fields.length !== 3) throw mismatch('Git returned an invalid tracking-ref record.');
    const [name = '', oid = '', symbolicTarget = ''] = fields;
    if (
      !/^refs\/remotes\/[A-Za-z0-9._/-]+$/u.test(name) ||
      !/^[0-9a-f]{40,64}$/u.test(oid) ||
      (symbolicTarget !== '' && !/^refs\/remotes\/[A-Za-z0-9._/-]+$/u.test(symbolicTarget))
    ) {
      throw mismatch('Git returned an unsupported tracking-ref identity.');
    }
    refs.push({
      name,
      oid,
      symbolicTarget: symbolicTarget === '' ? null : symbolicTarget,
    });
    if (refs.length > MAX_TOTAL_TRACKING_REFS) {
      throw mismatch('The repository has too many remote-tracking refs to inspect safely.');
    }
  }
  return refs.sort((left, right) => compareText(left.name, right.name));
}

function assignTrackingRefs(
  remoteNames: readonly string[],
  refs: readonly GitRemoteTrackingRef[],
): Map<string, GitRemoteTrackingRef[]> {
  const byLength = [...remoteNames].sort(
    (left, right) => right.length - left.length || compareText(left, right),
  );
  const assigned = new Map<string, GitRemoteTrackingRef[]>();
  for (const ref of refs) {
    const remote = byLength.find((name) => ref.name.startsWith(`refs/remotes/${name}/`));
    if (remote === undefined) continue;
    const current = assigned.get(remote) ?? [];
    current.push(ref);
    assigned.set(remote, current);
  }
  return assigned;
}

function entryValues(
  entries: readonly GitRemoteConfigurationEntry[],
  property: string,
): readonly string[] {
  return entries
    .filter((entry) => remoteEntryProperty(entry.key) === property)
    .map((entry) => entry.value);
}

export function remoteEntryName(key: string): string | null {
  const match = /^remote\.(.+)\.([A-Za-z][A-Za-z0-9-]*)$/u.exec(key);
  return match?.[1] ?? null;
}

export function remoteEntryProperty(key: string): string | null {
  const match = /^remote\.(.+)\.([A-Za-z][A-Za-z0-9-]*)$/u.exec(key);
  return match?.[2]?.toLowerCase() ?? null;
}

function configurationRevision(
  identity: GitCommonDirectoryIdentity,
  entries: readonly GitRemoteConfigurationEntry[],
  remoteNames: readonly string[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({ identity, entries, remoteNames }))
    .digest('hex');
}

async function canonicalConfigOrigin(repositoryRoot: string, origin: string): Promise<string> {
  const candidate = path.isAbsolute(origin) ? origin : path.resolve(repositoryRoot, origin);
  try {
    return await realpath(candidate);
  } catch {
    return path.normalize(candidate);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mismatch(message: string): GitEngineError {
  return new GitEngineError('APPROVAL_MISMATCH', message);
}
