import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanupDeferredRecoveryStaging } from './deferred-staging-cleanup.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe('deferred recovery staging cleanup', () => {
  it('removes a private exact-name direct child and its ordinary SQLite files', async () => {
    const root = await temporaryRoot();
    const staging = join(root, '.forgeboard-database-recovery-Ab12z9');
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, 'selected.sqlite3'), 'private copy', { mode: 0o600 });
    await writeFile(join(staging, 'selected.sqlite3-wal'), 'wal', { mode: 0o600 });

    await expect(cleanupDeferredRecoveryStaging(root)).resolves.toEqual({
      failedCount: 0,
      removedCount: 1,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses links, public directories, and unrecognized prefixed names', async () => {
    const root = await temporaryRoot();
    const outside = join(root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(root, '.forgeboard-database-recovery-Ab12z9'));
    const publicDirectory = join(root, '.forgeboard-database-recovery-Cd34x8');
    await mkdir(publicDirectory, { mode: 0o755 });
    const unrecognized = join(root, '.forgeboard-database-recovery-not-reviewed');
    await mkdir(unrecognized, { mode: 0o700 });

    await expect(cleanupDeferredRecoveryStaging(root)).resolves.toEqual({
      failedCount: 3,
      removedCount: 0,
    });
    expect(await readdir(root)).toHaveLength(4);
  });

  it('preserves startup progress and reports a failed removal without exposing a path', async () => {
    const root = await temporaryRoot();
    const staging = join(root, '.forgeboard-database-recovery-Ef56w7');
    await mkdir(staging, { mode: 0o700 });
    const removeDirectory = vi.fn(() => Promise.reject(new Error(`/secret/${staging}`)));

    await expect(cleanupDeferredRecoveryStaging(root, { removeDirectory })).resolves.toEqual({
      failedCount: 1,
      removedCount: 0,
    });
    expect(removeDirectory).toHaveBeenCalledOnce();
    await chmod(staging, 0o700);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-deferred-staging-')));
  roots.push(root);
  return root;
}
