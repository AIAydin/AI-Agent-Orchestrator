import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STAGING_NAME = /^\.forgeboard-database-recovery-[A-Za-z0-9]{6}$/u;
const MAXIMUM_STAGING_DIRECTORIES = 32;
const MAXIMUM_FILES_PER_DIRECTORY = 16;

export interface DeferredStagingCleanupPrivacy {
  readonly assertPrivateDirectory: (path: string) => Promise<void>;
  readonly assertPrivateFile: (path: string) => Promise<void>;
}

export interface DeferredStagingCleanupOptions {
  readonly getUserId?: () => number | undefined;
  readonly platform?: NodeJS.Platform;
  readonly privacy?: DeferredStagingCleanupPrivacy;
  readonly removeDirectory?: (path: string) => Promise<void>;
}

export interface DeferredStagingCleanupReport {
  readonly failedCount: number;
  readonly removedCount: number;
}

/** Removes only bounded, exact-name, private direct-child recovery staging directories. */
export async function cleanupDeferredRecoveryStaging(
  canonicalUserData: string,
  options: DeferredStagingCleanupOptions = {},
): Promise<DeferredStagingCleanupReport> {
  const platform = options.platform ?? process.platform;
  const entries = (await readdir(canonicalUserData, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith('.forgeboard-database-recovery-'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const boundedEntries = entries.slice(0, MAXIMUM_STAGING_DIRECTORIES);
  let failedCount = entries.length - boundedEntries.length;
  let removedCount = 0;
  for (const entry of boundedEntries) {
    const path = join(canonicalUserData, entry.name);
    try {
      if (!STAGING_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('Unrecognized recovery staging entry.');
      }
      await assertPrivateDirectory(path, canonicalUserData, platform, options);
      const children = await readdir(path, { withFileTypes: true });
      if (children.length > MAXIMUM_FILES_PER_DIRECTORY) {
        throw new Error('Recovery staging contains too many files.');
      }
      for (const child of children) {
        if (!child.isFile() || child.isSymbolicLink()) {
          throw new Error('Recovery staging contains an unsupported entry.');
        }
        await assertPrivateFile(join(path, child.name), path, platform, options);
      }
      await (options.removeDirectory ?? removeDirectory)(path);
      removedCount += 1;
    } catch {
      failedCount += 1;
    }
  }
  if (removedCount > 0 && platform !== 'win32') await syncDirectory(canonicalUserData);
  return { failedCount, removedCount };
}

async function assertPrivateDirectory(
  path: string,
  parent: string,
  platform: NodeJS.Platform,
  options: DeferredStagingCleanupOptions,
): Promise<void> {
  const stats = await lstat(path);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    dirname(path) !== parent ||
    (await realpath(path)) !== path
  ) {
    throw new Error('Recovery staging is not a stable direct child.');
  }
  await assertPrivate(path, stats, platform, options, true);
}

async function assertPrivateFile(
  path: string,
  parent: string,
  platform: NodeJS.Platform,
  options: DeferredStagingCleanupOptions,
): Promise<void> {
  const stats = await lstat(path);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    dirname(path) !== parent ||
    (await realpath(path)) !== path
  ) {
    throw new Error('Recovery staging file is not a stable direct child.');
  }
  await assertPrivate(path, stats, platform, options, false);
}

async function assertPrivate(
  path: string,
  stats: Stats,
  platform: NodeJS.Platform,
  options: DeferredStagingCleanupOptions,
  directory: boolean,
): Promise<void> {
  if (platform === 'win32') {
    const privacy = options.privacy;
    if (privacy === undefined) throw new Error('Windows staging privacy is unavailable.');
    if (directory) await privacy.assertPrivateDirectory(path);
    else await privacy.assertPrivateFile(path);
    return;
  }
  const userId = (options.getUserId ?? (() => process.getuid?.()))();
  if (userId !== undefined && stats.uid !== userId) {
    throw new Error('Recovery staging has an unexpected owner.');
  }
  if ((stats.mode & 0o077) !== 0) throw new Error('Recovery staging is not private.');
}

async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: false });
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
