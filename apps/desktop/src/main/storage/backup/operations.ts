import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { backup as sqliteBackup, type DatabaseSync } from 'node:sqlite';

import {
  windowsFilesystemSecurity,
  type WindowsFilesystemSecurity,
} from '../../security/windows/filesystem-acl.js';
import type { BackupResult } from '../../storage-schemas.js';
import { clearAllTables, transaction } from '../database.js';
import { assertBackupIntegrity } from '../integrity.js';
import { type BackupRow, isRecord } from '../values.js';

interface FileDigest {
  sha256: string;
  sizeBytes: number;
  dev: number;
  ino: number;
}

interface SequencedBackupRow extends BackupRow {
  readonly sequence: number;
}

export interface DeleteAllLocalDataOptions {
  readonly approvedMissingBackupIds?: readonly string[];
}

export interface BackupFilesystemSecurityDependencies {
  readonly platform?: NodeJS.Platform;
  readonly windowsSecurity?: WindowsFilesystemSecurity;
}

interface ActiveBackupFilesystemSecurity {
  readonly platform: NodeJS.Platform;
  readonly windows:
    | {
        readonly authority: WindowsFilesystemSecurity;
        readonly sid: string;
      }
    | undefined;
}

export class MissingRecordedBackupsError extends Error {
  public constructor(public readonly count: number) {
    super(
      `${count} recorded backup ${count === 1 ? 'file is' : 'files are'} unavailable. Reconnect the backup location or explicitly forget the missing ${count === 1 ? 'record' : 'records'}.`,
    );
    this.name = 'MissingRecordedBackupsError';
  }
}

export async function createBackup(
  database: DatabaseSync,
  destinationDirectory: string,
  now = new Date(),
  securityDependencies: BackupFilesystemSecurityDependencies = {},
): Promise<BackupResult> {
  const security = await resolveBackupFilesystemSecurity(securityDependencies);
  const requestedDirectory = resolve(destinationDirectory);
  const canonicalDirectory = await prepareBackupDestination(requestedDirectory, security);
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const backupId = randomUUID();
  const target = join(canonicalDirectory, `forgeboard-${timestamp}-${backupId}.sqlite3`);
  const stagingDirectory = join(canonicalDirectory, `.forgeboard-backup-${backupId}`);
  let targetCreated = false;
  try {
    await assertCanonicalPrivateDirectory(canonicalDirectory, security);
    await mkdir(stagingDirectory, { mode: 0o700 });
    if (security.windows !== undefined) {
      await security.windows.authority.protectPrivateDirectory(
        stagingDirectory,
        security.windows.sid,
      );
    }
    const canonicalStagingDirectory = await realpath(stagingDirectory);
    if (
      canonicalStagingDirectory !== stagingDirectory ||
      dirname(canonicalStagingDirectory) !== canonicalDirectory
    ) {
      throw new Error('The backup staging path escaped the selected destination.');
    }
    await assertCanonicalPrivateDirectory(canonicalStagingDirectory, security, true);
    const stagedTarget = join(canonicalStagingDirectory, 'backup.sqlite3');
    await sqliteBackup(database, stagedTarget);
    const stagedStats = await lstat(stagedTarget);
    if (!stagedStats.isFile() || stagedStats.isSymbolicLink()) {
      throw new Error('SQLite did not create an ordinary backup file.');
    }
    await chmod(stagedTarget, 0o600);
    if (security.windows !== undefined) {
      await security.windows.authority.protectPrivateFile(stagedTarget, security.windows.sid);
    }
    const canonicalStagedTarget = await realpath(stagedTarget);
    if (
      canonicalStagedTarget !== stagedTarget ||
      dirname(canonicalStagedTarget) !== canonicalStagingDirectory
    ) {
      throw new Error('The backup file escaped its private staging directory.');
    }
    assertBackupIntegrity(canonicalStagedTarget);
    const stagedDigest = await hashFile(canonicalStagedTarget);
    await assertCanonicalPrivateDirectory(canonicalDirectory, security);
    await assertCanonicalPrivateDirectory(canonicalStagingDirectory, security, true);
    if (security.windows !== undefined) {
      await security.windows.authority.assertPrivateFile(
        canonicalStagedTarget,
        security.windows.sid,
      );
    }
    await link(canonicalStagedTarget, target);
    targetCreated = true;
    await assertCanonicalPrivateDirectory(canonicalDirectory, security);
    const canonicalTarget = await realpath(target);
    if (canonicalTarget !== target || dirname(canonicalTarget) !== canonicalDirectory) {
      throw new Error('The backup path escaped the selected destination.');
    }
    if (security.windows !== undefined) {
      await security.windows.authority.assertPrivateFile(canonicalTarget, security.windows.sid);
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
    // alongside Artemis's transient files.
    await cleanupBackupStagingDirectory(stagingDirectory, canonicalDirectory, security);
    database
      .prepare(
        `INSERT INTO backup_records(id, canonical_path, created_at, sha256, size_bytes)
         VALUES(?, ?, ?, ?, ?)`,
      )
      .run(backupId, result.path, result.createdAt, result.sha256, result.sizeBytes);
    return result;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (targetCreated) {
      try {
        await removeContainedOrdinaryFile(target, canonicalDirectory, security);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await cleanupBackupStagingDirectory(stagingDirectory, canonicalDirectory, security);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Backup creation failed and its private temporary data could not be fully removed.',
      );
    }
    throw error;
  }
}

export async function pruneBackups(
  database: DatabaseSync,
  retentionCount: number,
  protectedBackupPath: string,
  securityDependencies: BackupFilesystemSecurityDependencies = {},
): Promise<number> {
  // Filesystem deletion and SQLite ledger deletion cannot form one atomic transaction. This is an
  // oldest-first, best-effort rotation: each verified file is removed before its exact ledger row,
  // and callers must persist the required redacted authorization audit before entering this loop.
  const security = await resolveBackupFilesystemSecurity(securityDependencies);
  if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) {
    throw new Error('Backup retention must be an integer from 1 through 365.');
  }
  const protectedBackup = database
    .prepare('SELECT id FROM backup_records WHERE canonical_path = ?')
    .get(protectedBackupPath) as { id: string } | undefined;
  if (protectedBackup === undefined) {
    throw new Error('The newly created backup is missing from the verified backup ledger.');
  }
  const protectedDirectory = dirname(protectedBackupPath);
  const destinationRows = (
    database
      .prepare(
        `SELECT rowid AS sequence, id, canonical_path, sha256, size_bytes
       FROM backup_records
       ORDER BY rowid DESC`,
      )
      .all() as unknown as SequencedBackupRow[]
  ).filter((backup) => dirname(backup.canonical_path) === protectedDirectory);
  const retainedIds = new Set<string>([protectedBackup.id]);
  for (const backup of destinationRows) {
    if (retainedIds.size >= retentionCount) break;
    retainedIds.add(backup.id);
  }
  const rows = destinationRows
    .filter((backup) => !retainedIds.has(backup.id))
    .sort((left, right) => left.sequence - right.sequence);
  let deleted = 0;
  for (const backup of rows) {
    if ((await removeRecordedBackup(backup, security)) === 'missing') {
      throw new MissingRecordedBackupsError(1);
    }
    const result = database
      .prepare(
        `DELETE FROM backup_records
         WHERE id = ? AND canonical_path = ? AND sha256 = ? AND size_bytes = ?`,
      )
      .run(backup.id, backup.canonical_path, backup.sha256, backup.size_bytes);
    deleted += Number(result.changes);
  }
  return deleted;
}

export async function deleteAllLocalData(
  database: DatabaseSync,
  options: DeleteAllLocalDataOptions = {},
  securityDependencies: BackupFilesystemSecurityDependencies = {},
): Promise<void> {
  const backups = database
    .prepare(
      'SELECT id, canonical_path, sha256, size_bytes FROM backup_records ORDER BY created_at',
    )
    .all() as unknown as BackupRow[];
  const missingIds = new Set(await listMissingRecordedBackupIdsFromRows(backups));
  const approvedMissingIds = new Set(options.approvedMissingBackupIds ?? []);
  const unapprovedMissingIds = [...missingIds].filter((id) => !approvedMissingIds.has(id));
  if (unapprovedMissingIds.length > 0) {
    throw new MissingRecordedBackupsError(unapprovedMissingIds.length);
  }
  const availableBackups = backups.filter((backup) => !missingIds.has(backup.id));
  const security =
    availableBackups.length > 0
      ? await resolveBackupFilesystemSecurity(securityDependencies)
      : undefined;
  for (const backup of backups) {
    if (missingIds.has(backup.id)) continue;
    if (security === undefined) throw new Error('Backup filesystem security was not initialized.');
    const outcome = await removeRecordedBackup(backup, security);
    if (outcome === 'missing' && !approvedMissingIds.has(backup.id)) {
      throw new MissingRecordedBackupsError(1);
    }
  }
  transaction(database, () => clearAllTables(database));
  database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  database.exec('VACUUM;');
  database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
}

export async function listMissingRecordedBackupIds(
  database: DatabaseSync,
  suppliedBackups?: BackupRow[],
): Promise<string[]> {
  const backups =
    suppliedBackups ??
    (database
      .prepare('SELECT id, canonical_path, sha256, size_bytes FROM backup_records ORDER BY rowid')
      .all() as unknown as BackupRow[]);
  return await listMissingRecordedBackupIdsFromRows(backups);
}

async function listMissingRecordedBackupIdsFromRows(backups: readonly BackupRow[]) {
  const missingIds: string[] = [];
  for (const backup of backups) {
    if (await recordedBackupIsMissing(backup)) missingIds.push(backup.id);
  }
  return missingIds;
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

function assertPrivateDirectory(stats: Stats, platform = process.platform): void {
  if (platform === 'win32') return;
  if ((stats.mode & 0o022) !== 0) {
    throw new Error('The backup destination must not be writable by group or other users.');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('The backup destination must be owned by the current user.');
  }
}

async function resolveBackupFilesystemSecurity(
  dependencies: BackupFilesystemSecurityDependencies,
): Promise<ActiveBackupFilesystemSecurity> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') return { platform, windows: undefined };
  const authority = dependencies.windowsSecurity ?? windowsFilesystemSecurity;
  const sid = await authority.currentUserSid();
  return { platform, windows: { authority, sid } };
}

async function prepareBackupDestination(
  requestedDirectory: string,
  security: ActiveBackupFilesystemSecurity,
): Promise<string> {
  if (security.windows !== undefined && !(await pathExists(requestedDirectory))) {
    const existingParent = await nearestExistingCanonicalDirectory(dirname(requestedDirectory));
    await security.windows.authority.assertSafeParent(existingParent, security.windows.sid);
  }

  const firstCreatedDirectory = await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await realpath(requestedDirectory);
  if (security.windows !== undefined && firstCreatedDirectory !== undefined) {
    await security.windows.authority.protectPrivateDirectory(
      canonicalDirectory,
      security.windows.sid,
    );
    await assertCanonicalPrivateDirectory(canonicalDirectory, security, true);
    return canonicalDirectory;
  }
  await assertCanonicalPrivateDirectory(canonicalDirectory, security);
  return canonicalDirectory;
}

async function nearestExistingCanonicalDirectory(start: string): Promise<string> {
  let candidate = start;
  while (true) {
    try {
      const canonicalCandidate = await realpath(candidate);
      const stats = await lstat(canonicalCandidate);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('A parent of the backup destination is not an ordinary directory.');
      }
      return canonicalCandidate;
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error('Artemis could not find an existing backup destination parent.');
    }
    candidate = parent;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

async function assertCanonicalPrivateDirectory(
  path: string,
  security: ActiveBackupFilesystemSecurity,
  requireExactWindowsPrivacy = false,
): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('The backup destination is not an ordinary directory.');
  }
  if ((await realpath(path)) !== path) {
    throw new Error('The backup destination is no longer canonical.');
  }
  if (security.windows !== undefined) {
    if (requireExactWindowsPrivacy) {
      await security.windows.authority.assertPrivateDirectory(path, security.windows.sid);
    } else {
      await security.windows.authority.assertConfidentialParent(path, security.windows.sid);
    }
    return;
  }
  assertPrivateDirectory(stats, security.platform);
}

async function removeContainedOrdinaryFile(
  path: string,
  expectedParent: string,
  security: ActiveBackupFilesystemSecurity,
  requireExactWindowsParentPrivacy = false,
): Promise<void> {
  try {
    await assertCanonicalPrivateDirectory(
      expectedParent,
      security,
      requireExactWindowsParentPrivacy,
    );
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
  security: ActiveBackupFilesystemSecurity,
): Promise<void> {
  await assertCanonicalPrivateDirectory(expectedParent, security);
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
  await assertCanonicalPrivateDirectory(canonicalStagingDirectory, security, true);
  for (const name of [
    'backup.sqlite3',
    'backup.sqlite3-wal',
    'backup.sqlite3-shm',
    'backup.sqlite3-journal',
  ]) {
    await removeContainedOrdinaryFile(
      join(canonicalStagingDirectory, name),
      canonicalStagingDirectory,
      security,
      true,
    );
  }
  try {
    await rmdir(canonicalStagingDirectory);
  } catch (error) {
    if (!isFileNotFound(error) && (!isRecord(error) || error.code !== 'ENOTEMPTY')) throw error;
  }
}

async function recordedBackupIsMissing(backup: BackupRow): Promise<boolean> {
  const backupPath = assertRecordedBackupPath(backup);
  try {
    const stats = await lstat(backupPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('A recorded backup is no longer an ordinary file.');
    }
    return false;
  } catch (error) {
    if (isFileNotFound(error)) return true;
    throw error;
  }
}

function assertRecordedBackupPath(backup: BackupRow): string {
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
  return backupPath;
}

async function removeRecordedBackup(
  backup: BackupRow,
  security: ActiveBackupFilesystemSecurity,
): Promise<'removed' | 'missing'> {
  const backupPath = assertRecordedBackupPath(backup);
  const canonicalParent = dirname(backupPath);
  let backupStats: Stats;
  try {
    backupStats = await lstat(backupPath);
  } catch (error) {
    if (isFileNotFound(error)) return 'missing';
    throw error;
  }
  if (!backupStats.isFile() || backupStats.isSymbolicLink()) {
    throw new Error('A recorded backup is no longer an ordinary file.');
  }
  await assertCanonicalPrivateDirectory(canonicalParent, security);
  if ((await realpath(backupPath)) !== backupPath) {
    throw new Error('A recorded backup path escaped its original directory.');
  }
  const digest = await hashFile(backupPath);
  if (digest.sha256 !== backup.sha256 || digest.sizeBytes !== backup.size_bytes) {
    throw new Error('A recorded backup changed after Artemis created it.');
  }
  await assertCanonicalPrivateDirectory(canonicalParent, security);
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
  return 'removed';
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
