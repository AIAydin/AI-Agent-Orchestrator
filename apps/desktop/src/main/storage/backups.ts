import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { backup as sqliteBackup, type DatabaseSync } from 'node:sqlite';

import type { BackupResult } from '../storage-schemas.js';
import { clearAllTables, transaction } from './database.js';
import { assertBackupIntegrity } from './integrity.js';
import { type BackupRow, isRecord } from './values.js';

interface FileDigest {
  sha256: string;
  sizeBytes: number;
  dev: number;
  ino: number;
}

export async function createBackup(
  database: DatabaseSync,
  destinationDirectory: string,
  now = new Date(),
): Promise<BackupResult> {
  const requestedDirectory = resolve(destinationDirectory);
  await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await realpath(requestedDirectory);
  await assertCanonicalPrivateDirectory(canonicalDirectory);
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const backupId = randomUUID();
  const target = join(canonicalDirectory, `forgeboard-${timestamp}-${backupId}.sqlite3`);
  const stagingDirectory = join(canonicalDirectory, `.forgeboard-backup-${backupId}`);
  await mkdir(stagingDirectory, { mode: 0o700 });
  let targetCreated = false;
  try {
    await assertCanonicalPrivateDirectory(canonicalDirectory);
    const canonicalStagingDirectory = await realpath(stagingDirectory);
    if (
      canonicalStagingDirectory !== stagingDirectory ||
      dirname(canonicalStagingDirectory) !== canonicalDirectory
    ) {
      throw new Error('The backup staging path escaped the selected destination.');
    }
    await assertCanonicalPrivateDirectory(canonicalStagingDirectory);
    const stagedTarget = join(canonicalStagingDirectory, 'backup.sqlite3');
    await sqliteBackup(database, stagedTarget);
    const stagedStats = await lstat(stagedTarget);
    if (!stagedStats.isFile() || stagedStats.isSymbolicLink()) {
      throw new Error('SQLite did not create an ordinary backup file.');
    }
    await chmod(stagedTarget, 0o600);
    const canonicalStagedTarget = await realpath(stagedTarget);
    if (
      canonicalStagedTarget !== stagedTarget ||
      dirname(canonicalStagedTarget) !== canonicalStagingDirectory
    ) {
      throw new Error('The backup file escaped its private staging directory.');
    }
    assertBackupIntegrity(canonicalStagedTarget);
    const stagedDigest = await hashFile(canonicalStagedTarget);
    await assertCanonicalPrivateDirectory(canonicalDirectory);
    await assertCanonicalPrivateDirectory(canonicalStagingDirectory);
    await link(canonicalStagedTarget, target);
    targetCreated = true;
    await assertCanonicalPrivateDirectory(canonicalDirectory);
    const canonicalTarget = await realpath(target);
    if (canonicalTarget !== target || dirname(canonicalTarget) !== canonicalDirectory) {
      throw new Error('The backup path escaped the selected destination.');
    }
    const digest = await hashFile(canonicalTarget);
    if (
      digest.sha256 !== stagedDigest.sha256 ||
      digest.sizeBytes !== stagedDigest.sizeBytes ||
      digest.dev !== stagedDigest.dev ||
      digest.ino !== stagedDigest.ino
    ) {
      throw new Error('The backup changed while it was being published.');
    }
    const result: BackupResult = {
      path: canonicalTarget,
      createdAt: now.toISOString(),
      sha256: digest.sha256,
      sizeBytes: digest.sizeBytes,
    };
    // A read-only integrity connection can still create SQLite WAL/SHM sidecars. Remove the
    // private staging tree before recording success so callers never observe a completed backup
    // alongside Forgeboard's transient files.
    await cleanupBackupStagingDirectory(stagingDirectory, canonicalDirectory);
    database
      .prepare(
        `INSERT INTO backup_records(id, canonical_path, created_at, sha256, size_bytes)
         VALUES(?, ?, ?, ?, ?)`,
      )
      .run(backupId, result.path, result.createdAt, result.sha256, result.sizeBytes);
    return result;
  } catch (error) {
    if (targetCreated) await removeContainedOrdinaryFile(target, canonicalDirectory);
    await cleanupBackupStagingDirectory(stagingDirectory, canonicalDirectory).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function deleteAllLocalData(database: DatabaseSync): Promise<void> {
  const backups = database
    .prepare(
      'SELECT id, canonical_path, sha256, size_bytes FROM backup_records ORDER BY created_at',
    )
    .all() as unknown as BackupRow[];
  for (const backup of backups) await removeRecordedBackup(backup);
  transaction(database, () => clearAllTables(database));
  database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  database.exec('VACUUM;');
  database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
}

async function hashFile(path: string): Promise<FileDigest> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('The backup is not an ordinary file.');
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.size !== sizeBytes
    ) {
      throw new Error('The backup changed while it was being read.');
    }
    const pathStats = await lstat(path);
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      pathStats.dev !== after.dev ||
      pathStats.ino !== after.ino
    ) {
      throw new Error('The backup path changed while it was being read.');
    }
    return {
      sha256: hash.digest('hex'),
      sizeBytes,
      dev: after.dev,
      ino: after.ino,
    };
  } finally {
    await handle.close();
  }
}

function assertPrivateDirectory(stats: Stats): void {
  if (process.platform === 'win32') return;
  if ((stats.mode & 0o022) !== 0) {
    throw new Error('The backup destination must not be writable by group or other users.');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('The backup destination must be owned by the current user.');
  }
}

async function assertCanonicalPrivateDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('The backup destination is not an ordinary directory.');
  }
  if ((await realpath(path)) !== path) {
    throw new Error('The backup destination is no longer canonical.');
  }
  assertPrivateDirectory(stats);
}

async function removeContainedOrdinaryFile(path: string, expectedParent: string): Promise<void> {
  try {
    await assertCanonicalPrivateDirectory(expectedParent);
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    const canonicalPath = await realpath(path);
    if (canonicalPath !== path || dirname(canonicalPath) !== expectedParent) return;
    const finalStats = await lstat(path);
    if (
      !finalStats.isFile() ||
      finalStats.isSymbolicLink() ||
      finalStats.dev !== stats.dev ||
      finalStats.ino !== stats.ino
    ) {
      return;
    }
    await unlink(path);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function cleanupBackupStagingDirectory(
  stagingDirectory: string,
  expectedParent: string,
): Promise<void> {
  await assertCanonicalPrivateDirectory(expectedParent);
  let canonicalStagingDirectory: string;
  try {
    canonicalStagingDirectory = await realpath(stagingDirectory);
  } catch (error) {
    if (isFileNotFound(error)) return;
    throw error;
  }
  if (
    canonicalStagingDirectory !== stagingDirectory ||
    dirname(canonicalStagingDirectory) !== expectedParent
  ) {
    return;
  }
  await assertCanonicalPrivateDirectory(canonicalStagingDirectory);
  for (const name of [
    'backup.sqlite3',
    'backup.sqlite3-wal',
    'backup.sqlite3-shm',
    'backup.sqlite3-journal',
  ]) {
    await removeContainedOrdinaryFile(
      join(canonicalStagingDirectory, name),
      canonicalStagingDirectory,
    );
  }
  try {
    await rmdir(canonicalStagingDirectory);
  } catch (error) {
    if (!isFileNotFound(error) && (!isRecord(error) || error.code !== 'ENOTEMPTY')) throw error;
  }
}

async function removeRecordedBackup(backup: BackupRow): Promise<void> {
  const backupPath = backup.canonical_path;
  if (backupPath.includes('\0') || resolve(backupPath) !== backupPath) {
    throw new Error('A recorded backup path is not canonical.');
  }
  const expectedSuffixes = [`-${backup.id}.sqlite3`, `-${backup.id.slice(0, 8)}.sqlite3`];
  if (
    !basename(backupPath).startsWith('forgeboard-') ||
    !expectedSuffixes.some((suffix) => basename(backupPath).endsWith(suffix))
  ) {
    throw new Error('A recorded backup path does not match its backup identity.');
  }
  let backupStats: Stats;
  try {
    backupStats = await lstat(backupPath);
  } catch (error) {
    if (isFileNotFound(error)) return;
    throw error;
  }
  if (!backupStats.isFile() || backupStats.isSymbolicLink()) {
    throw new Error('A recorded backup is no longer an ordinary file.');
  }
  const canonicalParent = dirname(backupPath);
  await assertCanonicalPrivateDirectory(canonicalParent);
  if ((await realpath(backupPath)) !== backupPath) {
    throw new Error('A recorded backup path escaped its original directory.');
  }
  const digest = await hashFile(backupPath);
  if (digest.sha256 !== backup.sha256 || digest.sizeBytes !== backup.size_bytes) {
    throw new Error('A recorded backup changed after Forgeboard created it.');
  }
  await assertCanonicalPrivateDirectory(canonicalParent);
  const finalStats = await lstat(backupPath);
  if (
    !finalStats.isFile() ||
    finalStats.isSymbolicLink() ||
    finalStats.dev !== digest.dev ||
    finalStats.ino !== digest.ino ||
    (await realpath(backupPath)) !== backupPath
  ) {
    throw new Error('A recorded backup changed before it could be removed.');
  }
  await unlink(backupPath);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
