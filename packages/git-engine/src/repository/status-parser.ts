import { GitEngineError } from '../model/errors.js';
import type {
  AheadBehind,
  GitFileState,
  GitRemote,
  GitStatus,
  GitStatusEntry,
  GitSubmodule,
} from '../model/types.js';

const FILE_STATES = new Set<GitFileState>(['.', 'A', 'C', 'D', 'M', 'R', 'T', 'U', '?', '!']);

function fileState(value: string): GitFileState {
  if (!FILE_STATES.has(value as GitFileState)) {
    throw new GitEngineError('COMMAND_FAILED', `Unrecognized Git file state: ${value}`);
  }
  return value as GitFileState;
}

function xy(value: string): readonly [GitFileState, GitFileState] {
  if (value.length !== 2) {
    throw new GitEngineError('COMMAND_FAILED', `Malformed Git status code: ${value}`);
  }
  return [fileState(value[0] ?? ''), fileState(value[1] ?? '')];
}

/** Parses `git status --porcelain=v2 --branch -z` without losing unusual file names. */
export function parseGitStatus(output: string): GitStatus {
  const records = output.split('\0');
  const entries: GitStatusEntry[] = [];
  let branch: string | null = null;
  let headOid: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === '') continue;
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length);
      headOid = value === '(initial)' ? null : value;
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length);
      branch = value === '(detached)' ? null : value;
      continue;
    }
    if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice('# branch.upstream '.length);
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match !== null) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }

    const ordinary = /^1 ([^ ]{2}) ([^ ]+) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/s.exec(record);
    if (ordinary !== null) {
      const [indexState, worktreeState] = xy(ordinary[1] ?? '');
      entries.push({
        kind: 'ordinary',
        path: ordinary[3] ?? '',
        index: indexState,
        worktree: worktreeState,
        submodule: ordinary[2] ?? '',
      });
      continue;
    }

    const renamed = /^2 ([^ ]{2}) ([^ ]+) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ ([^ ]+) (.*)$/s.exec(
      record,
    );
    if (renamed !== null) {
      const [indexState, worktreeState] = xy(renamed[1] ?? '');
      const originalPath = records[index + 1];
      if (originalPath === undefined || originalPath === '') {
        throw new GitEngineError('COMMAND_FAILED', 'Rename status omitted its original path.');
      }
      index += 1;
      entries.push({
        kind: 'renamed-or-copied',
        path: renamed[4] ?? '',
        originalPath,
        index: indexState,
        worktree: worktreeState,
        submodule: renamed[2] ?? '',
        score: renamed[3] ?? '',
      });
      continue;
    }

    const unmerged = /^u ([^ ]{2}) ([^ ]+) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/s.exec(
      record,
    );
    if (unmerged !== null) {
      const [indexState, worktreeState] = xy(unmerged[1] ?? '');
      entries.push({
        kind: 'unmerged',
        path: unmerged[3] ?? '',
        index: indexState,
        worktree: worktreeState,
        submodule: unmerged[2] ?? '',
      });
      continue;
    }

    if (record.startsWith('? ')) {
      entries.push({
        kind: 'untracked',
        path: record.slice(2),
        index: '?',
        worktree: '?',
      });
      continue;
    }
    if (record.startsWith('! ')) {
      entries.push({
        kind: 'ignored',
        path: record.slice(2),
        index: '!',
        worktree: '!',
      });
      continue;
    }
    throw new GitEngineError('COMMAND_FAILED', 'Unable to parse Git status output.', { record });
  }

  const meaningful = entries.filter((entry) => entry.kind !== 'ignored');
  const staged = meaningful.some(
    (entry) => entry.kind !== 'untracked' && entry.index !== '.' && entry.index !== '?',
  );
  const unstaged = meaningful.some(
    (entry) => entry.kind !== 'untracked' && entry.worktree !== '.' && entry.worktree !== '?',
  );
  const untracked = meaningful.some((entry) => entry.kind === 'untracked');
  const conflicted = meaningful.some(
    (entry) => entry.kind === 'unmerged' || entry.index === 'U' || entry.worktree === 'U',
  );

  return {
    branch,
    detached: branch === null && headOid !== null,
    headOid,
    upstream,
    ahead,
    behind,
    entries,
    dirty: meaningful.length > 0,
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

export function parseAheadBehind(output: string): AheadBehind {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(output);
  if (match === null) {
    throw new GitEngineError('COMMAND_FAILED', 'Unable to parse ahead/behind counts.', { output });
  }
  return { behind: Number(match[1]), ahead: Number(match[2]) };
}

function redactRemoteUrl(url: string): { url: string; redacted: boolean } {
  try {
    const parsed = new URL(url);
    let redacted = false;
    if (parsed.username !== '' || parsed.password !== '') {
      parsed.username = 'REDACTED';
      parsed.password = '';
      redacted = true;
    }
    for (const name of [...parsed.searchParams.keys()]) {
      if (/(auth|credential|key|password|secret|signature|token)/iu.test(name)) {
        parsed.searchParams.set(name, 'REDACTED');
        redacted = true;
      }
    }
    if (parsed.hash !== '') {
      parsed.hash = '#REDACTED';
      redacted = true;
    }
    return { url: redacted ? parsed.toString() : url, redacted };
  } catch {
    const httpCredentials = /^(https?:\/\/)([^/@]+)@/i;
    if (httpCredentials.test(url)) {
      return { url: url.replace(httpCredentials, '$1REDACTED@'), redacted: true };
    }
    return { url, redacted: false };
  }
}

export function parseRemotes(output: string): readonly GitRemote[] {
  const byName = new Map<
    string,
    { fetchUrl: string | null; pushUrl: string | null; hasRedactedCredentials: boolean }
  >();
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    const match = /^(\S+)\s+(.+)\s+\((fetch|push)\)$/.exec(line);
    if (match === null) continue;
    const name = match[1] ?? '';
    const redacted = redactRemoteUrl(match[2] ?? '');
    const current = byName.get(name) ?? {
      fetchUrl: null,
      pushUrl: null,
      hasRedactedCredentials: false,
    };
    if (match[3] === 'fetch') current.fetchUrl = redacted.url;
    else current.pushUrl = redacted.url;
    current.hasRedactedCredentials ||= redacted.redacted;
    byName.set(name, current);
  }
  return [...byName.entries()]
    .map(([name, remote]) => ({ name, ...remote }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function parseSubmodules(output: string): readonly GitSubmodule[] {
  const submodules: GitSubmodule[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line === '') continue;
    const match = /^([ +\-U])([0-9a-f]{40,64})\s+(.+?)(?:\s+\((.*)\))?$/i.exec(line);
    if (match === null) continue;
    const marker = match[1] ?? ' ';
    const state =
      marker === '-'
        ? 'uninitialized'
        : marker === '+'
          ? 'different'
          : marker === 'U'
            ? 'conflicted'
            : 'current';
    submodules.push({
      path: match[3] ?? '',
      commit: match[2] ?? '',
      state,
      description: match[4] ?? null,
    });
  }
  return submodules;
}
