import { rmSync, writeFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Dialog } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../../../../shared/application/contracts.js';
import type { AtomicDatabaseRestoreOptions } from '../atomic-restore.js';
import type { SelectedBackupValidationOptions, StagedSelectedBackup } from '../selected-backup.js';
import type { ForgeboardDatabaseProvenanceResult } from '../provenance/inspect.js';
import type { WindowsFilesystemSecurity } from '../../../security/windows/filesystem-acl.js';
import type { LocalStore } from '../../../storage.js';
import { openLocalStoreWithStartupDatabaseRecovery } from './open-store.js';
import { writeInitializationMarker } from './initialization-marker.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('openLocalStoreWithStartupDatabaseRecovery', () => {
  it('reconciles before a healthy first open and presents no recovery UI', async () => {
    const root = await fixtureRoot();
    const events: string[] = [];
    const healthy = fakeStore();
    const dialog = fakeDialog();

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath: join(root, 'forgeboard.sqlite'),
        dialog,
        userDataPath: root,
        dependencies: {
          createDefaultSettings: () => defaults(),
          createStore: () => {
            events.push('open');
            return healthy;
          },
          reconcileInterruptedRestores: () => {
            events.push('reconcile');
            return Promise.resolve();
          },
        },
      }),
    ).resolves.toBe(healthy);

    expect(events).toEqual(['reconcile', 'open']);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('records a path-free audit warning when bounded deferred cleanup cannot finish', async () => {
    const root = await fixtureRoot();
    const appendAudit = vi.fn();
    const healthy = fakeStore(appendAudit);

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath: join(root, 'forgeboard.sqlite'),
        dialog: fakeDialog(),
        userDataPath: root,
        dependencies: {
          cleanupDeferredStaging: () => Promise.resolve({ failedCount: 2, removedCount: 1 }),
          createDefaultSettings: () => defaults(),
          createStore: () => healthy,
          reconcileInterruptedRestores: () => Promise.resolve(),
        },
      }),
    ).resolves.toBe(healthy);

    expect(appendAudit).toHaveBeenCalledWith('recovery', 'staging-cleanup', 'failed', {
      failedCount: 2,
    });
    expect(JSON.stringify(appendAudit.mock.calls)).not.toContain(root);
  });

  it('stages, migrates, fully validates, atomically restores, and cleans each private attempt', async () => {
    const root = await fixtureRoot();
    const databasePath = join(root, 'forgeboard.sqlite');
    const appendAudit = vi.fn();
    const restored = fakeStore(appendAudit);
    const validatedPaths: string[] = [];
    let stagingDirectory = '';
    await writeFile(databasePath, 'corrupt');
    const stageBackup = vi.fn<
      (
        selectedPath: string,
        directory: string,
        options?: SelectedBackupValidationOptions,
      ) => Promise<StagedSelectedBackup>
    >(async (selectedPath, directory, options = {}) => {
      expect(selectedPath).toBe('/chosen/backup.sqlite3');
      stagingDirectory = directory;
      const stagedPath = join(directory, 'selected.sqlite3');
      await writeFile(stagedPath, 'staged');
      await options.validateStaged?.(stagedPath);
      return {
        stagedPath,
        sourceSha256: 'c'.repeat(64),
        sha256: 'a'.repeat(64),
        sizeBytes: 128,
      };
    });
    const restoreDatabase = vi.fn(async (options: AtomicDatabaseRestoreOptions) => {
      const candidatePath = join(root, 'candidate.sqlite');
      await writeFile(candidatePath, 'candidate');
      await options.validateStagedDatabase(candidatePath);
      await options.validateInstalledDatabase?.(databasePath);
      return {
        operationId: 'restore-id',
        quarantineDirectory: join(root, 'quarantine'),
        restoredDatabasePath: databasePath,
      };
    });
    const dialog = fakeDialog();
    dialog.showMessageBox.mockResolvedValue(messageResponse(1));
    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/chosen/backup.sqlite3'],
    });

    const result = await openLocalStoreWithStartupDatabaseRecovery({
      databasePath,
      dialog,
      userDataPath: root,
      dependencies: {
        createDefaultSettings: () => defaults(),
        inspectProvenance: recoverableThenHealthyProvenance(),
        createStore: (path) => {
          if (path === databasePath) {
            return restored;
          }
          validatedPaths.push(path);
          return fakeStore();
        },
        restoreDatabase,
        stageBackup,
      },
    });

    expect(result).toBe(restored);
    expect(stageBackup).toHaveBeenCalledOnce();
    expect(restoreDatabase).toHaveBeenCalledOnce();
    expect(validatedPaths).toHaveLength(2);
    expect(appendAudit).toHaveBeenCalledWith('recovery', 'database-restore', 'allowed', {
      sourceSha256: 'c'.repeat(64),
      stagedSha256: 'a'.repeat(64),
      sizeBytes: 128,
    });
    expect(await readdir(root)).not.toContain(stagingDirectory.split('/').at(-1));
  });

  it('returns null without restoring when the native chooser is canceled', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'forgeboard.sqlite'), 'corrupt');
    const dialog = fakeDialog();
    dialog.showMessageBox.mockResolvedValue(messageResponse(1));
    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const restoreDatabase = vi.fn();

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath: join(root, 'forgeboard.sqlite'),
        dialog,
        userDataPath: root,
        dependencies: {
          createDefaultSettings: () => defaults(),
          inspectProvenance: recoverableThenHealthyProvenance(),
          createStore: () => fakeStore(),
          restoreDatabase,
        },
      }),
    ).resolves.toBeNull();

    expect(restoreDatabase).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['forgeboard.sqlite']);
  });

  it('never creates an empty replacement when an initialized database is missing', async () => {
    const root = await fixtureRoot();
    await writeInitializationMarker(root);
    const createStore = vi.fn(() => fakeStore());
    const dialog = fakeDialog();
    dialog.showMessageBox.mockResolvedValue(messageResponse(0));

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath: join(root, 'forgeboard.sqlite'),
        dialog,
        userDataPath: root,
        dependencies: { createDefaultSettings: () => defaults(), createStore },
      }),
    ).resolves.toBeNull();

    expect(createStore).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ['Quit Forgeboard', 'Choose verified backup'],
        defaultId: 0,
      }),
    );
    expect(await readdir(root)).toEqual(['.forgeboard-initialized-v1']);
  });

  it('rejects a primary swapped after provenance before writable LocalStore open', async () => {
    const root = await fixtureRoot();
    const databasePath = join(root, 'forgeboard.sqlite');
    await writeFile(databasePath, 'original');
    const createStore = vi.fn(() => fakeStore());
    const dialog = fakeDialog();

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath,
        dialog,
        userDataPath: root,
        dependencies: {
          createDefaultSettings: () => defaults(),
          createStore,
          inspectProvenance: () => {
            rmSync(databasePath);
            writeFileSync(databasePath, 'replacement');
            return {
              ok: true,
              schemaVersion: 1,
              currentSchemaVersion: 1,
              requiresMigration: false,
            };
          },
          reconcileInterruptedRestores: () => Promise.resolve(),
        },
      }),
    ).resolves.toBeNull();

    expect(createStore).not.toHaveBeenCalled();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Local data is unavailable' }),
    );
  });

  it('rejects same-inode primary bytes changed during provenance inspection', async () => {
    const root = await fixtureRoot();
    const databasePath = join(root, 'forgeboard.sqlite');
    await writeFile(databasePath, 'original');
    const createStore = vi.fn(() => fakeStore());
    const dialog = fakeDialog();

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath,
        dialog,
        userDataPath: root,
        dependencies: {
          createDefaultSettings: () => defaults(),
          createStore,
          inspectProvenance: () => {
            writeFileSync(databasePath, 'mutated in place after inspection began');
            return {
              ok: true,
              schemaVersion: 1,
              currentSchemaVersion: 1,
              requiresMigration: false,
            };
          },
          reconcileInterruptedRestores: () => Promise.resolve(),
        },
      }),
    ).resolves.toBeNull();

    expect(createStore).not.toHaveBeenCalled();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Local data is unavailable' }),
    );
  });

  it('rejects a database outside the canonical userData boundary before reconciliation or open', async () => {
    const root = await fixtureRoot();
    const reconcile = vi.fn(() => Promise.resolve());
    const createStore = vi.fn(() => fakeStore());

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath: join(root, 'nested', 'forgeboard.sqlite'),
        dialog: fakeDialog(),
        userDataPath: root,
        dependencies: {
          createDefaultSettings: () => defaults(),
          createStore,
          reconcileInterruptedRestores: reconcile,
        },
      }),
    ).resolves.toBeNull();

    expect(reconcile).not.toHaveBeenCalled();
    expect(createStore).not.toHaveBeenCalled();
  });

  it('uses the real Windows DACL authority for staging and atomic-restore privacy wrappers', async () => {
    const root = await fixtureRoot();
    const databasePath = join(root, 'forgeboard.sqlite');
    const security = fakeWindowsSecurity();
    const dialog = fakeDialog();
    dialog.showMessageBox.mockResolvedValue(messageResponse(1));
    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\backup.sqlite3'],
    });
    await writeFile(databasePath, 'corrupt');
    const restoreDatabase = vi.fn(async (options: AtomicDatabaseRestoreOptions) => {
      await options.windowsPrivacy?.protectPrivateDirectory('C:\\restore');
      await options.windowsPrivacy?.protectPrivateFile('C:\\restore\\candidate.sqlite');
      return {
        operationId: 'restore-id',
        quarantineDirectory: 'C:\\restore',
        restoredDatabasePath: databasePath,
      };
    });

    const result = await openLocalStoreWithStartupDatabaseRecovery({
      databasePath,
      dialog,
      userDataPath: root,
      dependencies: {
        platform: 'win32',
        windowsMarkerDurability: { moveFileWriteThrough: rename },
        windowsSecurity: security,
        createDefaultSettings: () => defaults(),
        inspectProvenance: recoverableThenHealthyProvenance(),
        createStore: (path) => {
          void path;
          return fakeStore();
        },
        stageBackup: (_selected, directory) =>
          Promise.resolve({
            stagedPath: join(directory, 'selected.sqlite3'),
            sourceSha256: 'c'.repeat(64),
            sha256: 'b'.repeat(64),
            sizeBytes: 64,
          }),
        restoreDatabase,
      },
    });

    expect(result).not.toBeNull();
    expect(security.currentUserSid).toHaveBeenCalled();
    expect(security.protectPrivateDirectory).toHaveBeenCalledWith(root, 'S-1-5-21-1000');
    expect(security.assertPrivateDirectory).toHaveBeenCalledWith(root, 'S-1-5-21-1000');
    expect(security.protectPrivateDirectory).toHaveBeenCalledWith(
      expect.stringContaining('.forgeboard-database-recovery-'),
      'S-1-5-21-1000',
    );
    expect(security.protectPrivateDirectory).toHaveBeenCalledWith('C:\\restore', 'S-1-5-21-1000');
    expect(security.protectPrivateFile).toHaveBeenCalledWith(
      'C:\\restore\\candidate.sqlite',
      'S-1-5-21-1000',
    );
    expect(security.assertPrivateDirectory).toHaveBeenCalledWith('C:\\restore', 'S-1-5-21-1000');
    expect(security.assertPrivateFile).toHaveBeenCalledWith(
      'C:\\restore\\candidate.sqlite',
      'S-1-5-21-1000',
    );
  });

  it('removes Windows staging when DACL protection fails before the backup is copied', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'forgeboard.sqlite'), 'corrupt');
    const security = fakeWindowsSecurity();
    security.protectPrivateDirectory = vi.fn(() => Promise.reject(new Error('DACL failed')));
    const dialog = fakeDialog();
    dialog.showMessageBox
      .mockResolvedValueOnce(messageResponse(1))
      .mockResolvedValueOnce(messageResponse(0));
    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['C:\\backup.sqlite3'],
    });
    const stageBackup = vi.fn();

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath: join(root, 'forgeboard.sqlite'),
        dialog,
        userDataPath: root,
        dependencies: {
          platform: 'win32',
          windowsSecurity: security,
          createDefaultSettings: () => defaults(),
          inspectProvenance: recoverableThenHealthyProvenance(),
          createStore: () => fakeStore(),
          stageBackup,
        },
      }),
    ).resolves.toBeNull();

    expect(stageBackup).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['forgeboard.sqlite']);
  });

  it.each([
    ['newer' as const, 'A newer Forgeboard version is required'],
    ['unavailable' as const, 'Local data is unavailable'],
  ])('does not offer restore for %s provenance', async (reason, expectedTitle) => {
    const root = await fixtureRoot();
    const databasePath = join(root, 'forgeboard.sqlite');
    await writeFile(databasePath, 'database');
    const dialog = fakeDialog();

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath,
        dialog,
        userDataPath: root,
        dependencies: {
          createDefaultSettings: () => defaults(),
          createStore: () => fakeStore(),
          inspectProvenance: () => ({
            ok: false,
            reason,
            message: 'bounded',
          }),
          reconcileInterruptedRestores: () => Promise.resolve(),
        },
      }),
    ).resolves.toBeNull();

    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expectedTitle,
        buttons: ['Quit Forgeboard'],
      }),
    );
  });

  it('offers verified restore for a foreign primary while still defaulting to Quit', async () => {
    const root = await fixtureRoot();
    const databasePath = join(root, 'forgeboard.sqlite');
    await writeFile(databasePath, 'foreign database');
    const dialog = fakeDialog();
    dialog.showMessageBox.mockResolvedValue(messageResponse(0));

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath,
        dialog,
        userDataPath: root,
        dependencies: {
          createDefaultSettings: () => defaults(),
          createStore: () => fakeStore(),
          inspectProvenance: () => ({
            ok: false,
            reason: 'foreign',
            message: 'bounded',
          }),
          reconcileInterruptedRestores: () => Promise.resolve(),
        },
      }),
    ).resolves.toBeNull();
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ['Quit Forgeboard', 'Choose verified backup'],
        defaultId: 0,
      }),
    );
  });

  it('rejects user-data and database symlinks before SQLite opens', async () => {
    const parent = await fixtureRoot();
    const actualUserData = join(parent, 'actual');
    await mkdir(actualUserData);
    const linkedUserData = join(parent, 'linked');
    await symlink(actualUserData, linkedUserData);
    const createStore = vi.fn(() => fakeStore());

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath: join(linkedUserData, 'forgeboard.sqlite'),
        dialog: fakeDialog(),
        userDataPath: linkedUserData,
        dependencies: { createDefaultSettings: () => defaults(), createStore },
      }),
    ).resolves.toBeNull();
    expect(createStore).not.toHaveBeenCalled();

    const root = await fixtureRoot();
    const outside = join(parent, 'outside.sqlite');
    await writeFile(outside, 'database');
    await symlink(outside, join(root, 'forgeboard.sqlite'));
    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath: join(root, 'forgeboard.sqlite'),
        dialog: fakeDialog(),
        userDataPath: root,
        dependencies: { createDefaultSettings: () => defaults(), createStore },
      }),
    ).resolves.toBeNull();
    expect(createStore).not.toHaveBeenCalled();
  });

  it('rejects POSIX user-data ownership that does not match the current user', async () => {
    if (process.getuid === undefined) return;
    const root = await fixtureRoot();
    const actualUserId = process.getuid();
    const createStore = vi.fn(() => fakeStore());
    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath: join(root, 'forgeboard.sqlite'),
        dialog: fakeDialog(),
        userDataPath: root,
        dependencies: {
          createDefaultSettings: () => defaults(),
          createStore,
          getUserId: () => actualUserId + 1,
        },
      }),
    ).resolves.toBeNull();
    expect(createStore).not.toHaveBeenCalled();
  });

  it('rejects a POSIX database owner mismatch after accepting owned user data', async () => {
    if (process.getuid === undefined) return;
    const root = await fixtureRoot();
    const databasePath = join(root, 'forgeboard.sqlite');
    await writeFile(databasePath, 'database');
    const actualUserId = process.getuid();
    let ownershipCheck = 0;
    const createStore = vi.fn(() => fakeStore());

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath,
        dialog: fakeDialog(),
        userDataPath: root,
        dependencies: {
          createDefaultSettings: () => defaults(),
          createStore,
          getUserId: () => {
            ownershipCheck += 1;
            return ownershipCheck <= 2 ? actualUserId : actualUserId + 1;
          },
        },
      }),
    ).resolves.toBeNull();

    expect(ownershipCheck).toBe(3);
    expect(createStore).not.toHaveBeenCalled();
  });

  it('returns the restored store even when best-effort staging cleanup fails', async () => {
    const root = await fixtureRoot();
    const databasePath = join(root, 'forgeboard.sqlite');
    await writeFile(databasePath, 'corrupt');
    const restored = fakeStore();
    const dialog = fakeDialog();
    dialog.showMessageBox.mockResolvedValue(messageResponse(1));
    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/backup.sqlite'],
    });

    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath,
        dialog,
        userDataPath: root,
        dependencies: {
          cleanupAttemptDirectory: () => Promise.reject(new Error('cleanup failed')),
          createDefaultSettings: () => defaults(),
          createStore: () => restored,
          inspectProvenance: recoverableThenHealthyProvenance(),
          stageBackup: (_selected, directory) =>
            Promise.resolve({
              stagedPath: join(directory, 'selected.sqlite'),
              sourceSha256: '1'.repeat(64),
              sha256: '2'.repeat(64),
              sizeBytes: 64,
            }),
          restoreDatabase: () =>
            Promise.resolve({
              operationId: 'restore',
              quarantineDirectory: join(root, 'quarantine'),
              restoredDatabasePath: databasePath,
            }),
        },
      }),
    ).resolves.toBe(restored);
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-startup-adapter-')));
  roots.push(root);
  return root;
}

function fakeDialog() {
  return {
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
  } as unknown as Pick<Dialog, 'showMessageBox' | 'showOpenDialog'> & {
    showMessageBox: ReturnType<typeof vi.fn>;
    showOpenDialog: ReturnType<typeof vi.fn>;
  };
}

function fakeStore(appendAudit = vi.fn()): LocalStore {
  return {
    checkIntegrity: vi.fn(() => ({
      ok: true,
      checkedAt: new Date(0).toISOString(),
      mode: 'full',
      messages: [],
    })),
    appendAudit,
    close: vi.fn(),
  } as unknown as LocalStore;
}

function recoverableThenHealthyProvenance() {
  const healthy: ForgeboardDatabaseProvenanceResult = {
    ok: true,
    schemaVersion: 1,
    currentSchemaVersion: 1,
    requiresMigration: false,
  };
  return vi
    .fn<() => ForgeboardDatabaseProvenanceResult>()
    .mockReturnValueOnce({ ok: false, reason: 'corrupt', message: 'bounded' })
    .mockReturnValue(healthy);
}

function defaults(): AppSettings {
  return {} as AppSettings;
}

function messageResponse(response: number) {
  return { response, checkboxChecked: false };
}

function fakeWindowsSecurity() {
  return {
    currentUserSid: vi.fn(() => Promise.resolve('S-1-5-21-1000')),
    assertSafeParent: vi.fn(() => Promise.resolve()),
    assertConfidentialParent: vi.fn(() => Promise.resolve()),
    protectPrivateDirectory: vi.fn(() => Promise.resolve()),
    assertPrivateDirectory: vi.fn(() => Promise.resolve()),
    protectPrivateFile: vi.fn(() => Promise.resolve()),
    assertPrivateFile: vi.fn(() => Promise.resolve()),
  } satisfies WindowsFilesystemSecurity;
}
