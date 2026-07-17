import { createHash } from 'node:crypto';

import type { RepositoryService } from '@forgeboard/git-engine';

import type { WorkspaceSnapshot } from '../contracts.js';

export interface WorkspaceResult {
  readonly after: WorkspaceSnapshot;
  readonly changedFiles: readonly string[];
}

export async function captureWorkspace(
  repositories: RepositoryService,
  repositoryPath: string,
): Promise<WorkspaceSnapshot> {
  const status = await repositories.status(repositoryPath);
  const paths = new Map<string, string>();
  for (const entry of status.entries) {
    if (entry.kind === 'ignored') continue;
    const [content, index] = await Promise.all([
      repositories.git.run(
        ['-C', repositoryPath, 'hash-object', '--no-filters', '--', entry.path],
        { allowNonZeroExit: true },
      ),
      repositories.git.run(['-C', repositoryPath, 'ls-files', '-s', '--', entry.path], {
        allowNonZeroExit: true,
      }),
    ]);
    paths.set(
      entry.path,
      createHash('sha256')
        .update(
          [
            entry.kind,
            entry.index,
            entry.worktree,
            entry.originalPath ?? '',
            content.stdout.trim(),
            index.stdout.trim(),
          ].join('\0'),
        )
        .digest('hex'),
    );
  }
  return { headOid: status.headOid, paths };
}

export async function changedWorkspace(
  repositories: RepositoryService,
  repositoryRoot: string,
  cwd: string,
  before: WorkspaceSnapshot,
): Promise<WorkspaceResult> {
  const after = await captureWorkspace(repositories, cwd);
  const changed = new Set<string>();
  for (const candidate of new Set([...before.paths.keys(), ...after.paths.keys()])) {
    if (before.paths.get(candidate) !== after.paths.get(candidate)) changed.add(candidate);
  }
  if (before.headOid !== null && after.headOid !== null && before.headOid !== after.headOid) {
    const committed = await repositories.git.runGuarded(
      [
        '-C',
        cwd,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-only',
        '-z',
        before.headOid,
        after.headOid,
        '--',
      ],
      { repositoryPath: cwd, operation: 'object-inspection' },
    );
    for (const candidate of committed.stdout.split('\0')) {
      if (candidate !== '') changed.add(candidate);
    }
  }
  await repositories.resolveRepositoryRoot(repositoryRoot);
  return { after, changedFiles: [...changed].sort() };
}
