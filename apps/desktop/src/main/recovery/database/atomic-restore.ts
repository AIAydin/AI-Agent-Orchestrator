import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { StagedSelectedBackup } from './selected-backup.js';

const RESTORE_DIRECTORY_PREFIX = '.forgeboard-database-restore-';
const DISCARD_DIRECTORY_PREFIX = '.forgeboard-database-discard-';
const JOURNAL_NAME = 'operation.jsonl';
const CANDIDATE_NAME = 'candidate.sqlite';

type RestorePhase =
  | 'prepared'
  | 'quarantining'
  | 'quarantined'
  | 'installed'
  | 'completed'
  | 'rolling-back'
  | 'rolled-back';

interface RestoreJournalEvent {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly phase: RestorePhase;
  readonly files?: readonly string[];
  readonly priorState?: 'absent' | 'present';
  readonly installedSha256?: Readonly<Record<string, string>>;
  readonly priorSha256?: Readonly<Record<string, string>>;
  readonly sourceSha256?: string;
}

export interface AtomicRestoreFilesystem {
  readonly appendJournal: (path: string, event: RestoreJournalEvent) => Promise<void>;
  readonly chmod: typeof chmod;
  readonly copyFile: typeof copyFile;
  readonly lstat: typeof lstat;
  readonly mkdir: typeof mkdir;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
  readonly syncDirectory: (path: string) => Promise<void>;
  readonly syncFile: (path: string) => Promise<void>;
}

export interface AtomicDatabaseRestoreOptions {
  /** A private, exact-byte-bound selection. This file is never renamed, removed, or mutated. */
  readonly stagedBackup: StagedSelectedBackup;
  /** The inactive primary database path. No process may have it open during this operation. */
  readonly databasePath: string;
  /**
   * Opens, migrates, and fully validates the private candidate, then closes every database handle.
   * Older valid backups are therefore migrated only after copying; the source is never changed.
   */
  readonly validateStagedDatabase: (candidatePath: string) => Promise<void> | void;
  /** Reopens and validates the installed database after the atomic rename. */
  readonly validateInstalledDatabase?: (databasePath: string) => Promise<void> | void;
  readonly operationId?: string;
  readonly platform?: NodeJS.Platform;
  /** Required on Windows because chmod does not establish a private DACL. */
  readonly windowsPrivacy?: AtomicRestoreWindowsPrivacy;
  /** Required on Windows until a native write-through rename/parent flush authority is installed. */
  readonly windowsDurability?: AtomicRestoreWindowsDurability;
  readonly filesystem?: Partial<AtomicRestoreFilesystem>;
}

export interface AtomicRestoreWindowsPrivacy {
  readonly protectPrivateDirectory: (path: string) => Promise<void>;
  readonly protectPrivateFile: (path: string) => Promise<void>;
}

export interface AtomicRestoreWindowsDurability {
  readonly createDirectoryWriteThrough: (path: string) => Promise<void>;
  readonly renameWriteThrough: (
    source: string,
    destination: string,
    replaceExisting?: boolean,
  ) => Promise<void>;
  readonly syncFile: (path: string) => Promise<void>;
}

export interface AtomicDatabaseRestoreResult {
  readonly operationId: string;
  /** Contains the exact displaced primary database and any pre-existing WAL/SHM sidecars. */
  readonly quarantineDirectory: string;
  readonly restoredDatabasePath: string;
}

const nodeFilesystem: AtomicRestoreFilesystem = {
  appendJournal: appendDurableJournal,
  chmod,
  copyFile,
  lstat,
  mkdir,
  rename,
  rm,
  syncDirectory: syncPath,
  syncFile: syncPath,
};

/**
 * Replaces an inactive primary database with a privately staged and validated backup copy.
 *
 * The caller must enforce process quiescence. The source backup remains untouched. A successful
 * operation deliberately retains the displaced database inside `quarantineDirectory`; a failed
 * operation restores every displaced file or reports rollback errors without hiding them.
 */
export async function restoreDatabaseAtomically(
  options: AtomicDatabaseRestoreOptions,
): Promise<AtomicDatabaseRestoreResult> {
  const sourceBackupPath = validAbsolutePath(options.stagedBackup.stagedPath, 'backup');
  const sourceSha256 = validSha256(options.stagedBackup.sourceSha256, 'source backup');
  const databasePath = validAbsolutePath(options.databasePath, 'database');
  const operationId = validOperationId(options.operationId ?? randomUUID());
  const platform = options.platform ?? process.platform;
  const filesystem = {
    ...nodeFilesystem,
    ...options.filesystem,
    ...(options.windowsDurability === undefined
      ? {}
      : { syncFile: options.windowsDurability.syncFile }),
  };
  const databaseDirectory = dirname(databasePath);
  const databaseName = basename(databasePath);
  const restoreDirectory = join(databaseDirectory, `${RESTORE_DIRECTORY_PREFIX}${operationId}`);
  const candidatePath = join(restoreDirectory, CANDIDATE_NAME);
  const journalPath = join(restoreDirectory, JOURNAL_NAME);
  const primaryPaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`] as const;
  const quarantinePaths = new Map(
    primaryPaths.map((path) => [path, join(restoreDirectory, `previous-${basename(path)}`)]),
  );

  if (
    sourceBackupPath === databasePath ||
    primaryPaths.includes(sourceBackupPath) ||
    dirname(sourceBackupPath) === restoreDirectory
  ) {
    throw new Error('The selected backup must be separate from the active database files.');
  }
  if (platform === 'win32' && options.windowsPrivacy === undefined) {
    throw new Error('Windows database restore requires a private filesystem authority.');
  }
  if (platform === 'win32' && options.windowsDurability === undefined) {
    throw new Error('Windows database restore requires a durable filesystem authority.');
  }

  await protectDirectory(filesystem, databaseDirectory, platform, options.windowsPrivacy);
  await createRestoreDirectory(filesystem, restoreDirectory, platform, options.windowsDurability);
  let mutationStarted = false;
  let candidateInstalled = false;
  const existingPrimaryPaths: string[] = [];
  const movedPrimaryPaths: string[] = [];
  const priorSha256: Record<string, string> = {};
  let priorState: 'absent' | 'present' = 'absent';
  try {
    await protectDirectory(filesystem, restoreDirectory, platform, options.windowsPrivacy);
    await syncRestoreNamespaces(filesystem, databaseDirectory, restoreDirectory, platform);
    await assertOrdinaryFile(filesystem, sourceBackupPath, 'selected backup');
    await filesystem.copyFile(sourceBackupPath, candidatePath, constants.COPYFILE_EXCL);
    await protectFile(filesystem, candidatePath, platform, options.windowsPrivacy);
    await assertOrdinaryFile(filesystem, candidatePath, 'staged backup');
    const copiedIdentity = await hashStableFile(filesystem, candidatePath);
    if (
      copiedIdentity.sha256 !== options.stagedBackup.sha256 ||
      copiedIdentity.sizeBytes !== options.stagedBackup.sizeBytes
    ) {
      throw new Error('The private staged backup no longer matches its verified identity.');
    }

    // This callback may migrate the candidate in place, which is why it must run only after copy.
    await options.validateStagedDatabase(candidatePath);
    await assertOrdinaryFile(filesystem, candidatePath, 'validated staged backup');
    await filesystem.syncFile(candidatePath);
    if (platform !== 'win32') await filesystem.syncDirectory(restoreDirectory);

    for (const path of primaryPaths) {
      const stats = await optionalLstat(filesystem, path);
      if (stats === undefined) continue;
      assertOrdinaryStats(stats, path === databasePath ? 'primary database' : 'database sidecar');
      existingPrimaryPaths.push(path);
    }
    priorState = existingPrimaryPaths.includes(databasePath) ? 'present' : 'absent';
    if (priorState === 'absent' && existingPrimaryPaths.length > 0) {
      throw new Error(
        'Database sidecars exist without the primary database; restore was not started.',
      );
    }
    for (const path of existingPrimaryPaths) {
      priorSha256[basename(path)] = (await hashStableFile(filesystem, path)).sha256;
    }

    await recordPreparedJournal(
      filesystem,
      journalPath,
      operationId,
      existingPrimaryPaths,
      databaseName,
      {
        ...(priorState === 'present' ? { priorSha256 } : {}),
        priorState,
        sourceSha256,
      },
      platform,
      options.windowsDurability,
      options.windowsPrivacy,
    );
    if (platform !== 'win32') await filesystem.syncDirectory(restoreDirectory);
    mutationStarted = true;
    await record(
      filesystem,
      journalPath,
      operationId,
      'quarantining',
      existingPrimaryPaths.length === 0 ? undefined : existingPrimaryPaths,
      databaseName,
    );
    // Move the database last so an interrupted operation is easy to distinguish from a healthy DB.
    const quarantineOrder = [
      ...existingPrimaryPaths.filter((path) => path !== databasePath),
      ...(existingPrimaryPaths.includes(databasePath) ? [databasePath] : []),
    ];
    for (const path of quarantineOrder) {
      const quarantinePath = requiredMapValue(quarantinePaths, path);
      await renameRestorePath(
        filesystem,
        path,
        quarantinePath,
        platform,
        options.windowsDurability,
      );
      movedPrimaryPaths.push(path);
      await protectFile(filesystem, quarantinePath, platform, options.windowsPrivacy);
      await filesystem.syncFile(quarantinePath);
      await syncRestoreNamespaces(filesystem, databaseDirectory, restoreDirectory, platform);
    }
    await record(
      filesystem,
      journalPath,
      operationId,
      'quarantined',
      existingPrimaryPaths.length === 0 ? undefined : existingPrimaryPaths,
      databaseName,
    );

    // Staging beside the destination keeps this rename on one filesystem and atomic.
    await renameRestorePath(
      filesystem,
      candidatePath,
      databasePath,
      platform,
      options.windowsDurability,
    );
    candidateInstalled = true;
    await filesystem.syncFile(databasePath);
    await syncRestoreNamespaces(filesystem, databaseDirectory, restoreDirectory, platform);
    await record(filesystem, journalPath, operationId, 'installed', undefined, databaseName);
    await (options.validateInstalledDatabase ?? options.validateStagedDatabase)(databasePath);
    await assertOrdinaryFile(filesystem, databasePath, 'installed database');
    const installedSha256: Record<string, string> = {};
    for (const path of primaryPaths) {
      const stats = await optionalLstat(filesystem, path);
      if (stats === undefined) continue;
      assertOrdinaryStats(stats, 'installed database file');
      await protectFile(filesystem, path, platform, options.windowsPrivacy);
      await filesystem.syncFile(path);
      installedSha256[basename(path)] = (await hashStableFile(filesystem, path)).sha256;
    }
    if (platform !== 'win32') await filesystem.syncDirectory(databaseDirectory);
    await record(filesystem, journalPath, operationId, 'completed', undefined, databaseName, {
      installedSha256,
    });
    return {
      operationId,
      quarantineDirectory: restoreDirectory,
      restoredDatabasePath: databasePath,
    };
  } catch (error) {
    if (!mutationStarted) {
      await filesystem
        .rm(restoreDirectory, { recursive: true, force: true })
        .catch(() => undefined);
      throw error;
    }
    const rollbackErrors = await rollback({
      candidatePath,
      candidateInstalled,
      databasePath,
      databaseName,
      existingPrimaryPaths,
      filesystem,
      journalPath,
      movedPrimaryPaths,
      operationId,
      priorSha256,
      priorState,
      platform,
      quarantinePaths,
      restoreDirectory,
      ...(options.windowsDurability === undefined
        ? {}
        : { windowsDurability: options.windowsDurability }),
    });
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Database restore failed and the prior database could not be fully restored. The recovery journal and quarantined files were preserved.',
      );
    }
    throw error;
  }
}

interface RollbackContext {
  readonly candidatePath: string;
  readonly candidateInstalled: boolean;
  readonly databasePath: string;
  readonly databaseName: string;
  readonly existingPrimaryPaths: readonly string[];
  readonly filesystem: AtomicRestoreFilesystem;
  readonly journalPath: string;
  readonly movedPrimaryPaths: readonly string[];
  readonly operationId: string;
  readonly priorSha256: Readonly<Record<string, string>>;
  readonly priorState: 'absent' | 'present';
  readonly platform: NodeJS.Platform;
  readonly quarantinePaths: ReadonlyMap<string, string>;
  readonly restoreDirectory: string;
  readonly windowsDurability?: AtomicRestoreWindowsDurability;
}

async function rollback(context: RollbackContext): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    await record(
      context.filesystem,
      context.journalPath,
      context.operationId,
      'rolling-back',
      context.existingPrimaryPaths.length === 0 ? undefined : context.existingPrimaryPaths,
      context.databaseName,
    );
  } catch (error) {
    // The prior durable phase remains authoritative. Do not perform even one rollback rename until
    // reconciliation can prove that the rolling-back transition itself reached stable storage.
    return [error];
  }

  // Preserve a candidate that reached the destination instead of deleting potentially useful data.
  for (const installedPath of context.candidateInstalled
    ? [context.databasePath, `${context.databasePath}-wal`, `${context.databasePath}-shm`]
    : []) {
    const stats = await optionalLstat(context.filesystem, installedPath).catch((error: unknown) => {
      errors.push(error);
      return undefined;
    });
    if (stats === undefined) continue;
    try {
      assertOrdinaryStats(stats, 'failed installed database file');
      await renameRestorePath(
        context.filesystem,
        installedPath,
        join(dirname(context.candidatePath), `failed-${basename(installedPath)}`),
        context.platform,
        context.windowsDurability,
      );
      await context.filesystem.syncFile(
        join(dirname(context.candidatePath), `failed-${basename(installedPath)}`),
      );
      await syncRestoreNamespaces(
        context.filesystem,
        dirname(context.databasePath),
        context.restoreDirectory,
        context.platform,
      );
    } catch (error) {
      errors.push(error);
    }
  }

  // Restore the primary first, then its exact pre-operation sidecars.
  for (const originalPath of orderedPrimaryPaths(context.movedPrimaryPaths, context.databasePath)) {
    const quarantinePath = requiredMapValue(context.quarantinePaths, originalPath);
    const quarantined = await optionalLstat(context.filesystem, quarantinePath).catch(
      (error: unknown) => {
        errors.push(error);
        return undefined;
      },
    );
    if (quarantined === undefined) continue;
    try {
      assertOrdinaryStats(quarantined, 'quarantined database file');
      await assertExpectedIdentity(
        context.filesystem,
        quarantinePath,
        context.priorSha256[basename(originalPath)],
      );
      if ((await optionalLstat(context.filesystem, originalPath)) !== undefined) {
        throw new Error('Rollback refused to overwrite an unexpected database file.');
      }
      await renameRestorePath(
        context.filesystem,
        quarantinePath,
        originalPath,
        context.platform,
        context.windowsDurability,
      );
      await context.filesystem.syncFile(originalPath);
      await syncRestoreNamespaces(
        context.filesystem,
        dirname(context.databasePath),
        context.restoreDirectory,
        context.platform,
      );
    } catch (error) {
      errors.push(error);
    }
  }

  for (const originalPath of context.existingPrimaryPaths) {
    try {
      await assertExpectedIdentity(
        context.filesystem,
        originalPath,
        context.priorSha256[basename(originalPath)],
      );
    } catch (error) {
      errors.push(error);
    }
  }

  if (context.priorState === 'absent') {
    for (const path of [
      context.databasePath,
      `${context.databasePath}-wal`,
      `${context.databasePath}-shm`,
    ]) {
      try {
        if ((await optionalLstat(context.filesystem, path)) !== undefined) {
          throw new Error('Rollback could not restore the journaled absent database state.');
        }
      } catch (error) {
        errors.push(error);
      }
    }
  }

  if (errors.length === 0) {
    await record(
      context.filesystem,
      context.journalPath,
      context.operationId,
      'rolled-back',
      undefined,
      context.databaseName,
    ).catch((error: unknown) => errors.push(error));
  }
  if (errors.length === 0) {
    await discardRestoreDirectory(context).catch((error: unknown) => errors.push(error));
  }
  return errors;
}

async function assertExpectedIdentity(
  filesystem: AtomicRestoreFilesystem,
  path: string,
  expectedSha256: string | undefined,
): Promise<void> {
  if (
    expectedSha256 === undefined ||
    (await hashStableFile(filesystem, path)).sha256 !== expectedSha256
  ) {
    throw new Error('Prior database evidence does not match its prepared identity.');
  }
}

async function discardRestoreDirectory(context: RollbackContext): Promise<void> {
  const databaseDirectory = dirname(context.databasePath);
  const discardDirectory = join(
    databaseDirectory,
    `${DISCARD_DIRECTORY_PREFIX}${context.operationId}`,
  );
  if ((await optionalLstat(context.filesystem, discardDirectory)) !== undefined) {
    throw new Error('A discarded restore directory already exists.');
  }
  await renameRestorePath(
    context.filesystem,
    context.restoreDirectory,
    discardDirectory,
    context.platform,
    context.windowsDurability,
  );
  if (context.platform !== 'win32') await context.filesystem.syncDirectory(databaseDirectory);
  await context.filesystem.rm(discardDirectory, { recursive: true, force: true });
  if (context.platform !== 'win32') await context.filesystem.syncDirectory(databaseDirectory);
}

async function optionalLstat(
  filesystem: AtomicRestoreFilesystem,
  path: string,
): Promise<Stats | undefined> {
  try {
    return await filesystem.lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertOrdinaryFile(
  filesystem: AtomicRestoreFilesystem,
  path: string,
  label: string,
): Promise<void> {
  assertOrdinaryStats(await filesystem.lstat(path), label);
}

async function hashStableFile(
  filesystem: AtomicRestoreFilesystem,
  path: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const before = await filesystem.lstat(path);
  assertOrdinaryStats(before, 'private staged backup');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const descriptorBefore = await handle.stat();
    if (!sameStableFile(before, descriptorBefore)) {
      throw new Error('The private staged backup changed before identity verification.');
    }
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
    }
    const descriptorAfter = await handle.stat();
    const pathAfter = await filesystem.lstat(path);
    if (
      sizeBytes !== descriptorAfter.size ||
      !sameStableFile(descriptorBefore, descriptorAfter) ||
      !sameStableFile(descriptorAfter, pathAfter) ||
      pathAfter.isSymbolicLink()
    ) {
      throw new Error('The private staged backup changed during identity verification.');
    }
    return { sha256: hash.digest('hex'), sizeBytes };
  } finally {
    await handle.close();
  }
}

function sameStableFile(
  left: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>,
  right: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertOrdinaryStats(stats: Stats, label: string): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`The ${label} must be an ordinary file.`);
  }
}

async function protectDirectory(
  filesystem: AtomicRestoreFilesystem,
  path: string,
  platform: NodeJS.Platform,
  windowsPrivacy: AtomicRestoreWindowsPrivacy | undefined,
): Promise<void> {
  if (platform === 'win32') {
    if (windowsPrivacy === undefined) throw new Error('Windows privacy authority is unavailable.');
    await windowsPrivacy.protectPrivateDirectory(path);
    return;
  }
  await filesystem.chmod(path, 0o700);
  const stats = await filesystem.lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error('The database restore directory is not private.');
  }
}

async function protectFile(
  filesystem: AtomicRestoreFilesystem,
  path: string,
  platform: NodeJS.Platform,
  windowsPrivacy: AtomicRestoreWindowsPrivacy | undefined,
): Promise<void> {
  if (platform === 'win32') {
    if (windowsPrivacy === undefined) throw new Error('Windows privacy authority is unavailable.');
    await windowsPrivacy.protectPrivateFile(path);
    return;
  }
  await filesystem.chmod(path, 0o600);
  const stats = await filesystem.lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new Error('A database restore file is not private.');
  }
}

async function record(
  filesystem: AtomicRestoreFilesystem,
  journalPath: string,
  operationId: string,
  phase: RestorePhase,
  absoluteFiles: readonly string[] | undefined,
  databaseName: string,
  evidence?: Pick<
    RestoreJournalEvent,
    'installedSha256' | 'priorSha256' | 'priorState' | 'sourceSha256'
  >,
): Promise<void> {
  await filesystem.appendJournal(journalPath, {
    schemaVersion: 1,
    operationId,
    phase,
    ...(absoluteFiles === undefined
      ? {}
      : {
          files: absoluteFiles.map((path) =>
            path.endsWith('-wal')
              ? `${databaseName}-wal`
              : path.endsWith('-shm')
                ? `${databaseName}-shm`
                : databaseName,
          ),
        }),
    ...evidence,
  });
  await filesystem.syncFile(journalPath);
}

async function recordPreparedJournal(
  filesystem: AtomicRestoreFilesystem,
  journalPath: string,
  operationId: string,
  absoluteFiles: readonly string[],
  databaseName: string,
  evidence: Pick<RestoreJournalEvent, 'priorSha256' | 'priorState' | 'sourceSha256'>,
  platform: NodeJS.Platform,
  windowsDurability: AtomicRestoreWindowsDurability | undefined,
  windowsPrivacy: AtomicRestoreWindowsPrivacy | undefined,
): Promise<void> {
  if (platform !== 'win32') {
    await record(
      filesystem,
      journalPath,
      operationId,
      'prepared',
      absoluteFiles,
      databaseName,
      evidence,
    );
    await protectFile(filesystem, journalPath, platform, windowsPrivacy);
    await filesystem.syncFile(journalPath);
    return;
  }

  const unpublishedJournalPath = `${journalPath}.prepared`;
  await record(
    filesystem,
    unpublishedJournalPath,
    operationId,
    'prepared',
    absoluteFiles,
    databaseName,
    evidence,
  );
  await protectFile(filesystem, unpublishedJournalPath, platform, windowsPrivacy);
  await filesystem.syncFile(unpublishedJournalPath);
  await renameRestorePath(
    filesystem,
    unpublishedJournalPath,
    journalPath,
    platform,
    windowsDurability,
  );
  await protectFile(filesystem, journalPath, platform, windowsPrivacy);
  await filesystem.syncFile(journalPath);
}

async function appendDurableJournal(path: string, event: RestoreJournalEvent): Promise<void> {
  // JSONL tolerates one incomplete final record after a power loss. Every completed record is
  // flushed before the next filesystem mutation.
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncRestoreNamespaces(
  filesystem: AtomicRestoreFilesystem,
  databaseDirectory: string,
  restoreDirectory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === 'win32') return;
  await filesystem.syncDirectory(restoreDirectory);
  await filesystem.syncDirectory(databaseDirectory);
}

async function createRestoreDirectory(
  filesystem: AtomicRestoreFilesystem,
  path: string,
  platform: NodeJS.Platform,
  windowsDurability: AtomicRestoreWindowsDurability | undefined,
): Promise<void> {
  if (platform === 'win32') {
    if (windowsDurability === undefined) {
      throw new Error('Windows database restore requires a durable filesystem authority.');
    }
    await windowsDurability.createDirectoryWriteThrough(path);
    return;
  }
  await filesystem.mkdir(path, { mode: 0o700 });
}

async function renameRestorePath(
  filesystem: AtomicRestoreFilesystem,
  source: string,
  destination: string,
  platform: NodeJS.Platform,
  windowsDurability: AtomicRestoreWindowsDurability | undefined,
): Promise<void> {
  if (platform === 'win32') {
    if (windowsDurability === undefined) {
      throw new Error('Windows database restore requires a durable filesystem authority.');
    }
    await windowsDurability.renameWriteThrough(source, destination, false);
    return;
  }
  await filesystem.rename(source, destination);
}

function orderedPrimaryPaths(paths: readonly string[], databasePath: string): readonly string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].filter((path) =>
    paths.includes(path),
  );
}

function validAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes('\0') || resolve(value) !== value) {
    throw new Error(`The ${label} path must be absolute and normalized.`);
  }
  return value;
}

function validOperationId(value: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/u.test(value)) {
    throw new Error('The database restore operation identifier is invalid.');
  }
  return value;
}

function validSha256(value: string | undefined, label: string): string {
  if (value === undefined || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`The ${label} identity is invalid.`);
  }
  return value;
}

function requiredMapValue(map: ReadonlyMap<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined) throw new Error('Database restore path mapping is incomplete.');
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
