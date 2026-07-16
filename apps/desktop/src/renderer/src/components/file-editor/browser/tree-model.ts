import type { FileTreeEntry, FileTreeResult } from '../../../../../shared/files/contracts.js';

export const QUICK_OPEN_MAX_ENTRIES = 3_000;
export const QUICK_OPEN_MAX_DIRECTORIES = 256;
export const QUICK_OPEN_VISIBLE_RESULTS = 100;

export interface FileBrowserBreadcrumb {
  readonly label: string;
  readonly directory: string;
}

export function indexTreeEntries(results: readonly FileTreeResult[]): FileTreeEntry[] {
  const entries = new Map<string, FileTreeEntry>();
  for (const result of results) {
    for (const entry of result.entries) entries.set(entry.relativePath, entry);
  }
  return [...entries.values()].sort(compareEntries);
}

export function visibleTreeEntries(
  entries: readonly FileTreeEntry[],
  directory: string,
  query: string,
): FileTreeEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const filtered =
    terms.length === 0
      ? entries.filter((entry) => parentDirectory(entry.relativePath) === directory)
      : entries.filter((entry) => {
          const path = entry.relativePath.toLocaleLowerCase();
          return terms.every((term) => path.includes(term));
        });
  return [...filtered].sort(compareEntries);
}

export function fileBrowserBreadcrumbs(directory: string): FileBrowserBreadcrumb[] {
  const breadcrumbs: FileBrowserBreadcrumb[] = [{ label: 'Project', directory: '.' }];
  if (directory === '.') return breadcrumbs;
  const segments = directory.split('/');
  let current = '';
  for (const segment of segments) {
    current = current === '' ? segment : `${current}/${segment}`;
    breadcrumbs.push({ label: segment, directory: current });
  }
  return breadcrumbs;
}

export function parentDirectory(relativePath: string): string {
  const separator = relativePath.lastIndexOf('/');
  return separator < 0 ? '.' : relativePath.slice(0, separator);
}

export function policyLabel(entry: FileTreeEntry): string {
  if (entry.policy.status === 'normal') {
    if (entry.kind === 'directory') return 'Folder';
    if (entry.kind === 'file') return 'File';
    return 'Unsupported';
  }
  if (entry.policy.status === 'ignored') return 'Ignored';
  if (entry.policy.status === 'sensitive') return 'Sensitive';
  return 'Symlink blocked';
}

function compareEntries(left: FileTreeEntry, right: FileTreeEntry): number {
  const leftRank = left.kind === 'directory' ? 0 : 1;
  const rightRank = right.kind === 'directory' ? 0 : 1;
  return leftRank - rightRank || left.relativePath.localeCompare(right.relativePath);
}
