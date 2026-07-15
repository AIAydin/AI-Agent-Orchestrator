import { constants as fsConstants, createReadStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
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

export async function captureLaunchExecutableIdentity(
  executable: string,
): Promise<LaunchExecutableIdentity> {
  return await captureLaunchFileIdentity(executable, true);
}

export async function captureLaunchFileIdentity(
  filePath: string,
  executable = false,
): Promise<LaunchFileIdentity> {
  if (!path.isAbsolute(filePath)) {
    throw new Error('The reviewed launch file must be an absolute path.');
  }
  const canonical = await realpath(filePath);
  if (!pathsEqual(canonical, filePath)) {
    throw new Error('The reviewed launch file must use its canonical path.');
  }
  const before = await stat(canonical);
  if (!before.isFile()) throw new Error('The reviewed launch file is not an ordinary file.');
  await access(
    canonical,
    executable && process.platform !== 'win32' ? fsConstants.X_OK : fsConstants.F_OK,
  );
  const digest = await sha256File(canonical);
  const after = await stat(canonical);
  const identity = {
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
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.mode !== after.mode
  ) {
    throw new Error('The launch file changed while Forgeboard verified it.');
  }
  return identity;
}

export async function assertLaunchExecutableIdentity(
  expected: LaunchExecutableIdentity,
): Promise<void> {
  await assertLaunchFileIdentity(expected);
}

export async function assertLaunchFileIdentity(expected: LaunchFileIdentity): Promise<void> {
  const current = await captureLaunchFileIdentity(expected.path, expected.executable).catch(
    () => undefined,
  );
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

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}
