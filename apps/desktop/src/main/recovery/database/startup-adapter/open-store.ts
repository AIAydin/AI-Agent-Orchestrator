import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { Dialog } from 'electron';
import {
  createWindowsDurableFilesystemAuthority,
  type WindowsDurableFilesystemAuthority,
} from '@forgeboard/windows-durable-fs';

import type { AppSettings } from '../../../../shared/application/contracts.js';
import { createDefaultSettings } from '../../../ipc.js';
import {
  windowsFilesystemSecurity,
  type WindowsFilesystemSecurity,
} from '../../../security/windows/filesystem-acl.js';
import { LocalStore } from '../../../storage.js';
import type { ExpectedDatabaseIdentity } from '../../../storage/database.js';
import { restoreDatabaseAtomically } from '../atomic-restore.js';
import { reconcileInterruptedDatabaseRestores } from '../interrupted-restore.js';
import {
  inspectForgeboardDatabaseProvenance,
  type ForgeboardDatabaseProvenanceFailureReason,
} from '../provenance/inspect.js';
import { stageValidatedSelectedBackup, type StagedSelectedBackup } from '../selected-backup.js';
import { openStoreWithStartupRecovery, type StartupOpenFailure } from '../startup-recovery.js';
import {
  cleanupDeferredRecoveryStaging,
  type DeferredStagingCleanupReport,
} from './deferred-staging-cleanup.js';
import {
  readInitializationMarker,
  writeInitializationMarker,
  type InitializationMarkerOptions,
  type InitializationMarkerWindowsDurability,
} from './initialization-marker.js';

const STAGING_PREFIX = '.forgeboard-database-recovery-';

interface RecoverySelection {
  readonly stagedBackup: StagedSelectedBackup;
  readonly stagingDirectory: string;
}

type RecoveryDialog = Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>;

export interface StartupDatabaseRecoveryDependencies {
  readonly cleanupAttemptDirectory?: (stagingDirectory: string) => Promise<void>;
  readonly cleanupDeferredStaging?: typeof cleanupDeferredRecoveryStaging;
  readonly createStore?: (
    databasePath: string,
    defaults: AppSettings,
    expectedIdentity?: ExpectedDatabaseIdentity,
    requiresAuditDeleteTriggerUpgrade?: boolean,
  ) => LocalStore;
  readonly createDefaultSettings?: () => AppSettings;
  readonly getUserId?: () => number | undefined;
  readonly inspectProvenance?: typeof inspectForgeboardDatabaseProvenance;
  readonly platform?: NodeJS.Platform;
  /**
   * Seam for the durable restore-journal reconciler. It must finish before the first LocalStore
   * open; the composition remains ready for the recovery core's forthcoming implementation.
   */
  readonly reconcileInterruptedRestores?: (databasePath: string) => Promise<void>;
  readonly restoreDatabase?: typeof restoreDatabaseAtomically;
  readonly stageBackup?: typeof stageValidatedSelectedBackup;
  readonly windowsSecurity?: WindowsFilesystemSecurity;
  readonly windowsDurability?: WindowsDurableFilesystemAuthority;
  readonly windowsMarkerDurability?: InitializationMarkerWindowsDurability;
}

export interface StartupDatabaseRecoveryOptions {
  readonly databasePath: string;
  readonly dialog: RecoveryDialog;
  readonly userDataPath: string;
  readonly dependencies?: StartupDatabaseRecoveryDependencies;
}

/**
 * Opens the production LocalStore and composes the native, pre-window recovery flow on failure.
 * Every selected source is copied into a new private userData staging directory before migration
 * or validation, and `null` means startup must quit before registering IPC or creating a window.
 */
export async function openLocalStoreWithStartupDatabaseRecovery(
  options: StartupDatabaseRecoveryOptions,
): Promise<LocalStore | null> {
  const dependencies = options.dependencies ?? {};
  const cleanup = dependencies.cleanupAttemptDirectory ?? cleanupAttemptDirectory;
  const cleanupDeferred = dependencies.cleanupDeferredStaging ?? cleanupDeferredRecoveryStaging;
  const getUserId = dependencies.getUserId ?? (() => process.getuid?.());
  const platform = dependencies.platform ?? process.platform;
  const defaults = (dependencies.createDefaultSettings ?? createDefaultSettings)();
  const createStore =
    dependencies.createStore ??
    ((
      databasePath: string,
      legacySettingsDefaults: AppSettings,
      expectedDatabaseIdentity?: ExpectedDatabaseIdentity,
      requiresAuditDeleteTriggerUpgrade?: boolean,
    ) =>
      new LocalStore(databasePath, {
        legacySettingsDefaults,
        ...(expectedDatabaseIdentity === undefined ? {} : { expectedDatabaseIdentity }),
        ...(requiresAuditDeleteTriggerUpgrade === true
          ? { requiresAuditDeleteTriggerUpgrade: true }
          : {}),
      }));
  const stageBackup = dependencies.stageBackup ?? stageValidatedSelectedBackup;
  const restoreDatabase = dependencies.restoreDatabase ?? restoreDatabaseAtomically;
  const inspectProvenance = dependencies.inspectProvenance ?? inspectForgeboardDatabaseProvenance;
  const windowsSecurity = dependencies.windowsSecurity ?? windowsFilesystemSecurity;
  const windowsDurability =
    platform === 'win32'
      ? (dependencies.windowsDurability ?? createWindowsDurableFilesystemAuthority())
      : undefined;
  const windowsMarkerDurability =
    dependencies.windowsMarkerDurability ??
    (windowsDurability === undefined
      ? undefined
      : ({
          moveFileWriteThrough: (sourcePath: string, destinationPath: string) =>
            windowsDurability.moveFileWriteThrough(sourcePath, destinationPath),
        } satisfies InitializationMarkerWindowsDurability));
  let canonicalUserData: string | undefined;
  let databasePath: string | undefined;
  let reconciliationCompleted = false;
  let cleanupReport: DeferredStagingCleanupReport = { failedCount: 0, removedCount: 0 };
  let cleanupWarningRecorded = false;
  let windowsSid: string | undefined;

  const prepareBoundary = async (): Promise<string> => {
    if (platform === 'win32' && windowsSid === undefined) {
      windowsSid = await windowsSecurity.currentUserSid();
    }
    if (canonicalUserData === undefined) {
      canonicalUserData = await prepareUserDataBoundary(
        options.userDataPath,
        platform,
        windowsSecurity,
        windowsSid,
        getUserId,
      );
      const cleanupWindowsSid = windowsSid;
      cleanupReport = await cleanupDeferred(canonicalUserData, {
        platform,
        getUserId,
        ...(platform === 'win32' && cleanupWindowsSid !== undefined
          ? {
              privacy: {
                assertPrivateDirectory: (path: string) =>
                  windowsSecurity.assertPrivateDirectory(path, cleanupWindowsSid),
                assertPrivateFile: (path: string) =>
                  windowsSecurity.assertPrivateFile(path, cleanupWindowsSid),
              },
            }
          : {}),
      });
    }
    databasePath ??= assertDirectDatabasePath(options.databasePath, canonicalUserData);
    await protectDatabaseBoundary(databasePath, platform, windowsSecurity, windowsSid, getUserId);
    return databasePath;
  };

  const openStore = async (): Promise<LocalStore> => {
    const preparedDatabasePath = await prepareBoundary();
    if (!reconciliationCompleted) {
      await reconcileBeforeOpen(
        preparedDatabasePath,
        platform,
        windowsSecurity,
        windowsSid,
        windowsDurability,
        dependencies.reconcileInterruptedRestores,
      );
      reconciliationCompleted = true;
      await protectDatabaseBoundary(
        preparedDatabasePath,
        platform,
        windowsSecurity,
        windowsSid,
        getUserId,
      );
    }
    const preparedUserData = canonicalUserData;
    if (preparedUserData === undefined) {
      throw new Error('The startup user-data boundary is unavailable.');
    }
    const markerOptions = initializationMarkerOptions(
      platform,
      windowsSecurity,
      windowsSid,
      getUserId,
      windowsMarkerDurability,
    );
    const marker = await readInitializationMarker(preparedUserData, markerOptions);
    const exists = await databaseFileExists(preparedDatabasePath);
    if (!exists && marker === 'initialized') throw new StartupDatabaseMissingError();
    let expectedIdentity: ExpectedDatabaseIdentity | undefined;
    let requiresAuditDeleteTriggerUpgrade = false;
    if (exists) {
      const beforeProvenance = stableDatabaseIdentity(preparedDatabasePath);
      const provenance = inspectProvenance(preparedDatabasePath);
      if (!provenance.ok) throw new StartupDatabaseOpenError(provenance.reason);
      requiresAuditDeleteTriggerUpgrade = provenance.requiresAuditDeleteTriggerUpgrade === true;
      expectedIdentity = stableDatabaseIdentity(preparedDatabasePath);
      if (!sameFilesystemIdentity(beforeProvenance, expectedIdentity)) {
        throw new Error('The local database changed during provenance inspection.');
      }
    }
    const opened = createStore(
      preparedDatabasePath,
      defaults,
      expectedIdentity,
      requiresAuditDeleteTriggerUpgrade,
    );
    try {
      if (cleanupReport.failedCount > 0 && !cleanupWarningRecorded) {
        opened.appendAudit('recovery', 'staging-cleanup', 'failed', {
          failedCount: cleanupReport.failedCount,
        });
        cleanupWarningRecorded = true;
      }
      if (marker === 'absent') {
        await writeInitializationMarker(preparedUserData, markerOptions);
      }
      return opened;
    } catch (error) {
      opened.close();
      throw error;
    }
  };

  const validatePrivateDatabase = (
    databasePath: string,
    appendRecoveryAudit?: (candidate: LocalStore) => void,
  ): void => {
    const beforeProvenance = stableDatabaseIdentity(databasePath);
    const provenance = inspectProvenance(databasePath);
    if (!provenance.ok) throw new StartupDatabaseOpenError(provenance.reason);
    const expectedIdentity = stableDatabaseIdentity(databasePath);
    if (!sameFilesystemIdentity(beforeProvenance, expectedIdentity)) {
      throw new Error('The private recovery database changed during provenance inspection.');
    }
    const candidate = createStore(databasePath, defaults, expectedIdentity);
    try {
      const report = candidate.checkIntegrity('full');
      if (!report.ok) throw new Error('The private recovery copy failed full validation.');
      appendRecoveryAudit?.(candidate);
    } finally {
      candidate.close();
    }
  };

  return openStoreWithStartupRecovery<LocalStore, RecoverySelection>({
    classifyOpenFailure,
    closeStore: (recoveredStore) => recoveredStore.close(),
    dialog: options.dialog,
    openStore,
    chooseVerifiedBackup: async () => {
      const selection = await options.dialog.showOpenDialog({
        title: 'Choose a verified Forgeboard backup',
        buttonLabel: 'Choose backup',
        properties: ['openFile'],
        filters: [
          { name: 'SQLite database', extensions: ['sqlite', 'sqlite3', 'db'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      const selectedPath = selection.filePaths.length === 1 ? selection.filePaths[0] : undefined;
      if (selection.canceled || selectedPath === undefined) return null;

      const preparedUserData = canonicalUserData;
      if (preparedUserData === undefined) {
        throw new Error('The startup database boundary is unavailable.');
      }
      const stagingDirectory = await createPrivateAttemptDirectory(
        preparedUserData,
        platform,
        windowsSecurity,
        windowsSid,
      );
      try {
        const stagedBackup = await stageBackup(selectedPath, stagingDirectory, {
          platform,
          validateStaged: validatePrivateDatabase,
          ...(platform === 'win32' ? { windowsSecurity } : {}),
        });
        return { stagedBackup, stagingDirectory };
      } catch (error) {
        await cleanup(stagingDirectory);
        throw error;
      }
    },
    restoreVerifiedBackup: async (selection) => {
      try {
        const preparedDatabasePath = databasePath;
        if (preparedDatabasePath === undefined) {
          throw new Error('The startup database boundary is unavailable.');
        }
        const activeWindowsSid = windowsSid;
        await restoreDatabase({
          stagedBackup: selection.stagedBackup,
          databasePath: preparedDatabasePath,
          validateStagedDatabase: validatePrivateDatabase,
          validateInstalledDatabase: (installedPath: string) =>
            validatePrivateDatabase(installedPath, (candidate) => {
              candidate.appendAudit('recovery', 'database-restore', 'allowed', {
                sourceSha256: selection.stagedBackup.sourceSha256,
                stagedSha256: selection.stagedBackup.sha256,
                sizeBytes: selection.stagedBackup.sizeBytes,
              });
            }),
          platform,
          ...(platform === 'win32' && activeWindowsSid !== undefined
            ? {
                windowsPrivacy: {
                  protectPrivateDirectory: async (path: string) => {
                    await windowsSecurity.protectPrivateDirectory(path, activeWindowsSid);
                    await windowsSecurity.assertPrivateDirectory(path, activeWindowsSid);
                  },
                  protectPrivateFile: async (path: string) => {
                    await windowsSecurity.protectPrivateFile(path, activeWindowsSid);
                    await windowsSecurity.assertPrivateFile(path, activeWindowsSid);
                  },
                },
                ...(windowsDurability === undefined ? {} : { windowsDurability }),
              }
            : {}),
        });
      } finally {
        // Removing the whole private attempt also removes any SQLite WAL/SHM sidecars created while
        // migrating or fully validating the copy.
        await cleanup(selection.stagingDirectory).catch(() => undefined);
      }
    },
  });
}

class StartupDatabaseOpenError extends Error {
  public constructor(readonly reason: ForgeboardDatabaseProvenanceFailureReason) {
    super('Forgeboard rejected the local database before startup.');
    this.name = 'StartupDatabaseOpenError';
  }
}

class StartupDatabaseMissingError extends Error {
  public constructor() {
    super('The initialized Forgeboard database is missing.');
    this.name = 'StartupDatabaseMissingError';
  }
}

function classifyOpenFailure(error: unknown): StartupOpenFailure {
  if (error instanceof StartupDatabaseMissingError) return { kind: 'recoverable' };
  if (error instanceof StartupDatabaseOpenError) {
    if (error.reason === 'corrupt' || error.reason === 'foreign') {
      return { kind: 'recoverable' };
    }
    if (error.reason === 'newer') return { kind: 'newer-schema' };
    return { kind: 'unavailable' };
  }
  if (
    error instanceof Error &&
    error.message.startsWith('The local Forgeboard database failed its startup integrity check:')
  ) {
    return { kind: 'recoverable' };
  }
  if (isRecord(error) && (error.errcode === 11 || error.errcode === 26)) {
    return { kind: 'recoverable' };
  }
  return { kind: 'unavailable' };
}

function initializationMarkerOptions(
  platform: NodeJS.Platform,
  windowsSecurity: WindowsFilesystemSecurity,
  windowsSid: string | undefined,
  getUserId: () => number | undefined,
  windowsDurability: InitializationMarkerWindowsDurability | undefined,
): InitializationMarkerOptions {
  return {
    platform,
    getUserId,
    ...(windowsDurability === undefined ? {} : { windowsDurability }),
    ...(platform === 'win32' && windowsSid !== undefined
      ? {
          windowsPrivacy: {
            protectPrivateFile: (path: string) =>
              windowsSecurity.protectPrivateFile(path, windowsSid),
            assertPrivateFile: (path: string) =>
              windowsSecurity.assertPrivateFile(path, windowsSid),
          },
        }
      : {}),
  };
}

function stableDatabaseIdentity(databasePath: string): ExpectedDatabaseIdentity {
  const stats = lstatSync(databasePath);
  if (!stats.isFile() || stats.isSymbolicLink() || realpathSync(databasePath) !== databasePath) {
    throw new Error('The local database path is not a stable ordinary file.');
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    ctimeMs: stats.ctimeMs,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

async function reconcileBeforeOpen(
  databasePath: string,
  platform: NodeJS.Platform,
  windowsSecurity: WindowsFilesystemSecurity,
  windowsSid: string | undefined,
  windowsDurability: WindowsDurableFilesystemAuthority | undefined,
  injected: ((databasePath: string) => Promise<void>) | undefined,
): Promise<void> {
  if (injected !== undefined) {
    await injected(databasePath);
    return;
  }
  await reconcileInterruptedDatabaseRestores({
    databasePath,
    platform,
    ...(platform === 'win32' && windowsSid !== undefined
      ? {
          privacyAuthority: {
            assertPrivateDirectory: (path: string) =>
              windowsSecurity.assertPrivateDirectory(path, windowsSid),
            assertPrivateFile: (path: string) =>
              windowsSecurity.assertPrivateFile(path, windowsSid),
          },
          ...(windowsDurability === undefined ? {} : { windowsDurability }),
        }
      : {}),
  });
}

async function prepareUserDataBoundary(
  userDataPath: string,
  platform: NodeJS.Platform,
  windowsSecurity: WindowsFilesystemSecurity,
  windowsSid: string | undefined,
  getUserId: () => number | undefined,
): Promise<string> {
  const initial = await optionalLstat(userDataPath);
  if (initial === undefined) {
    await mkdir(userDataPath, { recursive: true, mode: 0o700 });
  } else if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new Error('The Forgeboard user data location must be an ordinary directory.');
  }
  const canonical = await realpath(userDataPath);
  if (canonical !== resolve(userDataPath)) {
    throw new Error('The Forgeboard user data location must not traverse filesystem links.');
  }
  const current = await lstat(canonical);
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error('The Forgeboard user data location must be an ordinary directory.');
  }
  if (platform === 'win32') {
    if (windowsSid === undefined) throw new Error('Windows recovery identity is unavailable.');
    await windowsSecurity.protectPrivateDirectory(canonical, windowsSid);
    await windowsSecurity.assertPrivateDirectory(canonical, windowsSid);
  } else {
    assertOwnedByCurrentUser(current, 'user data directory', getUserId);
    await chmod(canonical, 0o700);
    const protectedStats = await lstat(canonical);
    if (
      !protectedStats.isDirectory() ||
      protectedStats.isSymbolicLink() ||
      !sameFilesystemIdentity(current, protectedStats) ||
      (protectedStats.mode & 0o077) !== 0
    ) {
      throw new Error('Forgeboard could not protect its user data directory.');
    }
    assertOwnedByCurrentUser(protectedStats, 'user data directory', getUserId);
  }
  return canonical;
}

async function protectDatabaseBoundary(
  databasePath: string,
  platform: NodeJS.Platform,
  windowsSecurity: WindowsFilesystemSecurity,
  windowsSid: string | undefined,
  getUserId: () => number | undefined,
): Promise<void> {
  const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`] as const;
  const stats = await Promise.all(paths.map(async (path) => await optionalLstat(path)));
  if (stats[0] === undefined && stats.slice(1).some((value) => value !== undefined)) {
    throw new Error('Forgeboard found database sidecars without the primary database.');
  }
  for (const [index, details] of stats.entries()) {
    if (details === undefined) continue;
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error('A Forgeboard database path is not an ordinary file.');
    }
    const path = paths[index];
    if (path === undefined || (await realpath(path)) !== path) {
      throw new Error('A Forgeboard database path is not canonical.');
    }
    if (platform === 'win32') {
      if (windowsSid === undefined) throw new Error('Windows recovery identity is unavailable.');
      await windowsSecurity.protectPrivateFile(path, windowsSid);
      await windowsSecurity.assertPrivateFile(path, windowsSid);
    } else {
      assertOwnedByCurrentUser(details, 'database file', getUserId);
      await chmod(path, 0o600);
      const protectedStats = await lstat(path);
      if (
        !protectedStats.isFile() ||
        protectedStats.isSymbolicLink() ||
        !sameFilesystemIdentity(details, protectedStats) ||
        (protectedStats.mode & 0o077) !== 0
      ) {
        throw new Error('Forgeboard could not protect a local database file.');
      }
      assertOwnedByCurrentUser(protectedStats, 'database file', getUserId);
    }
  }
}

async function databaseFileExists(databasePath: string): Promise<boolean> {
  return (await optionalLstat(databasePath)) !== undefined;
}

async function createPrivateAttemptDirectory(
  canonicalUserData: string,
  platform: NodeJS.Platform,
  windowsSecurity: WindowsFilesystemSecurity,
  windowsSid: string | undefined,
): Promise<string> {
  const stagingDirectory = await realpath(await mkdtemp(join(canonicalUserData, STAGING_PREFIX)));
  try {
    if (dirname(stagingDirectory) !== canonicalUserData) {
      throw new Error('Forgeboard could not create private recovery staging inside user data.');
    }
    if (platform === 'win32') {
      if (windowsSid === undefined) throw new Error('Windows recovery identity is unavailable.');
      await windowsSecurity.protectPrivateDirectory(stagingDirectory, windowsSid);
      await windowsSecurity.assertPrivateDirectory(stagingDirectory, windowsSid);
    } else {
      await chmod(stagingDirectory, 0o700);
    }
    return stagingDirectory;
  } catch (error) {
    await cleanupAttemptDirectory(stagingDirectory).catch(() => undefined);
    throw error;
  }
}

async function cleanupAttemptDirectory(stagingDirectory: string): Promise<void> {
  await rm(stagingDirectory, { recursive: true, force: true });
}

function assertDirectDatabasePath(databasePath: string, canonicalUserData: string): string {
  if (databasePath.includes('\0')) throw new Error('Forgeboard rejected the database path.');
  const normalized = resolve(databasePath);
  if (dirname(normalized) !== canonicalUserData || basename(normalized) !== 'forgeboard.sqlite') {
    throw new Error(
      'The Forgeboard database must be directly inside its canonical user data folder.',
    );
  }
  return normalized;
}

async function optionalLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertOwnedByCurrentUser(
  stats: Stats,
  label: string,
  getUserId: () => number | undefined,
): void {
  const userId = getUserId();
  if (userId !== undefined && stats.uid !== userId) {
    throw new Error(`The Forgeboard ${label} is not owned by the current user.`);
  }
}

function sameFilesystemIdentity(
  before: { readonly dev: number; readonly ino: number },
  after: { readonly dev: number; readonly ino: number },
): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}
