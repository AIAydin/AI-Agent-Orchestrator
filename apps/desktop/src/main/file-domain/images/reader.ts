import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

import { resolveExactProjectPath } from '../authority.js';
import { FileDomainError } from '../errors.js';
import { NO_FOLLOW_FLAG } from '../io/flags.js';
import {
  captureFileSystemSnapshot,
  isSameFileIdentity,
  isSameFileRevision,
  isStableBoundedRead,
} from '../io/identity.js';

export interface StableProjectImage {
  readonly bytes: Buffer;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  readonly sha256: string;
}

export type ProjectImageReadResult =
  | { readonly status: 'available'; readonly image: StableProjectImage }
  | { readonly status: 'unavailable'; readonly message: string };

export interface ProjectImageReaderIo {
  readonly openFile?: (path: string, flags: number) => Promise<FileHandle>;
  readonly pathStat?: (path: string) => Promise<BigIntStats>;
}

export async function readStableProjectImage(
  root: string,
  relativePath: string,
  maximumBytes: number,
  io: ProjectImageReaderIo = {},
): Promise<ProjectImageReadResult> {
  const resolved = await resolveExactProjectPath(root, relativePath);
  const openFile = io.openFile ?? (async (path, flags) => await open(path, flags));
  const pathStat = io.pathStat ?? (async (path) => await lstat(path, { bigint: true }));
  const handle = await openFile(resolved.path, constants.O_RDONLY | NO_FOLLOW_FLAG);
  try {
    const [beforeHandleStats, beforePathStats] = await Promise.all([
      handle.stat({ bigint: true }),
      pathStat(resolved.path),
    ]);
    assertOrdinarySamePath(beforeHandleStats, beforePathStats);
    const before = captureFileSystemSnapshot(beforeHandleStats);
    const bounded = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(bounded, 0, bounded.byteLength, 0);
    const [afterHandleStats, afterPathStats, revalidated] = await Promise.all([
      handle.stat({ bigint: true }),
      pathStat(resolved.path),
      resolveExactProjectPath(root, relativePath),
    ]);
    assertOrdinarySamePath(afterHandleStats, afterPathStats);
    if (revalidated.path !== resolved.path) {
      throw changedDuringRead();
    }
    const after = captureFileSystemSnapshot(afterHandleStats);
    if (!isSameFileRevision(before, after)) throw changedDuringRead();
    if (
      bytesRead > maximumBytes ||
      before.size > BigInt(maximumBytes) ||
      after.size > BigInt(maximumBytes)
    ) {
      return {
        status: 'unavailable',
        message: `Image previews must be between 1 byte and ${String(maximumBytes / 1024 / 1024)} MB.`,
      };
    }
    if (!isStableBoundedRead(before, after, bytesRead)) throw changedDuringRead();
    if (bytesRead === 0) {
      return { status: 'unavailable', message: 'Empty image files cannot be previewed.' };
    }
    const bytes = bounded.subarray(0, bytesRead);
    const mimeType = detectImageMimeType(bytes);
    if (mimeType === null) {
      return {
        status: 'unavailable',
        message: 'Only signature-validated PNG, JPEG, GIF, and WebP images can be previewed.',
      };
    }
    return {
      status: 'available',
      image: {
        bytes,
        mimeType,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  } finally {
    await handle.close();
  }
}

function assertOrdinarySamePath(handleStats: BigIntStats, pathStats: BigIntStats): void {
  if (
    !handleStats.isFile() ||
    !pathStats.isFile() ||
    pathStats.isSymbolicLink() ||
    !isSameFileIdentity(
      captureFileSystemSnapshot(handleStats),
      captureFileSystemSnapshot(pathStats),
    )
  ) {
    throw new FileDomainError('SYMLINK_BLOCKED', 'Forgeboard refused an unsafe image reference.');
  }
}

function changedDuringRead(): FileDomainError {
  return new FileDomainError('IO_ERROR', 'The image changed while it was being read. Try again.');
}

function detectImageMimeType(
  bytes: Buffer,
): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const prefix = bytes.subarray(0, 6).toString('ascii');
  if (prefix === 'GIF87a' || prefix === 'GIF89a') return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
