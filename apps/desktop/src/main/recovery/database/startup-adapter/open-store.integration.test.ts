import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Dialog } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../../../../shared/application/contracts.js';
import { LocalStore } from '../../../storage.js';
import { openLocalStoreWithStartupDatabaseRecovery } from './open-store.js';
import { readInitializationMarker } from './initialization-marker.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('startup database recovery composition', () => {
  it('restores an initialized missing primary through the real startup adapter', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-missing-recovery-')));
    roots.push(root);
    const userDataPath = join(root, 'user-data');
    const backupDirectory = join(root, 'backups');
    const databasePath = join(userDataPath, 'forgeboard.sqlite');
    await mkdir(userDataPath, { mode: 0o700 });
    const original = new LocalStore(databasePath, {
      legacySettingsDefaults: defaultSettings(root),
    });
    const backup = await original.createBackup(backupDirectory);
    original.close();

    const bootstrapped = await openLocalStoreWithStartupDatabaseRecovery({
      databasePath,
      dialog: {
        showMessageBox: vi.fn(),
        showOpenDialog: vi.fn(),
      } as unknown as Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>,
      userDataPath,
      dependencies: { createDefaultSettings: () => defaultSettings(root) },
    });
    bootstrapped?.close();
    await rm(databasePath);
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });

    const dialog = {
      showMessageBox: vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false })),
      showOpenDialog: vi.fn(() => Promise.resolve({ canceled: false, filePaths: [backup.path] })),
    } as unknown as Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>;
    const recovered = await openLocalStoreWithStartupDatabaseRecovery({
      databasePath,
      dialog,
      userDataPath,
      dependencies: { createDefaultSettings: () => defaultSettings(root) },
    });

    expect(recovered).not.toBeNull();
    expect(recovered?.checkIntegrity('full')).toMatchObject({
      ok: true,
      mode: 'full',
    });
    recovered?.close();
    expect(dialog.showOpenDialog).toHaveBeenCalledOnce();
  });

  it('bootstraps the durable initialization marker for an existing verified database', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-marker-bootstrap-')));
    roots.push(root);
    const userDataPath = join(root, 'user-data');
    const databasePath = join(userDataPath, 'forgeboard.sqlite');
    await mkdir(userDataPath, { mode: 0o700 });
    new LocalStore(databasePath, {
      legacySettingsDefaults: defaultSettings(root),
    }).close();

    const store = await openLocalStoreWithStartupDatabaseRecovery({
      databasePath,
      dialog: {
        showMessageBox: vi.fn(),
        showOpenDialog: vi.fn(),
      } as unknown as Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>,
      userDataPath,
      dependencies: { createDefaultSettings: () => defaultSettings(root) },
    });

    expect(store).not.toBeNull();
    store?.close();
    await expect(readInitializationMarker(userDataPath)).resolves.toBe('initialized');

    await rm(databasePath);
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    const missingDialog = {
      showMessageBox: vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false })),
      showOpenDialog: vi.fn(),
    } as unknown as Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>;
    await expect(
      openLocalStoreWithStartupDatabaseRecovery({
        databasePath,
        dialog: missingDialog,
        userDataPath,
        dependencies: { createDefaultSettings: () => defaultSettings(root) },
      }),
    ).resolves.toBeNull();
    await expect(readFile(databasePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(missingDialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('upgrades the exact legacy audit delete-trigger gap without offering destructive recovery', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-trigger-upgrade-')));
    roots.push(root);
    const userDataPath = join(root, 'user-data');
    const databasePath = join(userDataPath, 'forgeboard.sqlite');
    await mkdir(userDataPath, { mode: 0o700 });
    const original = new LocalStore(databasePath, {
      legacySettingsDefaults: defaultSettings(root),
    });
    original.appendAudit('recovery', 'legacy-trigger-upgrade-proof', 'allowed', {});
    original.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('DROP TRIGGER audit_events_no_delete; DROP TRIGGER audit_checkpoints_no_delete;');
    legacy.close();
    const dialog = {
      showMessageBox: vi.fn(),
      showOpenDialog: vi.fn(),
    } as unknown as Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>;

    const upgraded = await openLocalStoreWithStartupDatabaseRecovery({
      databasePath,
      dialog,
      userDataPath,
      dependencies: { createDefaultSettings: () => defaultSettings(root) },
    });

    expect(upgraded).not.toBeNull();
    expect(upgraded?.checkIntegrity('full')).toMatchObject({ ok: true, mode: 'full' });
    expect(upgraded?.listAuditEvents(20).map((event) => event.action)).toContain(
      'legacy-trigger-upgrade-proof',
    );
    upgraded?.close();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    const triggerCount = inspected
      .prepare(
        `SELECT count(*) AS count FROM sqlite_schema
         WHERE type = 'trigger' AND name IN (?, ?)`,
      )
      .get('audit_events_no_delete', 'audit_checkpoints_no_delete') as { count: number };
    expect(triggerCount.count).toBe(2);
    inspected.close();
  });

  it('recovers a corrupt primary from a real verified backup without leaving private staging', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-recovery-wiring-')));
    roots.push(root);
    const userDataPath = join(root, 'user-data');
    const backupDirectory = join(root, 'backups');
    const databasePath = join(userDataPath, 'forgeboard.sqlite');
    await mkdir(userDataPath, { mode: 0o700 });

    const original = new LocalStore(databasePath, {
      legacySettingsDefaults: defaultSettings(root),
    });
    const backup = await original.createBackup(backupDirectory, new Date('2026-07-17T12:00:00Z'));
    original.close();
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await writeFile(databasePath, Buffer.from('not a sqlite database'));

    const dialog = {
      showMessageBox: vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false })),
      showOpenDialog: vi.fn(() => Promise.resolve({ canceled: false, filePaths: [backup.path] })),
    } as unknown as Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>;

    const recovered = await openLocalStoreWithStartupDatabaseRecovery({
      databasePath,
      dialog,
      userDataPath,
      dependencies: {
        cleanupAttemptDirectory: () => Promise.reject(new Error('injected cleanup failure')),
        createDefaultSettings: () => defaultSettings(root),
      },
    });

    expect(recovered).not.toBeNull();
    expect(recovered?.checkIntegrity('full')).toMatchObject({
      ok: true,
      mode: 'full',
    });
    recovered?.close();
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(dialog.showOpenDialog).toHaveBeenCalledOnce();
    expect(
      (await readdir(userDataPath)).filter((name) =>
        name.startsWith('.forgeboard-database-recovery-'),
      ),
    ).toHaveLength(1);

    const restartDialog = {
      showMessageBox: vi.fn(),
      showOpenDialog: vi.fn(),
    } as unknown as Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>;
    const restarted = await openLocalStoreWithStartupDatabaseRecovery({
      databasePath,
      dialog: restartDialog,
      userDataPath,
      dependencies: { createDefaultSettings: () => defaultSettings(root) },
    });
    expect(restarted).not.toBeNull();
    restarted?.close();
    expect(
      (await readdir(userDataPath)).filter((name) =>
        name.startsWith('.forgeboard-database-recovery-'),
      ),
    ).toEqual([]);
    expect(restartDialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('rejects a replacement inode after DatabaseSync opens but before any writable startup PRAGMA', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-identity-open-')));
    roots.push(root);
    const databasePath = join(root, 'forgeboard.sqlite');
    const replacementPath = join(root, 'replacement.sqlite');
    new LocalStore(databasePath, {
      legacySettingsDefaults: defaultSettings(root),
    }).close();
    new LocalStore(replacementPath, {
      legacySettingsDefaults: defaultSettings(root),
    }).close();
    const expected = await lstat(databasePath);
    await rm(databasePath);
    await rename(replacementPath, databasePath);
    const replacementBefore = await readFile(databasePath);

    expect(
      () =>
        new LocalStore(databasePath, {
          legacySettingsDefaults: defaultSettings(root),
          expectedDatabaseIdentity: {
            dev: expected.dev,
            ino: expected.ino,
            ctimeMs: expected.ctimeMs,
            mtimeMs: expected.mtimeMs,
            size: expected.size,
          },
        }),
    ).toThrow('changed before its writable handle was bound');
    await expect(readFile(databasePath)).resolves.toEqual(replacementBefore);
  });

  it('rolls back the exact prior primary when installed recovery audit persistence fails', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-audit-rollback-')));
    roots.push(root);
    const userDataPath = join(root, 'user-data');
    const backupDirectory = join(root, 'backups');
    const databasePath = join(userDataPath, 'forgeboard.sqlite');
    await mkdir(userDataPath, { mode: 0o700 });
    const original = new LocalStore(databasePath, {
      legacySettingsDefaults: defaultSettings(root),
    });
    const backup = await original.createBackup(backupDirectory);
    original.close();
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await writeFile(databasePath, 'corrupt primary that must survive rollback');
    const corruptBefore = await readFile(databasePath);
    const dialog = {
      showMessageBox: vi
        .fn()
        .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
        .mockResolvedValueOnce({ response: 0, checkboxChecked: false }),
      showOpenDialog: vi.fn(() => Promise.resolve({ canceled: false, filePaths: [backup.path] })),
    } as unknown as Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>;

    const result = await openLocalStoreWithStartupDatabaseRecovery({
      databasePath,
      dialog,
      userDataPath,
      dependencies: {
        createDefaultSettings: () => defaultSettings(root),
        createStore: (path, defaults, expectedDatabaseIdentity) => {
          const store = new LocalStore(path, {
            legacySettingsDefaults: defaults,
            ...(expectedDatabaseIdentity === undefined ? {} : { expectedDatabaseIdentity }),
          });
          store.appendAudit = () => {
            throw new Error('injected recovery audit failure');
          };
          return store;
        },
      },
    });

    expect(result).toBeNull();
    await expect(readFile(databasePath)).resolves.toEqual(corruptBefore);
    expect(dialog.showOpenDialog).toHaveBeenCalledOnce();
  });
});

function defaultSettings(root: string): AppSettings {
  return {
    onboardingCompleted: false,
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    canvasGridSize: 16,
    canvasSnapToGrid: true,
    keyboardPreset: 'standard',
    defaultAgent: 'codex',
    defaultPermissionProfile: 'plan-read-only',
    agentExecutableOverrides: {},
    agentDefaultModels: {},
    customAgent: {
      enabled: false,
      name: 'Custom CLI',
      providerName: 'Custom provider',
      providerDisclosure: 'User-configured provider.',
      sendsContextOffDevice: true,
      executable: '',
      versionArguments: ['--version'],
      launchArguments: [],
      promptTransport: 'argument',
      runtime: 'pty',
      output: 'text',
    },
    customPermissionProfile: {
      runtime: 'host',
      filesystem: 'assigned-worktree-read-only',
      readPaths: ['.'],
      writePaths: [],
      ignoredFileRead: 'deny',
      sensitiveFileRead: 'deny',
      executablePolicy: 'selected-agent-only',
      allowedExecutables: [],
      forgeboardManagedActions: { developmentServers: 'deny', tests: 'deny' },
      requireReviewBeforePrimary: true,
      docker: {
        network: 'disabled',
        cpuLimit: 2,
        memoryMb: 4096,
        mountHostCredentials: false,
      },
    },
    worktreeRoot: join(root, 'worktrees'),
    worktreeCleanupPolicy: 'manual',
    branchPrefix: 'forgeboard/',
    gitIdentityName: '',
    gitIdentityEmail: '',
    gitRemote: 'origin',
    externalEditorExecutable: '',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH'],
    developmentCommand: { executable: '', arguments: [] },
    testCommand: { executable: '', arguments: [] },
    lintCommand: { executable: '', arguments: [] },
    typecheckCommand: { executable: '', arguments: [] },
    buildCommand: { executable: '', arguments: [] },
    previewPortStart: 41_000,
    previewPortEnd: 41_999,
    previewTrustedHosts: ['127.0.0.1'],
    dockerEnabled: false,
    dockerExecutable: 'docker',
    dockerImage: '',
    dockerContainerExecutable: '',
    dockerNetwork: 'disabled',
    dockerCpuLimit: 2,
    dockerMemoryMb: 4096,
    dockerMountHostCredentials: false,
    transcriptRetentionDays: 30,
    auditRetentionDays: 365,
    snapshotRetentionCount: 100,
    autosaveIntervalMs: 2_000,
    backupsEnabled: true,
    backupDirectory: join(root, 'backups'),
    backupIntervalHours: 24,
    backupOnQuit: true,
    backupRetentionCount: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
    collaborationManagementUrl: '',
    collaborationDisplayName: 'Local user',
    collaborationSubject: 'local-user',
    collaborationColor: '#6d5efc',
    collaborationRoom: 'default',
    collaborationReconnect: true,
    updateChannel: 'stable',
    automaticUpdateDownloads: false,
    voiceCommandsEnabled: false,
  };
}
