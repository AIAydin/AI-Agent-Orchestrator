import { createHash } from 'node:crypto';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WindowsFilesystemSecurity } from '../../security/windows/filesystem-acl.js';
import { migrate } from '../../storage/database.js';
import { initializeAuditIntegrity } from '../../storage/security/audit-integrity.js';
import { stageValidatedSelectedBackup } from './selected-backup.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('stageValidatedSelectedBackup', () => {
  it('copies and fully validates a current Artemis backup without touching its source', async () => {
    const fixture = await createFixture();
    const sourceBefore = await readFile(fixture.source);

    const result = await stageValidatedSelectedBackup(fixture.source, fixture.staging);

    expect(await readFile(fixture.source)).toEqual(sourceBefore);
    expect(await readFile(result.stagedPath)).toEqual(sourceBefore);
    expect(result.sizeBytes).toBe(sourceBefore.byteLength);
    expect(result.sha256).toBe(createHash('sha256').update(sourceBefore).digest('hex'));
    expect(result.sourceSha256).toBe(result.sha256);
    expect((await lstat(result.stagedPath)).mode & 0o077).toBe(0);
  });

  it('rejects relative paths, final-component symlinks, and non-regular files', async () => {
    const fixture = await createFixture();
    const link = join(fixture.root, 'backup-link.sqlite3');
    await symlink(fixture.source, link);

    await expect(stageValidatedSelectedBackup('backup.sqlite3', fixture.staging)).rejects.toThrow(
      'rejected the selected backup path',
    );
    await expect(stageValidatedSelectedBackup(link, fixture.staging)).rejects.toThrow(
      'ordinary file, not a link',
    );
    await expect(stageValidatedSelectedBackup(fixture.root, fixture.staging)).rejects.toThrow(
      'ordinary file, not a link',
    );
  });

  it('rejects empty and oversized selections before validation', async () => {
    const fixture = await createFixture();
    const empty = join(fixture.root, 'empty.sqlite3');
    await writeFile(empty, '');

    await expect(stageValidatedSelectedBackup(empty, fixture.staging)).rejects.toThrow('empty');
    await expect(
      stageValidatedSelectedBackup(fixture.source, fixture.staging, { maxBytes: 16 }),
    ).rejects.toThrow('exceeds the recovery safety limit');
  });

  it('rejects a selected path whose inode changes while its open file is being copied', async () => {
    const fixture = await createFixture();
    await appendFile(fixture.source, Buffer.alloc(32 * 1024 * 1024, 0x5a));
    const original = `${fixture.source}.original`;

    const staging = stageValidatedSelectedBackup(fixture.source, fixture.staging, {
      validateStaged: vi.fn(),
    });
    while ((await readdir(fixture.staging)).length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await rename(fixture.source, original);
    await writeFile(fixture.source, 'replacement');

    await expect(staging).rejects.toThrow('changed while Artemis was copying it');
    expect(await directoryEntries(fixture.staging)).toEqual([]);
    expect((await lstat(original)).isFile()).toBe(true);
  });

  it('removes the private copy when full backup validation fails', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.source, 'not a sqlite database');

    await expect(stageValidatedSelectedBackup(fixture.source, fixture.staging)).rejects.toThrow(
      'could not validate the selected backup safely',
    );
    expect(await directoryEntries(fixture.staging)).toEqual([]);
  });

  it('supports a migration-aware private-copy validator without exposing or mutating the source', async () => {
    const fixture = await createFixture();
    const sourceBefore = await readFile(fixture.source);
    const validateStaged = vi.fn((stagedPath: string) => {
      const database = new DatabaseSync(stagedPath);
      try {
        database.exec('CREATE TABLE private_migration_proof(value TEXT NOT NULL)');
      } finally {
        database.close();
      }
    });

    const result = await stageValidatedSelectedBackup(fixture.source, fixture.staging, {
      validateStaged,
    });

    expect(validateStaged).toHaveBeenCalledWith(result.stagedPath);
    expect(await readFile(fixture.source)).toEqual(sourceBefore);
    const stagedDatabase = new DatabaseSync(result.stagedPath, { readOnly: true });
    try {
      expect(
        stagedDatabase
          .prepare("SELECT name FROM sqlite_master WHERE name = 'private_migration_proof'")
          .get(),
      ).toEqual({ name: 'private_migration_proof' });
    } finally {
      stagedDatabase.close();
    }
  });

  it('rejects public or aliased staging directories', async () => {
    const fixture = await createFixture();
    const publicStaging = join(fixture.root, 'public-staging');
    await mkdir(publicStaging, { mode: 0o755 });
    await chmod(publicStaging, 0o755);
    const stagingAlias = join(fixture.root, 'staging-alias');
    await symlink(fixture.staging, stagingAlias);

    await expect(stageValidatedSelectedBackup(fixture.source, publicStaging)).rejects.toThrow(
      'not private',
    );
    await expect(stageValidatedSelectedBackup(fixture.source, stagingAlias)).rejects.toThrow(
      'ordinary private directory',
    );
  });

  it('bounds errors without leaking either absolute path', async () => {
    const fixture = await createFixture();
    const secretSource = join(fixture.root, 'customer-secret-backup.sqlite3');
    await writeFile(secretSource, 'invalid');

    let failure: Error | undefined;
    try {
      await stageValidatedSelectedBackup(secretSource, fixture.staging);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe('Artemis could not validate the selected backup safely.');
    expect(failure?.message).not.toContain(fixture.root);
    expect(failure?.message.length).toBeLessThan(256);
  });

  it('removes a staged copy when the validator changes it', async () => {
    const fixture = await createFixture();
    const validateStaged = async (stagedPath: string): Promise<void> => {
      await writeFile(stagedPath, 'changed by validator');
    };

    const result = await stageValidatedSelectedBackup(fixture.source, fixture.staging, {
      validateStaged,
    });
    expect(await readFile(result.stagedPath, 'utf8')).toBe('changed by validator');
    expect(result.sha256).toBe(createHash('sha256').update('changed by validator').digest('hex'));
    expect(result.sourceSha256).not.toBe(result.sha256);
  });

  it('protects and rechecks Windows staging and the created file through the ACL authority', async () => {
    const fixture = await createFixture();
    const windows = fakeWindowsSecurity();

    const result = await stageValidatedSelectedBackup(fixture.source, fixture.staging, {
      platform: 'win32',
      validateStaged: vi.fn(),
      windowsSecurity: windows.authority,
    });

    expect(windows.currentUserSid).toHaveBeenCalledOnce();
    expect(windows.assertPrivateDirectory).toHaveBeenCalledWith(fixture.staging, 'S-1-5-21-1');
    expect(windows.protectPrivateFile).toHaveBeenCalledWith(result.stagedPath, 'S-1-5-21-1');
    expect(windows.assertPrivateFile).toHaveBeenCalledWith(result.stagedPath, 'S-1-5-21-1');
  });
});

async function createFixture(): Promise<{ root: string; source: string; staging: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeboard-selected-backup-')));
  roots.push(root);
  const source = join(root, 'selected.sqlite3');
  const staging = join(root, 'private-staging');
  await mkdir(staging, { mode: 0o700 });
  await chmod(staging, 0o700);
  const database = new DatabaseSync(source);
  try {
    migrate(database);
    initializeAuditIntegrity(database);
  } finally {
    database.close();
  }
  return { root, source, staging };
}

async function directoryEntries(directory: string): Promise<string[]> {
  return await readdir(directory);
}

function fakeWindowsSecurity(): {
  authority: WindowsFilesystemSecurity;
  currentUserSid: ReturnType<typeof vi.fn>;
  assertPrivateDirectory: ReturnType<typeof vi.fn>;
  protectPrivateFile: ReturnType<typeof vi.fn>;
  assertPrivateFile: ReturnType<typeof vi.fn>;
} {
  const currentUserSid = vi.fn(() => Promise.resolve('S-1-5-21-1'));
  const assertPrivateDirectory = vi.fn(() => Promise.resolve());
  const protectPrivateFile = vi.fn(() => Promise.resolve());
  const assertPrivateFile = vi.fn(() => Promise.resolve());
  const authority: WindowsFilesystemSecurity = {
    currentUserSid,
    assertSafeParent: vi.fn(() => Promise.resolve()),
    assertConfidentialParent: vi.fn(() => Promise.resolve()),
    protectPrivateDirectory: vi.fn(() => Promise.resolve()),
    assertPrivateDirectory,
    protectPrivateFile,
    assertPrivateFile,
  };
  return {
    authority,
    currentUserSid,
    assertPrivateDirectory,
    protectPrivateFile,
    assertPrivateFile,
  };
}
