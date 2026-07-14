import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { GitEngineError } from './errors.js';

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    throw new GitEngineError(
      'INVALID_ARGUMENT',
      `Directory does not exist or cannot be resolved: ${directory}`,
      { directory },
      { cause: error },
    );
  }
}

async function canonicalPathBeforeCreation(candidatePath: string): Promise<string> {
  let cursor = path.resolve(candidatePath);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(cursor), ...missingSegments.reverse());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new GitEngineError('INVALID_ARGUMENT', 'Managed root has no resolvable ancestor.', {
          candidatePath,
        });
      }
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function prepareManagedRoot(
  repositoryRoot: string,
  managedRoot: string,
): Promise<string> {
  const absoluteCandidate = await canonicalPathBeforeCreation(managedRoot);
  if (
    isPathInside(repositoryRoot, absoluteCandidate) ||
    isPathInside(absoluteCandidate, repositoryRoot)
  ) {
    throw new GitEngineError(
      'INVALID_MANAGED_ROOT',
      'The managed worktree directory must be disjoint from the primary checkout.',
      { repositoryRoot, managedRoot: absoluteCandidate },
    );
  }
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await canonicalDirectory(managedRoot);
  if (isPathInside(repositoryRoot, canonicalRoot) || isPathInside(canonicalRoot, repositoryRoot)) {
    throw new GitEngineError(
      'INVALID_MANAGED_ROOT',
      'The managed worktree directory must be disjoint from the primary checkout.',
      { repositoryRoot, managedRoot: canonicalRoot },
    );
  }
  return canonicalRoot;
}

export async function assertPathUnderManagedRoot(
  managedRoot: string,
  candidatePath: string,
): Promise<void> {
  const canonicalRoot = await canonicalDirectory(managedRoot);
  const canonicalCandidate = await canonicalDirectory(candidatePath);
  if (!isPathInside(canonicalRoot, canonicalCandidate) || canonicalCandidate === canonicalRoot) {
    throw new GitEngineError('OWNERSHIP_MISMATCH', 'Worktree is outside its managed root.', {
      managedRoot: canonicalRoot,
      candidatePath: canonicalCandidate,
    });
  }
}

export function safeSlug(value: string, fallback = 'work'): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^[.\-_]+|[.\-_]+$/gu, '')
    .replace(/\.{2,}/gu, '.')
    .slice(0, 48)
    .toLowerCase();
  return slug === '' ? fallback : slug;
}
