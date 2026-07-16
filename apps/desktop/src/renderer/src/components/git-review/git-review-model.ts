import type {
  GitDiffFileView,
  GitReviewView,
  GitStatusEntryView,
} from '../../../../shared/git/contracts.js';

export type GitReviewArea = 'staged' | 'unstaged' | 'untracked';

export type GitDiffDisplayArea = GitReviewArea | 'base';

export interface GitDiffDisplayFile {
  readonly area: GitDiffDisplayArea;
  readonly path: string;
  readonly entry?: GitStatusEntryView;
  readonly diff?: GitDiffFileView;
}

export interface GitReviewFile extends GitDiffDisplayFile {
  readonly area: GitReviewArea;
}

export interface GitReviewGroups {
  readonly staged: readonly GitReviewFile[];
  readonly unstaged: readonly GitReviewFile[];
  readonly untracked: readonly GitReviewFile[];
}

export interface GitFileSelection {
  readonly area: GitReviewArea;
  readonly path: string;
}

export interface GitDiffStats {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

function diffPath(file: GitDiffFileView): string | null {
  return file.newPath ?? file.oldPath;
}

function entryPathMatches(entry: GitStatusEntryView, path: string): boolean {
  return entry.path === path || entry.originalPath === path;
}

function hasIndexChange(entry: GitStatusEntryView): boolean {
  return entry.index !== '.' && entry.index !== '?';
}

function hasWorktreeChange(entry: GitStatusEntryView): boolean {
  return entry.worktree !== '.' && entry.worktree !== '?';
}

function makeGroup(
  area: Exclude<GitReviewArea, 'untracked'>,
  diffFiles: readonly GitDiffFileView[],
  entries: readonly GitStatusEntryView[],
): readonly GitReviewFile[] {
  const files = new Map<string, GitReviewFile>();
  for (const diff of diffFiles) {
    const path = diffPath(diff);
    if (path === null) continue;
    const entry = entries.find((candidate) => entryPathMatches(candidate, path));
    files.set(path, {
      area,
      path,
      diff,
      ...(entry === undefined ? {} : { entry }),
    });
  }
  for (const entry of entries) {
    if (!files.has(entry.path)) files.set(entry.path, { area, path: entry.path, entry });
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function buildReviewGroups(review: GitReviewView): GitReviewGroups {
  const stagedEntries = review.entries.filter(hasIndexChange);
  const unstagedEntries = review.entries.filter(
    (entry) => entry.kind !== 'untracked' && hasWorktreeChange(entry),
  );
  const untracked = review.entries
    .filter((entry) => entry.kind === 'untracked' || entry.index === '?' || entry.worktree === '?')
    .map((entry) => ({ area: 'untracked' as const, path: entry.path, entry }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    staged: makeGroup('staged', review.staged.files, stagedEntries),
    unstaged: makeGroup('unstaged', review.unstaged.files, unstagedEntries),
    untracked,
  };
}

export function selectionKey(selection: GitFileSelection): string {
  return `${selection.area}:${selection.path}`;
}

export function allReviewFiles(groups: GitReviewGroups): readonly GitReviewFile[] {
  return [...groups.staged, ...groups.unstaged, ...groups.untracked];
}

export function findReviewFile(
  groups: GitReviewGroups,
  selection: GitFileSelection | null,
): GitReviewFile | null {
  if (selection === null) return null;
  return groups[selection.area].find((file) => file.path === selection.path) ?? null;
}

export function firstReviewSelection(groups: GitReviewGroups): GitFileSelection | null {
  const file = allReviewFiles(groups)[0];
  return file === undefined ? null : { area: file.area, path: file.path };
}

export function statusLabel(file: GitReviewFile): string {
  if (file.area === 'untracked') return 'New';
  if (file.diff?.binary === true) return 'Binary';
  const status = file.diff?.status;
  if (status === undefined || status === 'unknown') return 'Changed';
  return `${status[0]?.toUpperCase() ?? ''}${status.slice(1)}`;
}

export function fileDiffStats(file: GitDiffDisplayFile): Omit<GitDiffStats, 'files'> {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.diff?.hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.kind === 'addition') additions += 1;
      if (line.kind === 'deletion') deletions += 1;
    }
  }
  return { additions, deletions };
}

export function workingTreeDiffStats(review: GitReviewView): GitDiffStats {
  const paths = new Set(review.entries.map((entry) => entry.path));
  for (const diff of [...review.staged.files, ...review.unstaged.files]) {
    const path = diffPath(diff);
    if (path !== null) paths.add(path);
  }
  return {
    files: paths.size,
    additions: review.staged.additions + review.unstaged.additions,
    deletions: review.staged.deletions + review.unstaged.deletions,
  };
}
