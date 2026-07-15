import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';

import { type IgnoreMatcher } from '@forgeboard/core';

import type { FileTreeEntry, FileTreeResult } from '../../shared/files/contracts.js';
import { FileDomainError } from './errors.js';
import { resolveExactProjectPath } from './authority.js';
import { evaluateFilePolicy } from './policy.js';

export interface ProjectTreeOptions {
  readonly maxDirectoryEntries: number;
}

export async function listProjectDirectory(
  root: string,
  projectId: string,
  directory: string,
  matcher: IgnoreMatcher,
  options: ProjectTreeOptions,
): Promise<FileTreeResult> {
  const resolved = await resolveExactProjectPath(root, directory);
  const directoryStat = await lstat(resolved.path);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new FileDomainError('NOT_A_DIRECTORY', 'The selected project path is not a directory.');
  }

  const names: string[] = [];
  const handle = await opendir(resolved.path);
  try {
    while (names.length <= options.maxDirectoryEntries) {
      const entry = await handle.read();
      if (entry === null) break;
      names.push(entry.name);
    }
  } finally {
    await handle.close();
  }
  const truncated = names.length > options.maxDirectoryEntries;
  const candidates = names.slice(0, options.maxDirectoryEntries);
  const entries: FileTreeEntry[] = [];
  for (const name of candidates) {
    const relativePath = directory === '.' ? name : `${directory}/${name}`;
    const entryStat = await lstat(path.join(resolved.path, name));
    const kind = entryStat.isSymbolicLink()
      ? 'symlink'
      : entryStat.isDirectory()
        ? 'directory'
        : entryStat.isFile()
          ? 'file'
          : 'other';
    const policy = evaluateFilePolicy(
      matcher,
      relativePath,
      kind === 'directory',
      kind === 'symlink',
    ).entry;
    entries.push({
      name,
      relativePath,
      kind,
      sizeBytes: kind === 'file' ? entryStat.size : null,
      modifiedAt: entryStat.mtime.toISOString(),
      policy,
      canOpen: policy.status === 'normal' && (kind === 'file' || kind === 'directory'),
    });
  }
  entries.sort((left, right) => {
    const leftRank = left.kind === 'directory' ? 0 : 1;
    const rightRank = right.kind === 'directory' ? 0 : 1;
    return leftRank - rightRank || left.name.localeCompare(right.name);
  });
  return { projectId, directory, entries, truncated };
}
