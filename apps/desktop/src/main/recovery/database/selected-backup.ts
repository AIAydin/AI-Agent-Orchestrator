import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import {
  windowsFilesystemSecurity,
  type WindowsFilesystemSecurity,
} from '../../security/windows/filesystem-acl.js';
import { assertBackupIntegrity } from '../../storage/integrity.js';

export const MAX_SELECTED_BACKUP_BYTES = 1024 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;

export interface StagedSelectedBackup {
  /** Private, validated copy. The caller owns this file and must remove its staging tree. */
  readonly stagedPath: string;
  /** Digest of the exact selected bytes before private-copy validation or migration. */
  readonly sourceSha256?: string;
  /** Digest of the validated private copy, which can differ after an injected migration. */
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface SelectedBackupValidationOptions {
  readonly maxBytes?: number;
  readonly platform?: NodeJS.Platform;
  readonly windowsSecurity?: WindowsFilesystemSecurity;
  /**
   * Defaults to the current-schema full Artemis integrity check. Atomic recovery may inject a
   * validator that migrates this private copy before performing the same full check.
   */
  readonly validateStaged?: (stagedPath: string) => void | Promise<void>;
}

/**
 * Copies a user-selected database through a no-follow descriptor into an already-created private
 * staging directory, proves both directory entries stayed stable, and validates only the copy.
 * The selected source is never opened writable. Errors intentionally omit filesystem paths.
 */
export async function stageValidatedSelectedBackup(
  selectedPath: string,
  privateStagingDirectory: string,
  options: SelectedBackupValidationOptions = {},
): Promise<StagedSelectedBackup> {
  assertAbsolutePath(selectedPath, 'selected backup');
  assertAbsolutePath(privateStagingDirectory, 'recovery staging directory');
  const maxBytes = options.maxBytes ?? MAX_SELECTED_BACKUP_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Artemis rejected the selected backup safety limit.');
  }

  const platform = options.platform ?? process.platform;
  const validateStaged = options.validateStaged ?? assertBackupIntegrity;
  let stagedPath: string | undefined;
  try {
    const windows =
      platform === 'win32'
        ? await resolveWindowsBoundary(options.windowsSecurity ?? windowsFilesystemSecurity)
        : undefined;
    const stagingIdentity = await assertPrivateStagingDirectory(privateStagingDirectory, windows);
    const sourcePathStats = await lstat(selectedPath);
    assertOrdinarySource(sourcePathStats);
    assertBoundedSize(sourcePathStats.size, maxBytes);

    const noFollow = platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    const source = await open(selectedPath, constants.O_RDONLY | noFollow);
    try {
      const sourceBefore = await source.stat();
      if (!sourceBefore.isFile() || !sameFile(sourcePathStats, sourceBefore)) {
        throw new SafeSelectedBackupError(
          'The selected backup changed before Artemis could copy it.',
        );
      }
      assertBoundedSize(sourceBefore.size, maxBytes);

      stagedPath = join(privateStagingDirectory, `selected-${randomUUID()}.sqlite3`);
      const destination = await open(
        stagedPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      let digest: string;
      let copiedBytes: number;
      try {
        if (windows !== undefined) {
          await windows.security.protectPrivateFile(stagedPath, windows.sid);
        }
        ({ digest, copiedBytes } = await copyAndHash(source, destination, maxBytes));
        await destination.sync();
        const destinationStats = await destination.stat();
        if (!destinationStats.isFile() || destinationStats.size !== copiedBytes) {
          throw new SafeSelectedBackupError(
            'Artemis could not create a stable private backup copy.',
          );
        }
      } finally {
        await destination.close();
      }

      const sourceAfter = await source.stat();
      const finalSourcePathStats = await lstat(selectedPath);
      if (
        !sameStableFile(sourceBefore, sourceAfter) ||
        !sameStableFile(sourceAfter, finalSourcePathStats) ||
        finalSourcePathStats.isSymbolicLink()
      ) {
        throw new SafeSelectedBackupError(
          'The selected backup changed while Artemis was copying it.',
        );
      }
      if (copiedBytes !== sourceAfter.size) {
        throw new SafeSelectedBackupError(
          'The selected backup changed while Artemis was copying it.',
        );
      }

      await assertStableStagedFile(stagedPath, privateStagingDirectory, stagingIdentity, windows);
      await validateStaged(stagedPath);
      const finalDigest = await hashStableStagedFile(
        stagedPath,
        privateStagingDirectory,
        stagingIdentity,
        platform,
        windows,
        maxBytes,
      );
      return {
        stagedPath,
        sourceSha256: digest,
        sha256: finalDigest.sha256,
        sizeBytes: finalDigest.sizeBytes,
      };
    } finally {
      await source.close();
    }
  } catch (error) {
    if (stagedPath !== undefined) await cleanupStagedArtifacts(stagedPath);
    if (error instanceof SafeSelectedBackupError) throw error;
    throw new SafeSelectedBackupError('Artemis could not validate the selected backup safely.');
  }
}

class SafeSelectedBackupError extends Error {}

function assertAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || value.includes('\0')) {
    throw new SafeSelectedBackupError(`Artemis rejected the ${label} path.`);
  }
}

function assertOrdinarySource(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new SafeSelectedBackupError('The selected backup must be an ordinary file, not a link.');
  }
}

function assertBoundedSize(sizeBytes: number, maxBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new SafeSelectedBackupError('The selected backup is empty or has an invalid size.');
  }
  if (sizeBytes > maxBytes) {
    throw new SafeSelectedBackupError('The selected backup exceeds the recovery safety limit.');
  }
}

async function assertPrivateStagingDirectory(
  stagingDirectory: string,
  windows: WindowsBoundary | undefined,
): Promise<Stats> {
  const stats = await lstat(stagingDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SafeSelectedBackupError(
      'The recovery staging location is not an ordinary private directory.',
    );
  }
  if ((await realpath(stagingDirectory)) !== stagingDirectory) {
    throw new SafeSelectedBackupError('The recovery staging location is not canonical.');
  }
  if (windows === undefined && (stats.mode & 0o077) !== 0) {
    throw new SafeSelectedBackupError('The recovery staging location is not private.');
  }
  if (windows !== undefined) {
    await windows.security.assertPrivateDirectory(stagingDirectory, windows.sid);
  }
  return stats;
}

async function copyAndHash(
  source: Awaited<ReturnType<typeof open>>,
  destination: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<{ digest: string; copiedBytes: number }> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, maxBytes));
  let copiedBytes = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    copiedBytes += bytesRead;
    if (copiedBytes > maxBytes) {
      throw new SafeSelectedBackupError('The selected backup exceeds the recovery safety limit.');
    }
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, null);
      if (result.bytesWritten < 1) {
        throw new SafeSelectedBackupError('Artemis could not create the private backup copy.');
      }
      written += result.bytesWritten;
    }
  }
  assertBoundedSize(copiedBytes, maxBytes);
  return { digest: hash.digest('hex'), copiedBytes };
}

async function assertStableStagedFile(
  stagedPath: string,
  stagingDirectory: string,
  stagingIdentity: Stats,
  windows: WindowsBoundary | undefined,
): Promise<void> {
  const currentDirectory = await assertPrivateStagingDirectory(stagingDirectory, windows);
  if (
    !sameDirectory(stagingIdentity, currentDirectory) ||
    dirname(stagedPath) !== stagingDirectory
  ) {
    throw new SafeSelectedBackupError('The recovery staging location changed during validation.');
  }
  const stats = await lstat(stagedPath);
  if (!stats.isFile() || stats.isSymbolicLink() || (await realpath(stagedPath)) !== stagedPath) {
    throw new SafeSelectedBackupError('The private backup copy is not a stable ordinary file.');
  }
  if (windows === undefined && (stats.mode & 0o077) !== 0) {
    throw new SafeSelectedBackupError('The private backup copy is not private.');
  }
  if (windows !== undefined) {
    await windows.security.assertPrivateFile(stagedPath, windows.sid);
  }
}

async function hashStableStagedFile(
  stagedPath: string,
  stagingDirectory: string,
  stagingIdentity: Stats,
  platform: NodeJS.Platform,
  windows: WindowsBoundary | undefined,
  maxBytes: number,
): Promise<{ sha256: string; sizeBytes: number }> {
  await assertStableStagedFile(stagedPath, stagingDirectory, stagingIdentity, windows);
  const noFollow = platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(stagedPath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    assertBoundedSize(before.size, maxBytes);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, maxBytes));
    let sizeBytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      sizeBytes += bytesRead;
      if (sizeBytes > maxBytes) {
        throw new SafeSelectedBackupError(
          'The private backup copy exceeds the recovery safety limit.',
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const pathStats = await lstat(stagedPath);
    if (
      sizeBytes !== after.size ||
      !sameStableFile(before, after) ||
      !sameStableFile(after, pathStats) ||
      pathStats.isSymbolicLink()
    ) {
      throw new SafeSelectedBackupError(
        'The private backup copy changed while Artemis was validating it.',
      );
    }
    await assertStableStagedFile(stagedPath, stagingDirectory, stagingIdentity, windows);
    return { sha256: hash.digest('hex'), sizeBytes };
  } finally {
    await handle.close();
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface WindowsBoundary {
  readonly security: WindowsFilesystemSecurity;
  readonly sid: string;
}

async function resolveWindowsBoundary(
  security: WindowsFilesystemSecurity,
): Promise<WindowsBoundary> {
  return { security, sid: await security.currentUserSid() };
}

async function cleanupStagedArtifacts(stagedPath: string): Promise<void> {
  await Promise.all(
    ['', '-wal', '-shm', '-journal'].map(
      async (suffix) => await unlink(`${stagedPath}${suffix}`).catch(() => undefined),
    ),
  );
}
