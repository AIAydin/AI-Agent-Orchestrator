import { constants as fsConstants } from 'node:fs';
import { access, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface LaunchFileIdentity {
  readonly path: string;
  readonly executable: boolean;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
  readonly mode: number;
  readonly digest: string;
}

export type LaunchExecutableIdentity = LaunchFileIdentity;

export interface LaunchFileIdentityCaptureOptions {
  /** Optional logical-size ceiling enforced before and throughout hashing. */
  readonly maximumBytes?: number;
}

export async function captureLaunchExecutableIdentity(
  executable: string,
  options: LaunchFileIdentityCaptureOptions = {},
): Promise<LaunchExecutableIdentity> {
  return await captureLaunchFileIdentity(executable, true, options);
}

export async function captureLaunchFileIdentity(
  filePath: string,
  executable = false,
  options: LaunchFileIdentityCaptureOptions = {},
): Promise<LaunchFileIdentity> {
  if (!path.isAbsolute(filePath)) {
    throw new Error('The reviewed launch file must be an absolute path.');
  }
  const canonical = await realpath(filePath);
  if (!pathsEqual(canonical, filePath)) {
    throw new Error('The reviewed launch file must use its canonical path.');
  }
  const flags =
    process.platform === 'win32'
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await open(canonical, flags);
  try {
    const maximumBytes = validMaximumBytes(options.maximumBytes);
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('The reviewed launch file is not an ordinary file.');
    assertWithinSizeLimit(before.size, maximumBytes);
    await access(
      canonical,
      executable && process.platform !== 'win32' ? fsConstants.X_OK : fsConstants.F_OK,
    );
    const digest = await sha256FileHandle(handle, before.size, maximumBytes);
    const [after, pathAfter] = await Promise.all([handle.stat(), stat(canonical)]);
    assertWithinSizeLimit(after.size, maximumBytes);
    assertWithinSizeLimit(pathAfter.size, maximumBytes);
    if (!sameFileIdentity(before, after) || !sameFileIdentity(after, pathAfter)) {
      throw new Error('The launch file changed while Forgeboard verified it.');
    }
    return {
      path: canonical,
      executable,
      device: after.dev,
      inode: after.ino,
      size: after.size,
      modifiedAtMs: after.mtimeMs,
      changedAtMs: after.ctimeMs,
      mode: after.mode,
      digest,
    };
  } finally {
    await handle.close();
  }
}

export async function assertLaunchExecutableIdentity(
  expected: LaunchExecutableIdentity,
  options: LaunchFileIdentityCaptureOptions = {},
): Promise<void> {
  await assertLaunchFileIdentity(expected, options);
}

export async function assertLaunchFileIdentity(
  expected: LaunchFileIdentity,
  options: LaunchFileIdentityCaptureOptions = {},
): Promise<void> {
  const current = await captureLaunchFileIdentity(
    expected.path,
    expected.executable,
    options,
  ).catch(() => undefined);
  if (
    current === undefined ||
    current.executable !== expected.executable ||
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.size !== expected.size ||
    current.modifiedAtMs !== expected.modifiedAtMs ||
    current.changedAtMs !== expected.changedAtMs ||
    current.mode !== expected.mode ||
    current.digest !== expected.digest
  ) {
    throw new Error('The reviewed launch file changed. Review a fresh launch.');
  }
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function sameFileIdentity(
  left: Awaited<ReturnType<FileHandle['stat']>>,
  right: Awaited<ReturnType<FileHandle['stat']>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  );
}

async function sha256FileHandle(
  handle: FileHandle,
  expectedBytes: number,
  maximumBytes: number,
): Promise<string> {
  assertWithinSizeLimit(expectedBytes, maximumBytes);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < expectedBytes) {
    const bytesRemaining = expectedBytes - position;
    const length = Math.min(buffer.length, bytesRemaining, maximumBytes - position);
    if (length <= 0) throw sizeLimitError();
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) throw changedDuringVerificationError();
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
    assertWithinSizeLimit(position, maximumBytes);
  }

  // Do not chase a growing file to EOF. One bounded probe detects content appended after fstat;
  // the post-hash identity checks catch growth that races with this probe.
  const { bytesRead: appendedBytes } = await handle.read(buffer, 0, 1, position);
  if (appendedBytes !== 0) throw changedDuringVerificationError();
  return hash.digest('hex');
}

function validMaximumBytes(value: number | undefined): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Launch file size limits must be non-negative safe integers.');
  }
  return value;
}

function assertWithinSizeLimit(size: number, maximumBytes: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) throw sizeLimitError();
}

function sizeLimitError(): Error {
  return new Error('The reviewed launch file exceeds its configured size limit.');
}

function changedDuringVerificationError(): Error {
  return new Error('The launch file changed while Forgeboard verified it.');
}
