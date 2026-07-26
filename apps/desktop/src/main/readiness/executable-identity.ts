import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

export interface ReadinessExecutableIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly sha256: string;
}

/** Hashes the same opened regular file whose metadata is returned. */
export async function readinessExecutableIdentity(
  path: string,
): Promise<ReadinessExecutableIdentity> {
  const handle = await open(path, 'r');
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error('The selected agent executable is not a regular file.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      details.dev !== after.dev ||
      details.ino !== after.ino ||
      details.size !== after.size ||
      details.mtimeMs !== after.mtimeMs ||
      details.ctimeMs !== after.ctimeMs ||
      details.mode !== after.mode
    ) {
      throw new Error('The selected agent executable changed while Artemis verified it.');
    }
    return {
      device: after.dev,
      inode: after.ino,
      size: after.size,
      modifiedAtMs: after.mtimeMs,
      sha256: hash.digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

export function sameReadinessExecutable(
  left: ReadinessExecutableIdentity,
  right: ReadinessExecutableIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.sha256 === right.sha256
  );
}
