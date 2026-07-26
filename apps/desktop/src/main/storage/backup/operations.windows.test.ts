import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { WindowsFilesystemSecurity } from '../../security/windows/filesystem-acl.js';
import { migrate } from '../database.js';
import { initializeAuditIntegrity } from '../security/audit-integrity.js';
import { createBackup, deleteAllLocalData } from './operations.js';

const NOW = new Date('2026-07-16T12:34:56.000Z');
const SID = 'S-1-5-21-1000-2000-3000-4000';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe('Windows backup filesystem boundaries', () => {
  it('protects a missing destination and private staging before SQLite writes any bytes', async () => {
    const root = await temporaryRoot();
    const destination = join(root, 'nested', 'backups');
    const events: string[] = [];
    const authority = fakeWindowsSecurity({
      assertSafeParent: (path) => {
        events.push(`safe-parent:${path}`);
        return Promise.resolve();
      },
      protectPrivateDirectory: async (path) => {
        events.push(`protect-directory:${path}`);
        expect(await readdir(path)).toEqual([]);
      },
      assertPrivateDirectory: (path) => {
        events.push(`private-directory:${path}`);
        return Promise.resolve();
      },
      protectPrivateFile: async (path) => {
        events.push(`protect-file:${path}`);
        expect((await stat(path)).size).toBeGreaterThan(0);
      },
    });
    const database = createDatabase(join(root, 'source.sqlite3'));

    try {
      const result = await createBackup(database, destination, NOW, windows(authority));

      const destinationProtection = events.findIndex(
        (event) => event.startsWith('protect-directory:') && basename(event) === 'backups',
      );
      const stagingProtection = events.findIndex(
        (event) =>
          event.startsWith('protect-directory:') &&
          basename(event).startsWith('.forgeboard-backup-'),
      );
      expect(authority.assertSafeParent).toHaveBeenCalledWith(await realpath(root), SID);
      expect(destinationProtection).toBeGreaterThanOrEqual(0);
      expect(destinationProtection).toBeLessThan(stagingProtection);
      expect(events.findIndex((event) => event.startsWith('protect-file:'))).toBeGreaterThan(
        stagingProtection,
      );
      expect(await readdir(destination)).toEqual([basename(result.path)]);
      expect(readSecret(result.path)).toBe('private database bytes');
      expect(database.prepare('SELECT COUNT(*) AS count FROM backup_records').get()).toEqual({
        count: 1,
      });
    } finally {
      database.close();
    }
  }, 15_000);

  it('leaves no SQLite bytes when private staging protection fails', async () => {
    const root = await temporaryRoot();
    const destination = join(root, 'backups');
    await mkdir(destination, { mode: 0o700 });
    const authority = fakeWindowsSecurity({
      protectPrivateDirectory: async (path) => {
        expect(await readdir(path)).toEqual([]);
        throw new Error('staging ACL protection failed');
      },
    });
    const database = createDatabase(join(root, 'source.sqlite3'));

    try {
      await expect(createBackup(database, destination, NOW, windows(authority))).rejects.toThrow(
        'staging ACL protection failed',
      );
      expect(await readdir(destination)).toEqual([]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM backup_records').get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it('verifies the same protected hard link at publication and removes both paths on failure', async () => {
    const root = await temporaryRoot();
    const destination = join(root, 'backups');
    await mkdir(destination, { mode: 0o700 });
    const verifiedFiles: Array<{
      readonly path: string;
      readonly dev: number;
      readonly ino: number;
    }> = [];
    const authority = fakeWindowsSecurity({
      assertPrivateFile: async (path) => {
        const details = await stat(path);
        verifiedFiles.push({ path, dev: details.dev, ino: details.ino });
        if (basename(path).startsWith('forgeboard-')) {
          throw new Error('published ACL verification failed');
        }
      },
    });
    const database = createDatabase(join(root, 'source.sqlite3'));

    try {
      await expect(createBackup(database, destination, NOW, windows(authority))).rejects.toThrow(
        'published ACL verification failed',
      );
      expect(verifiedFiles).toHaveLength(2);
      const stagedFile = verifiedFiles[0];
      const publishedFile = verifiedFiles[1];
      expect(stagedFile?.path).toContain('backup.sqlite3');
      expect(publishedFile?.path).toContain('forgeboard-');
      expect(publishedFile?.dev).toBe(stagedFile?.dev);
      expect(publishedFile?.ino).toBe(stagedFile?.ino);
      expect(await readdir(destination)).toEqual([]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM backup_records').get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  }, 10_000);

  it('does not create a destination when the current Windows identity is unavailable', async () => {
    const root = await temporaryRoot();
    const destination = join(root, 'backups');
    const authority = fakeWindowsSecurity({
      currentUserSid: () => Promise.reject(new Error('Windows identity unavailable')),
    });
    const database = createDatabase(join(root, 'source.sqlite3'));

    try {
      await expect(createBackup(database, destination, NOW, windows(authority))).rejects.toThrow(
        'Windows identity unavailable',
      );
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(database.prepare('SELECT COUNT(*) AS count FROM backup_records').get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it('deletes local data without resolving Windows ACL services when no backup file is reachable', async () => {
    const root = await temporaryRoot();
    const authority = fakeWindowsSecurity({
      currentUserSid: () => Promise.reject(new Error('PowerShell unavailable')),
    });
    const database = createDatabase(join(root, 'source.sqlite3'));
    database
      .prepare(
        `INSERT INTO app_settings(singleton, value_json, updated_at)
         VALUES(1, '{}', ?)`,
      )
      .run(NOW.toISOString());

    try {
      await expect(deleteAllLocalData(database, {}, windows(authority))).resolves.toBeUndefined();
      expect(authority.currentUserSid).not.toHaveBeenCalled();
      expect(database.prepare('SELECT COUNT(*) AS count FROM app_settings').get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it('does not rewrite ACLs on a recorded file before its ledger identity is verified', async () => {
    const root = await temporaryRoot();
    const destination = await realpath(root);
    const backupId = '10000000-0000-4000-8000-000000000001';
    const backupPath = join(destination, `forgeboard-manual-${backupId}.sqlite3`);
    await writeFile(backupPath, 'user file that is not the recorded backup');
    const authority = fakeWindowsSecurity();
    const database = createDatabase(join(root, 'source.sqlite3'));
    database
      .prepare(
        `INSERT INTO backup_records(id, canonical_path, created_at, sha256, size_bytes)
         VALUES(?, ?, ?, ?, ?)`,
      )
      .run(backupId, backupPath, NOW.toISOString(), '0'.repeat(64), 1);

    try {
      await expect(deleteAllLocalData(database, {}, windows(authority))).rejects.toThrow(
        'changed after Artemis created it',
      );
      expect(authority.protectPrivateFile).not.toHaveBeenCalled();
      expect(await readFile(backupPath, 'utf8')).toBe('user file that is not the recorded backup');
      expect(database.prepare('SELECT COUNT(*) AS count FROM backup_records').get()).toEqual({
        count: 1,
      });
    } finally {
      database.close();
    }
  });
});

interface WindowsSecurityOverrides {
  readonly currentUserSid?: () => Promise<string>;
  readonly assertSafeParent?: (path: string, sid: string) => Promise<void>;
  readonly assertConfidentialParent?: (path: string, sid: string) => Promise<void>;
  readonly protectPrivateDirectory?: (path: string, sid: string) => Promise<void>;
  readonly assertPrivateDirectory?: (path: string, sid: string) => Promise<void>;
  readonly protectPrivateFile?: (path: string, sid: string) => Promise<void>;
  readonly assertPrivateFile?: (path: string, sid: string) => Promise<void>;
}

interface FakeWindowsSecurity {
  readonly currentUserSid: Mock<WindowsFilesystemSecurity['currentUserSid']>;
  readonly assertSafeParent: Mock<WindowsFilesystemSecurity['assertSafeParent']>;
  readonly assertConfidentialParent: Mock<WindowsFilesystemSecurity['assertConfidentialParent']>;
  readonly protectPrivateDirectory: Mock<WindowsFilesystemSecurity['protectPrivateDirectory']>;
  readonly assertPrivateDirectory: Mock<WindowsFilesystemSecurity['assertPrivateDirectory']>;
  readonly protectPrivateFile: Mock<WindowsFilesystemSecurity['protectPrivateFile']>;
  readonly assertPrivateFile: Mock<WindowsFilesystemSecurity['assertPrivateFile']>;
}

function fakeWindowsSecurity(overrides: WindowsSecurityOverrides = {}): FakeWindowsSecurity {
  return {
    currentUserSid: vi.fn(overrides.currentUserSid ?? (() => Promise.resolve(SID))),
    assertSafeParent: vi.fn(overrides.assertSafeParent ?? (() => Promise.resolve())),
    assertConfidentialParent: vi.fn(
      overrides.assertConfidentialParent ?? (() => Promise.resolve()),
    ),
    protectPrivateDirectory: vi.fn(overrides.protectPrivateDirectory ?? (() => Promise.resolve())),
    assertPrivateDirectory: vi.fn(overrides.assertPrivateDirectory ?? (() => Promise.resolve())),
    protectPrivateFile: vi.fn(overrides.protectPrivateFile ?? (() => Promise.resolve())),
    assertPrivateFile: vi.fn(overrides.assertPrivateFile ?? (() => Promise.resolve())),
  };
}

function windows(windowsSecurity: WindowsFilesystemSecurity) {
  return { platform: 'win32' as const, windowsSecurity };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-windows-backup-'));
  temporaryRoots.push(root);
  return root;
}

function createDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  migrate(database);
  initializeAuditIntegrity(database);
  database.exec(`
    CREATE TABLE secrets(value TEXT NOT NULL);
    INSERT INTO secrets(value) VALUES('private database bytes');
  `);
  return database;
}

function readSecret(path: string): string {
  const backup = new DatabaseSync(path, { readOnly: true });
  try {
    return (backup.prepare('SELECT value FROM secrets').get() as { value: string }).value;
  } finally {
    backup.close();
  }
}
