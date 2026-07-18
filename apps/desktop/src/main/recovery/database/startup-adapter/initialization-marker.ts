import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const MARKER_NAME = '.forgeboard-initialized-v1';
const MARKER_CONTENT = 'forgeboard-initialized-v1\n';

export interface InitializationMarkerPrivacy {
  readonly assertPrivateFile: (path: string) => Promise<void>;
  readonly protectPrivateFile: (path: string) => Promise<void>;
}

export interface InitializationMarkerWindowsDurability {
  readonly moveFileWriteThrough: (sourcePath: string, destinationPath: string) => Promise<void>;
}

export interface InitializationMarkerOptions {
  readonly getUserId?: () => number | undefined;
  readonly platform?: NodeJS.Platform;
  readonly windowsDurability?: InitializationMarkerWindowsDurability;
  readonly windowsPrivacy?: InitializationMarkerPrivacy;
}

export type InitializationMarkerState = 'absent' | 'initialized';

/** Reads the durable initialization sentinel without following a final-component link. */
export async function readInitializationMarker(
  canonicalUserData: string,
  options: InitializationMarkerOptions = {},
): Promise<InitializationMarkerState> {
  const markerPath = join(canonicalUserData, MARKER_NAME);
  let stats: Stats;
  try {
    stats = await lstat(markerPath);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return 'absent';
    throw error;
  }
  await assertPrivateStableMarker(markerPath, stats, options);
  const handle = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if ((await handle.readFile('utf8')) !== MARKER_CONTENT) {
      throw new Error('The Forgeboard initialization marker is invalid.');
    }
    const after = await handle.stat();
    if (!sameIdentity(stats, after)) {
      throw new Error('The Forgeboard initialization marker changed while being read.');
    }
  } finally {
    await handle.close();
  }
  return 'initialized';
}

/** Creates and fsyncs the sentinel exactly once after a verified LocalStore opens. */
export async function writeInitializationMarker(
  canonicalUserData: string,
  options: InitializationMarkerOptions = {},
): Promise<void> {
  const markerPath = join(canonicalUserData, MARKER_NAME);
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    await writeWindowsMarker(canonicalUserData, markerPath, options);
    await readInitializationMarker(canonicalUserData, options);
    return;
  }
  await writePosixMarker(canonicalUserData, markerPath);
  await readInitializationMarker(canonicalUserData, options);
}

async function writePosixMarker(canonicalUserData: string, markerPath: string): Promise<void> {
  try {
    await lstat(markerPath);
    return;
  } catch (error) {
    if (!(isRecord(error) && error.code === 'ENOENT')) throw error;
  }
  const temporaryPath = join(canonicalUserData, `.forgeboard-marker-${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(MARKER_CONTENT, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, 0o600);
    const temporaryStats = await lstat(temporaryPath);
    if (
      !temporaryStats.isFile() ||
      temporaryStats.isSymbolicLink() ||
      (temporaryStats.mode & 0o077) !== 0
    ) {
      throw new Error('Forgeboard could not create a private initialization marker.');
    }
    try {
      await link(temporaryPath, markerPath);
    } catch (error) {
      if (!(isRecord(error) && error.code === 'EEXIST')) throw error;
    }
    const directory = await open(canonicalUserData, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function writeWindowsMarker(
  canonicalUserData: string,
  markerPath: string,
  options: InitializationMarkerOptions,
): Promise<void> {
  if (options.windowsPrivacy === undefined || options.windowsDurability === undefined) {
    throw new Error('Windows initialization-marker durability is unavailable.');
  }
  try {
    await lstat(markerPath);
    return;
  } catch (error) {
    if (!(isRecord(error) && error.code === 'ENOENT')) throw error;
  }
  const temporaryPath = join(canonicalUserData, `.forgeboard-marker-${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(MARKER_CONTENT, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.windowsPrivacy.protectPrivateFile(temporaryPath);
    await options.windowsPrivacy.assertPrivateFile(temporaryPath);
    await options.windowsDurability.moveFileWriteThrough(temporaryPath, markerPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function assertPrivateStableMarker(
  markerPath: string,
  before: Stats,
  options: InitializationMarkerOptions,
): Promise<void> {
  if (!before.isFile() || before.isSymbolicLink() || (await realpath(markerPath)) !== markerPath) {
    throw new Error('The Forgeboard initialization marker is not an ordinary private file.');
  }
  if ((options.platform ?? process.platform) === 'win32') {
    if (options.windowsPrivacy === undefined) {
      throw new Error('Windows initialization-marker privacy is unavailable.');
    }
    await options.windowsPrivacy.assertPrivateFile(markerPath);
  } else {
    const userId = (options.getUserId ?? (() => process.getuid?.()))();
    if (userId !== undefined && before.uid !== userId) {
      throw new Error('The Forgeboard initialization marker has an unexpected owner.');
    }
    if ((before.mode & 0o077) !== 0) {
      throw new Error('The Forgeboard initialization marker is not private.');
    }
  }
  const after = await lstat(markerPath);
  if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(before, after)) {
    throw new Error('The Forgeboard initialization marker changed during validation.');
  }
}

function sameIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
