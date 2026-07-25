import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { GitEngineError } from '../../model/errors.js';
import type { RepositoryService } from '../service.js';
import type { GitCommonDirectoryIdentity } from './contracts.js';
import { replaceFileAtomically } from './windows-durable-replace.js';

const CONFIGURATION_FILE_LIMIT = 32 * 1_024 * 1_024;
const MUTATION_OUTPUT_LIMIT = 64 * 1_024;
const NO_FOLLOW_FLAG = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
const DIRECTORY_FLAG = 'O_DIRECTORY' in constants ? constants.O_DIRECTORY : 0;

interface FileSnapshot {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly sha256: string;
  readonly contents: Buffer;
}

export interface GitRemoteConfigurationFileEntry {
  readonly key: string;
  readonly value: string;
}

export type GitRemoteConfigurationFileMutation =
  | {
      readonly kind: 'add';
      readonly remoteName: string;
      readonly targetUrl: string;
      readonly expectedEntries: readonly GitRemoteConfigurationFileEntry[];
    }
  | {
      readonly kind: 'replace';
      readonly remoteName: string;
      readonly targetUrl: string;
      readonly expectedEntries: readonly GitRemoteConfigurationFileEntry[];
    }
  | {
      readonly kind: 'remove';
      readonly remoteName: string;
      readonly expectedEntries: readonly [];
    };

export interface PreparedRemoteConfigurationMutation {
  /** Revalidates the original config, its Git lock, and the prepared replacement by identity. */
  assertCurrent(signal?: AbortSignal): Promise<void>;
  /** Atomically replaces the configuration directly after the caller's final authority check. */
  commit(): Promise<void>;
  /** Restores the byte-exact original config after committed outcome verification fails. */
  rollback(): Promise<void>;
  /** Releases the Git-compatible lock after the committed state has been verified. */
  complete(): Promise<void>;
  /** Removes preparation artifacts before any repository mutation has happened. */
  abort(): Promise<void>;
}

/**
 * Acquires Git's conventional `<config>.lock`, snapshots the original config into that lock, and
 * prepares a same-directory replacement with only the approved remote change. Standard Git config
 * writers either finish before this lock is acquired or fail while it is held.
 */
export async function prepareRemoteConfigurationMutation(
  repositories: RepositoryService,
  identity: GitCommonDirectoryIdentity,
  mutation: GitRemoteConfigurationFileMutation,
  signal?: AbortSignal,
): Promise<PreparedRemoteConfigurationMutation> {
  throwIfAborted(signal);
  const configurationPath = identity.configurationPath;
  const lockPath = `${configurationPath}.lock`;
  const stagingPath = path.join(
    path.dirname(configurationPath),
    `.${path.basename(configurationPath)}.forgeboard-remote-${randomUUID()}.tmp`,
  );
  const stagingLockPath = `${stagingPath}.lock`;
  let lockHandle: FileHandle | undefined;
  let stagingHandle: FileHandle | undefined;
  let lockCreated = false;
  let stagingCreated = false;

  try {
    try {
      lockHandle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW_FLAG,
        0o600,
      );
      lockCreated = true;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw stale(
          'Another Git configuration update is already in progress. Refresh and try again.',
          error,
        );
      }
      throw commandFailure('Git could not acquire the repository configuration lock.', error);
    }

    const original = await readConfiguration(configurationPath, identity);
    await lockHandle.writeFile(original.contents);
    await lockHandle.chmod(original.mode);
    await lockHandle.sync();
    await lockHandle.close();
    lockHandle = undefined;
    const lockedOriginal = await readOrdinaryFile(lockPath);
    assertSameContents(original, lockedOriginal, 'The repository configuration lock changed.');

    stagingHandle = await open(
      stagingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW_FLAG,
      0o600,
    );
    stagingCreated = true;
    await stagingHandle.writeFile(original.contents);
    await stagingHandle.chmod(original.mode);
    await stagingHandle.sync();
    await stagingHandle.close();
    stagingHandle = undefined;

    await applyStagedMutation(repositories, stagingPath, mutation, signal);
    await assertStagedMutation(repositories, stagingPath, mutation, signal);
    const prepared = await chmodSyncAndReadOrdinaryFile(stagingPath, original.mode);
    if (prepared.sha256 === original.sha256) {
      throw new GitEngineError(
        'APPROVAL_MISMATCH',
        'Git did not change the prepared repository configuration.',
      );
    }
    throwIfAborted(signal);

    return new PreparedMutation(
      identity,
      original,
      lockedOriginal,
      prepared,
      lockPath,
      stagingPath,
      stagingLockPath,
    );
  } catch (error) {
    await closeQuietly(stagingHandle);
    await closeQuietly(lockHandle);
    const cleanupError = await cleanupPreparation(
      stagingCreated ? [stagingLockPath, stagingPath] : [stagingLockPath],
      lockCreated ? lockPath : undefined,
    );
    if (cleanupError !== undefined) {
      throw new GitEngineError(
        'COMMAND_FAILED',
        'Git remote configuration did not start, but its lock could not be cleaned up.',
        { mutationApplied: false, recoveryRequired: true },
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    throw error;
  }
}

class PreparedMutation implements PreparedRemoteConfigurationMutation {
  #state: 'prepared' | 'committed' | 'finished' = 'prepared';

  public constructor(
    private readonly identity: GitCommonDirectoryIdentity,
    private readonly original: FileSnapshot,
    private readonly lockedOriginal: FileSnapshot,
    private readonly prepared: FileSnapshot,
    private readonly lockPath: string,
    private readonly stagingPath: string,
    private readonly stagingLockPath: string,
  ) {}

  public async assertCurrent(signal?: AbortSignal): Promise<void> {
    this.#assertState('prepared');
    throwIfAborted(signal);
    const [configuration, lock, staging] = await Promise.all([
      readConfiguration(this.identity.configurationPath, this.identity),
      readOrdinaryFile(this.lockPath),
      readOrdinaryFile(this.stagingPath),
    ]);
    assertSameFile(this.original, configuration, 'The repository configuration changed.');
    assertSameFile(this.lockedOriginal, lock, 'The repository configuration lock changed.');
    assertSameFile(this.prepared, staging, 'The prepared repository configuration changed.');
    throwIfAborted(signal);
  }

  public async commit(): Promise<void> {
    this.#assertState('prepared');
    const configuration = readOrdinaryFileSync(this.identity.configurationPath);
    const lock = readOrdinaryFileSync(this.lockPath);
    const staging = readOrdinaryFileSync(this.stagingPath);
    assertSameFile(this.original, configuration, 'The repository configuration changed.');
    assertSameFile(this.lockedOriginal, lock, 'The repository configuration lock changed.');
    assertSameFile(this.prepared, staging, 'The prepared repository configuration changed.');
    try {
      await replaceFileAtomically(this.stagingPath, this.identity.configurationPath, () => {
        assertSameFile(
          this.original,
          readOrdinaryFileSync(this.identity.configurationPath),
          'The repository configuration changed during commit.',
        );
        assertSameFile(
          this.prepared,
          readOrdinaryFileSync(this.stagingPath),
          'The prepared repository configuration changed during commit.',
        );
      });
      this.#state = 'committed';
      syncDirectoryBestEffort(path.dirname(this.identity.configurationPath));
    } catch (error) {
      throw commandFailure('Git could not commit the prepared remote configuration.', error);
    }
  }

  public async rollback(): Promise<void> {
    this.#assertState('committed');
    try {
      const [configuration, lock] = await Promise.all([
        readOrdinaryFile(this.identity.configurationPath),
        readOrdinaryFile(this.lockPath),
      ]);
      assertSameFile(
        this.prepared,
        configuration,
        'The committed repository configuration changed before rollback.',
      );
      assertSameFile(
        this.lockedOriginal,
        lock,
        'The repository configuration recovery lock changed before rollback.',
      );
      await replaceFileAtomically(this.lockPath, this.identity.configurationPath, () => {
        assertSameFile(
          this.prepared,
          readOrdinaryFileSync(this.identity.configurationPath),
          'The committed repository configuration changed during rollback.',
        );
        assertSameFile(
          this.lockedOriginal,
          readOrdinaryFileSync(this.lockPath),
          'The repository configuration recovery lock changed during rollback.',
        );
      });
      this.#state = 'finished';
      removeBestEffort(this.stagingLockPath);
      syncDirectoryBestEffort(path.dirname(this.identity.configurationPath));
    } catch (error) {
      throw new GitEngineError(
        'COMMAND_FAILED',
        'Git remote configuration may have changed the repository and its rollback failed.',
        {
          outcomeUncertain: true,
          recoveryRequired: true,
          refreshRequired: true,
        },
        { cause: error },
      );
    }
  }

  public async complete(): Promise<void> {
    this.#assertState('committed');
    try {
      const [configuration, lock] = await Promise.all([
        readOrdinaryFile(this.identity.configurationPath),
        readOrdinaryFile(this.lockPath),
      ]);
      assertSameFile(
        this.prepared,
        configuration,
        'The committed repository configuration changed before completion.',
      );
      assertSameFile(
        this.lockedOriginal,
        lock,
        'The repository configuration recovery lock changed before completion.',
      );
      removeIfPresent(this.lockPath);
      removeBestEffort(this.stagingLockPath);
      this.#state = 'finished';
      syncDirectoryBestEffort(path.dirname(this.identity.configurationPath));
    } catch (error) {
      throw new GitEngineError(
        'COMMAND_FAILED',
        'The Git remote configuration changed, but its lock could not be released safely.',
        {
          mutationApplied: true,
          outcomeUncertain: true,
          recoveryRequired: true,
        },
        { cause: error },
      );
    }
  }

  public abort(): Promise<void> {
    this.#assertState('prepared');
    try {
      removeIfPresent(this.stagingLockPath);
      removeIfPresent(this.stagingPath);
      removeIfPresent(this.lockPath);
      this.#state = 'finished';
      syncDirectoryBestEffort(path.dirname(this.identity.configurationPath));
      return Promise.resolve();
    } catch (error) {
      throw new GitEngineError(
        'COMMAND_FAILED',
        'Git remote configuration did not start, but its lock could not be cleaned up.',
        { mutationApplied: false, recoveryRequired: true },
        { cause: error },
      );
    }
  }

  #assertState(expected: 'prepared' | 'committed'): void {
    if (this.#state !== expected) {
      throw new GitEngineError(
        'INVALID_ARGUMENT',
        'The prepared Git remote configuration transaction is no longer usable.',
      );
    }
  }
}

async function applyStagedMutation(
  repositories: RepositoryService,
  stagingPath: string,
  mutation: GitRemoteConfigurationFileMutation,
  signal: AbortSignal | undefined,
): Promise<void> {
  const command = ['config', '--file', stagingPath];
  const options = {
    ...(signal === undefined ? {} : { signal }),
    maxOutputBytes: MUTATION_OUTPUT_LIMIT,
  };
  if (mutation.kind === 'add') {
    await repositories.git.run(
      [...command, '--add', `remote.${mutation.remoteName}.url`, mutation.targetUrl],
      options,
    );
    await repositories.git.run(
      [
        ...command,
        '--add',
        `remote.${mutation.remoteName}.fetch`,
        `+refs/heads/*:refs/remotes/${mutation.remoteName}/*`,
      ],
      options,
    );
    return;
  }
  if (mutation.kind === 'replace') {
    await repositories.git.run(
      [...command, '--replace-all', `remote.${mutation.remoteName}.url`, mutation.targetUrl],
      options,
    );
    return;
  }
  await repositories.git.run(
    [...command, '--remove-section', `remote.${mutation.remoteName}`],
    options,
  );
}

async function assertStagedMutation(
  repositories: RepositoryService,
  stagingPath: string,
  mutation: GitRemoteConfigurationFileMutation,
  signal: AbortSignal | undefined,
): Promise<void> {
  const escapedName = escapeGitPattern(mutation.remoteName);
  const result = await repositories.git.run(
    ['config', '--file', stagingPath, '--null', '--get-regexp', `^remote\\.${escapedName}\\.`],
    {
      allowNonZeroExit: true,
      ...(signal === undefined ? {} : { signal }),
      maxOutputBytes: MUTATION_OUTPUT_LIMIT,
    },
  );
  const actual = parseRemoteEntries(result.exitCode, result.stdout);
  if (entryFingerprint(actual) !== entryFingerprint(mutation.expectedEntries)) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'Git did not prepare the exact approved remote configuration change.',
    );
  }
}

function parseRemoteEntries(
  exitCode: number,
  output: string,
): readonly GitRemoteConfigurationFileEntry[] {
  if (exitCode === 1 && output === '') return [];
  if (exitCode !== 0 || !output.endsWith('\0')) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'Git could not verify the prepared remote configuration change.',
    );
  }
  return output
    .slice(0, -1)
    .split('\0')
    .map((record) => {
      const separator = record.indexOf('\n');
      if (separator < 1) {
        throw new GitEngineError(
          'APPROVAL_MISMATCH',
          'Git returned an invalid prepared remote configuration entry.',
        );
      }
      return {
        key: record.slice(0, separator),
        value: record.slice(separator + 1),
      };
    });
}

function entryFingerprint(entries: readonly GitRemoteConfigurationFileEntry[]): string {
  return JSON.stringify(
    [...entries].sort((left, right) => {
      const leftValue = `${left.key}\0${left.value}`;
      const rightValue = `${right.key}\0${right.value}`;
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    }),
  );
}

async function readConfiguration(
  configurationPath: string,
  identity: GitCommonDirectoryIdentity,
): Promise<FileSnapshot> {
  const snapshot = await readOrdinaryFile(configurationPath);
  if (
    snapshot.device !== identity.configurationDevice ||
    snapshot.inode !== identity.configurationInode
  ) {
    throw stale('The repository configuration identity changed after review.');
  }
  return snapshot;
}

async function readOrdinaryFile(filePath: string): Promise<FileSnapshot> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW_FLAG);
  } catch (error) {
    throw stale('A repository configuration transaction file is unavailable.', error);
  }
  try {
    return await snapshotOpenFile(handle);
  } finally {
    await handle.close();
  }
}

async function snapshotOpenFile(handle: FileHandle): Promise<FileSnapshot> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size > BigInt(CONFIGURATION_FILE_LIMIT)) {
    throw new GitEngineError(
      'APPROVAL_MISMATCH',
      'The repository configuration file is not a bounded ordinary file.',
    );
  }
  const contents = await handle.readFile();
  const after = await handle.stat({ bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    BigInt(contents.byteLength) !== after.size
  ) {
    throw stale('The repository configuration changed while it was being read.');
  }
  return {
    device: after.dev.toString(),
    inode: after.ino.toString(),
    mode: Number(after.mode & 0o777n),
    sha256: createHash('sha256').update(contents).digest('hex'),
    contents,
  };
}

function readOrdinaryFileSync(filePath: string): FileSnapshot {
  let descriptor: number;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | NO_FOLLOW_FLAG);
  } catch (error) {
    throw stale('A repository configuration transaction file is unavailable.', error);
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(CONFIGURATION_FILE_LIMIT)) {
      throw new GitEngineError(
        'APPROVAL_MISMATCH',
        'The repository configuration file is not a bounded ordinary file.',
      );
    }
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(contents.byteLength) !== after.size
    ) {
      throw stale('The repository configuration changed while it was being read.');
    }
    return {
      device: after.dev.toString(),
      inode: after.ino.toString(),
      mode: Number(after.mode & 0o777n),
      sha256: createHash('sha256').update(contents).digest('hex'),
      contents,
    };
  } finally {
    closeSync(descriptor);
  }
}

async function chmodSyncAndReadOrdinaryFile(filePath: string, mode: number): Promise<FileSnapshot> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW_FLAG);
  } catch (error) {
    throw stale('The prepared repository configuration is unavailable.', error);
  }
  try {
    await handle.chmod(mode);
    await handle.sync();
    return await snapshotOpenFile(handle);
  } finally {
    await handle.close();
  }
}

function assertSameContents(expected: FileSnapshot, current: FileSnapshot, message: string): void {
  if (expected.sha256 !== current.sha256 || expected.mode !== current.mode) throw stale(message);
}

function assertSameFile(expected: FileSnapshot, current: FileSnapshot, message: string): void {
  if (
    expected.device !== current.device ||
    expected.inode !== current.inode ||
    expected.sha256 !== current.sha256 ||
    expected.mode !== current.mode
  ) {
    throw stale(message);
  }
}

function escapeGitPattern(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new GitEngineError('ABORTED', 'Git remote configuration was aborted before mutation.');
  }
}

async function cleanupPreparation(
  stagingPaths: readonly string[],
  lockPath: string | undefined,
): Promise<unknown> {
  let firstError: unknown;
  for (const filePath of [...stagingPaths, ...(lockPath === undefined ? [] : [lockPath])]) {
    try {
      await unlink(filePath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') firstError ??= error;
    }
  }
  return firstError;
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined);
}

function removeIfPresent(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function syncDirectoryBestEffort(directoryPath: string): void {
  if (process.platform === 'win32') return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directoryPath, constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG);
    fsyncSync(descriptor);
  } catch {
    // The rename/unlink already succeeded; unsupported directory fsync must not invert its result.
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Closing a durability-only directory descriptor must not invert a completed rename.
      }
    }
  }
}

function removeBestEffort(filePath: string): void {
  try {
    removeIfPresent(filePath);
  } catch {
    // A staging lock is not repository state and never justifies undoing a committed result.
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function stale(message: string, cause?: unknown): GitEngineError {
  return new GitEngineError(
    'STALE_APPROVAL',
    message,
    {},
    cause === undefined ? undefined : { cause },
  );
}

function commandFailure(message: string, cause: unknown): GitEngineError {
  return new GitEngineError('COMMAND_FAILED', message, {}, { cause });
}
