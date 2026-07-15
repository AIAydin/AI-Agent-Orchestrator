import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { resolveCanonicalPath, type CanonicalPathResult } from '@forgeboard/core';

import { FileDomainError } from './errors.js';

export interface FileProjectRecord {
  readonly id: string;
  readonly path: string;
  readonly missing: boolean;
}

export interface FileProjectStore {
  getProject(projectId: string): FileProjectRecord | undefined;
}

export async function resolveProjectFileRoot(
  store: FileProjectStore,
  projectId: string,
): Promise<string> {
  const project = store.getProject(projectId);
  if (project === undefined) {
    throw new FileDomainError('PROJECT_NOT_FOUND', 'The selected project no longer exists.');
  }
  if (project.missing) {
    throw new FileDomainError(
      'PROJECT_MISSING',
      'Locate the selected project before opening files.',
    );
  }
  if (!path.isAbsolute(project.path)) {
    throw new FileDomainError(
      'PROJECT_ROOT_UNAVAILABLE',
      'Reopen the project from its canonical folder before opening files.',
    );
  }

  const canonical = await resolveCanonicalPath(project.path, '.', { mustExist: true });
  if (path.resolve(project.path) !== canonical.rootPath) {
    throw new FileDomainError(
      'PROJECT_ROOT_UNAVAILABLE',
      'Reopen the project from its canonical folder before opening files.',
    );
  }
  const rootStat = await lstat(canonical.rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new FileDomainError(
      'PROJECT_ROOT_UNAVAILABLE',
      'The selected project folder is not an ordinary directory.',
    );
  }
  return canonical.rootPath;
}

export async function resolveExactProjectPath(
  root: string,
  relativePath: string,
): Promise<CanonicalPathResult> {
  const resolved = await resolveCanonicalPath(root, relativePath, { mustExist: true });
  const expectedRelativePath = relativePath === '.' ? '' : relativePath;
  if (resolved.relativePath !== expectedRelativePath) {
    throw new FileDomainError(
      'PATH_NOT_CANONICAL',
      'Symbolic-link aliases are not accepted by the embedded editor.',
    );
  }
  return resolved;
}
