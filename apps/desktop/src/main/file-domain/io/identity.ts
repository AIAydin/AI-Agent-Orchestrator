import type { BigIntStats } from 'node:fs';

export interface FileSystemSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export function captureFileSystemSnapshot(stats: BigIntStats): FileSystemSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

export function isSameFileIdentity(
  expected: FileSystemSnapshot,
  actual: FileSystemSnapshot,
): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

export function isSameFileRevision(
  expected: FileSystemSnapshot,
  actual: FileSystemSnapshot,
): boolean {
  return (
    isSameFileIdentity(expected, actual) &&
    expected.mode === actual.mode &&
    expected.size === actual.size &&
    expected.mtimeNs === actual.mtimeNs &&
    expected.ctimeNs === actual.ctimeNs
  );
}

export function isStableBoundedRead(
  before: FileSystemSnapshot,
  after: FileSystemSnapshot,
  bytesRead: number,
): boolean {
  return isSameFileRevision(before, after) && after.size === BigInt(bytesRead);
}

export function serializableFileSize(size: bigint): number {
  return size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(size);
}
