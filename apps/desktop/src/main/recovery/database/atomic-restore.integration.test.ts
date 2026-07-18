import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { restoreDatabaseAtomically, type AtomicRestoreFilesystem } from './atomic-restore.js';
import { reconcileInterruptedDatabaseRestores } from './interrupted-restore.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe('atomic database restore', () => {
  it('installs a verified candidate when the journaled prior database state is absent', async () => {
    const fixture = await createFixture();
    await Promise.all([
      rm(fixture.database),
      rm(`${fixture.database}-wal`),
      rm(`${fixture.database}-shm`),
    ]);

    const result = await restoreDatabaseAtomically({
      stagedBackup: await verifiedBackup(fixture.source),
      databasePath: fixture.database,
      operationId: 'absent-prior-success',
      validateStagedDatabase: () => undefined,
    });

    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('backup database');
    await expect(
      access(join(result.quarantineDirectory, `previous-${basename(fixture.database)}`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const journal = await readFile(join(result.quarantineDirectory, 'operation.jsonl'), 'utf8');
    expect(journal).toContain('"priorState":"absent"');
  });

  it('rolls an absent prior state back to absence when installed validation fails', async () => {
    const fixture = await createFixture();
    await Promise.all([
      rm(fixture.database),
      rm(`${fixture.database}-wal`),
      rm(`${fixture.database}-shm`),
    ]);

    await expect(
      restoreDatabaseAtomically({
        stagedBackup: await verifiedBackup(fixture.source),
        databasePath: fixture.database,
        operationId: 'absent-prior-rollback',
        validateStagedDatabase: () => undefined,
        validateInstalledDatabase: () => {
          throw new Error('injected installed validation failure');
        },
      }),
    ).rejects.toThrow('injected installed validation failure');

    await expect(access(fixture.database)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(`${fixture.database}-wal`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(`${fixture.database}-shm`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('performs no rollback rename when rolling-back publication fails and later reconciles', async () => {
    const fixture = await createFixture();
    let rollbackStarted = false;
    let rollbackRenameCount = 0;
    const filesystem: Partial<AtomicRestoreFilesystem> = {
      appendJournal: async (path, event) => {
        if (event.phase === 'rolling-back') {
          throw new Error('injected rolling-back journal failure');
        }
        await writeFile(path, `${JSON.stringify(event)}\n`, { flag: 'a', mode: 0o600 });
      },
      rename: async (source, destination) => {
        if (rollbackStarted) rollbackRenameCount += 1;
        await rename(source, destination);
      },
    };

    await expect(
      restoreDatabaseAtomically({
        stagedBackup: await verifiedBackup(fixture.source),
        databasePath: fixture.database,
        operationId: 'rollback-journal-barrier',
        validateStagedDatabase: () => undefined,
        validateInstalledDatabase: () => {
          rollbackStarted = true;
          throw new Error('injected installed validation failure');
        },
        filesystem,
      }),
    ).rejects.toMatchObject({ name: 'AggregateError' });

    expect(rollbackRenameCount).toBe(0);
    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('backup database');
    await reconcileInterruptedDatabaseRestores({ databasePath: fixture.database });
    await expectExactPriorFiles(fixture);
  });

  it('migrates only a private copy, atomically installs it, and quarantines exact prior files', async () => {
    const fixture = await createFixture();
    const sourceBefore = await readFile(fixture.source);
    const validateStagedPaths: string[] = [];

    const result = await restoreDatabaseAtomically({
      stagedBackup: await verifiedBackup(fixture.source),
      databasePath: fixture.database,
      operationId: 'successful-restore',
      validateStagedDatabase: async (path) => {
        validateStagedPaths.push(path);
        expect(path).not.toBe(fixture.source);
        await writeFile(path, 'migrated backup');
      },
      validateInstalledDatabase: async (path) => {
        expect(path).toBe(fixture.database);
        await expect(readFile(path, 'utf8')).resolves.toBe('migrated backup');
      },
    });

    expect(validateStagedPaths).toHaveLength(1);
    await expect(readFile(fixture.source)).resolves.toEqual(sourceBefore);
    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('migrated backup');
    await expect(
      readFile(join(result.quarantineDirectory, `previous-${basename(fixture.database)}`), 'utf8'),
    ).resolves.toBe('old database');
    await expect(
      readFile(
        join(result.quarantineDirectory, `previous-${basename(fixture.database)}-wal`),
        'utf8',
      ),
    ).resolves.toBe('old wal');
    await expect(
      readFile(
        join(result.quarantineDirectory, `previous-${basename(fixture.database)}-shm`),
        'utf8',
      ),
    ).resolves.toBe('old shm');

    const journal = await readFile(join(result.quarantineDirectory, 'operation.jsonl'), 'utf8');
    expect(journal).not.toContain(fixture.root);
    expect(journal).toContain(createHash('sha256').update(sourceBefore).digest('hex'));
    expect(journal).toContain(createHash('sha256').update('old database').digest('hex'));
    expect(
      journal
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line) as unknown),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'prepared' }),
        expect.objectContaining({ phase: 'completed' }),
      ]),
    );
  });

  it('rejects a staged copy whose exact verified identity is stale before primary mutation', async () => {
    const fixture = await createFixture();
    const stagedBackup = await verifiedBackup(fixture.source);
    await writeFile(fixture.source, 'changed after selection');

    await expect(
      restoreDatabaseAtomically({
        stagedBackup,
        databasePath: fixture.database,
        operationId: 'stale-selection',
        validateStagedDatabase: () => undefined,
      }),
    ).rejects.toThrow('no longer matches its verified identity');

    await expectExactPriorFiles(fixture);
    await expect(
      access(join(fixture.root, '.forgeboard-database-restore-stale-selection')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back exact prior files when the candidate-to-primary rename fails', async () => {
    const fixture = await createFixture();
    const injected = injectedFilesystem({
      rename: async (source, destination) => {
        if (
          basename(String(source)) === 'candidate.sqlite' &&
          String(destination) === fixture.database
        ) {
          throw new Error('injected install rename failure');
        }
        await rename(source, destination);
      },
    });

    await expect(
      restoreDatabaseAtomically({
        stagedBackup: await verifiedBackup(fixture.source),
        databasePath: fixture.database,
        operationId: 'failed-install',
        validateStagedDatabase: () => undefined,
        filesystem: injected,
      }),
    ).rejects.toThrow('injected install rename failure');

    await expectExactPriorFiles(fixture);
    await expect(readFile(fixture.source, 'utf8')).resolves.toBe('backup database');
    await expect(
      access(join(fixture.root, '.forgeboard-database-restore-failed-install')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores sidecars already moved when quarantine fails before the primary moves', async () => {
    const fixture = await createFixture();
    const injected = injectedFilesystem({
      rename: async (source, destination) => {
        if (source === fixture.database) throw new Error('injected primary quarantine failure');
        await rename(source, destination);
      },
    });

    await expect(
      restoreDatabaseAtomically({
        stagedBackup: await verifiedBackup(fixture.source),
        databasePath: fixture.database,
        operationId: 'partial-quarantine',
        validateStagedDatabase: () => undefined,
        filesystem: injected,
      }),
    ).rejects.toThrow('injected primary quarantine failure');

    await expectExactPriorFiles(fixture);
  });

  it('preserves a failed installed candidate and restores the exact prior database', async () => {
    const fixture = await createFixture();
    const restoreDirectory = join(
      fixture.root,
      '.forgeboard-database-restore-installed-validation-failure',
    );

    await expect(
      restoreDatabaseAtomically({
        stagedBackup: await verifiedBackup(fixture.source),
        databasePath: fixture.database,
        operationId: 'installed-validation-failure',
        validateStagedDatabase: () => undefined,
        validateInstalledDatabase: async (path) => {
          await writeFile(path, 'failed installed candidate');
          await writeFile(`${path}-wal`, 'candidate wal');
          throw new Error('injected installed validation failure');
        },
      }),
    ).rejects.toThrow('injected installed validation failure');

    await expectExactPriorFiles(fixture);
    await expect(access(restoreDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires and invokes a Windows DACL authority instead of treating chmod as privacy', async () => {
    const fixture = await createFixture();

    await expect(
      restoreDatabaseAtomically({
        stagedBackup: await verifiedBackup(fixture.source),
        databasePath: fixture.database,
        operationId: 'windows-without-authority',
        platform: 'win32',
        validateStagedDatabase: () => undefined,
      }),
    ).rejects.toThrow('requires a private filesystem authority');
    await expect(
      access(join(fixture.root, '.forgeboard-database-restore-windows-without-authority')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const protectedDirectories: string[] = [];
    const protectedFiles: string[] = [];
    const windowsPrivacy = {
      protectPrivateDirectory: async (path: string) => {
        protectedDirectories.push(path);
        await chmod(path, 0o700);
      },
      protectPrivateFile: async (path: string) => {
        protectedFiles.push(path);
        await chmod(path, 0o600);
      },
    };
    await expect(
      restoreDatabaseAtomically({
        stagedBackup: await verifiedBackup(fixture.source),
        databasePath: fixture.database,
        operationId: 'windows-without-durability',
        platform: 'win32',
        windowsPrivacy,
        validateStagedDatabase: () => undefined,
      }),
    ).rejects.toThrow('requires a durable filesystem authority');

    await restoreDatabaseAtomically({
      stagedBackup: await verifiedBackup(fixture.source),
      databasePath: fixture.database,
      operationId: 'windows-with-authority',
      platform: 'win32',
      windowsPrivacy,
      windowsDurability: {
        createDirectoryWriteThrough: async (path) => await mkdir(path, { mode: 0o700 }),
        renameWriteThrough: async (source, destination) => await rename(source, destination),
        syncFile: () => Promise.resolve(),
      },
      validateStagedDatabase: () => undefined,
    });

    expect(protectedDirectories).toEqual(
      expect.arrayContaining([
        fixture.root,
        expect.stringContaining('.forgeboard-database-restore-windows-with-authority'),
      ]),
    );
    expect(protectedFiles).toEqual(
      expect.arrayContaining([
        expect.stringContaining('candidate.sqlite'),
        expect.stringContaining(`previous-${basename(fixture.database)}`),
      ]),
    );
  });

  it('fails before primary mutation when a directory durability barrier is unavailable', async () => {
    const fixture = await createFixture();

    await expect(
      restoreDatabaseAtomically({
        stagedBackup: await verifiedBackup(fixture.source),
        databasePath: fixture.database,
        operationId: 'missing-directory-barrier',
        validateStagedDatabase: () => undefined,
        filesystem: {
          syncDirectory: () => Promise.reject(new Error('directory sync unsupported')),
        },
      }),
    ).rejects.toThrow('directory sync unsupported');

    await expectExactPriorFiles(fixture);
  });

  it('publishes the initial Windows journal write-through before any primary move', async () => {
    const fixture = await createFixture();
    const durableMoves: Array<{ source: string; destination: string }> = [];

    await expect(
      restoreDatabaseAtomically({
        stagedBackup: await verifiedBackup(fixture.source),
        databasePath: fixture.database,
        operationId: 'windows-journal-publication-failure',
        platform: 'win32',
        windowsPrivacy: {
          protectPrivateDirectory: async (path) => await chmod(path, 0o700),
          protectPrivateFile: async (path) => await chmod(path, 0o600),
        },
        windowsDurability: {
          createDirectoryWriteThrough: async (path) => await mkdir(path, { mode: 0o700 }),
          renameWriteThrough: async (source, destination) => {
            durableMoves.push({ source, destination });
            if (destination.endsWith('operation.jsonl')) {
              throw new Error('injected journal publication failure');
            }
            await rename(source, destination);
          },
          syncFile: () => Promise.resolve(),
        },
        validateStagedDatabase: () => undefined,
      }),
    ).rejects.toThrow('injected journal publication failure');

    expect(durableMoves).toHaveLength(1);
    expect(durableMoves[0]?.source).toContain('operation.jsonl.prepared');
    expect(durableMoves[0]?.destination).toContain('operation.jsonl');
    await expectExactPriorFiles(fixture);
  });

  it('reports rollback failures and leaves quarantine evidence instead of claiming recovery', async () => {
    const fixture = await createFixture();
    let installFailed = false;
    const injected = injectedFilesystem({
      rename: async (source, destination) => {
        if (
          basename(String(source)) === 'candidate.sqlite' &&
          String(destination) === fixture.database
        ) {
          installFailed = true;
          throw new Error('install failed');
        }
        if (installFailed && String(destination) === fixture.database) {
          throw new Error('rollback failed');
        }
        await rename(source, destination);
      },
    });

    await expect(
      restoreDatabaseAtomically({
        stagedBackup: await verifiedBackup(fixture.source),
        databasePath: fixture.database,
        operationId: 'failed-rollback',
        validateStagedDatabase: () => undefined,
        filesystem: injected,
      }),
    ).rejects.toMatchObject({ name: 'AggregateError' });

    await expect(
      access(
        join(
          fixture.root,
          '.forgeboard-database-restore-failed-rollback',
          `previous-${basename(fixture.database)}`,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses substituted prior bytes both before and after an in-process rollback rename', async () => {
    for (const substitutionPoint of ['quarantine', 'restored'] as const) {
      const fixture = await createFixture();
      const restoreDirectory = join(
        fixture.root,
        `.forgeboard-database-restore-substituted-${substitutionPoint}`,
      );
      const priorDatabase = join(restoreDirectory, `previous-${basename(fixture.database)}`);
      const injected = injectedFilesystem({
        rename: async (source, destination) => {
          if (
            basename(String(source)) === 'candidate.sqlite' &&
            String(destination) === fixture.database
          ) {
            if (substitutionPoint === 'quarantine') {
              await writeFile(priorDatabase, 'substituted prior bytes', { mode: 0o600 });
            }
            throw new Error('injected install failure');
          }
          await rename(source, destination);
          if (
            substitutionPoint === 'restored' &&
            String(source) === priorDatabase &&
            String(destination) === fixture.database
          ) {
            await writeFile(fixture.database, 'substituted restored bytes', { mode: 0o600 });
          }
        },
      });

      await expect(
        restoreDatabaseAtomically({
          stagedBackup: await verifiedBackup(fixture.source),
          databasePath: fixture.database,
          operationId: `substituted-${substitutionPoint}`,
          validateStagedDatabase: () => undefined,
          filesystem: injected,
        }),
      ).rejects.toMatchObject({ name: 'AggregateError' });

      await expect(access(restoreDirectory)).resolves.toBeUndefined();
      const journal = await readFile(join(restoreDirectory, 'operation.jsonl'), 'utf8');
      expect(journal).not.toContain('"phase":"rolled-back"');
    }
  });
});

interface Fixture {
  readonly root: string;
  readonly source: string;
  readonly database: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-atomic-restore-'));
  roots.push(root);
  const source = join(root, 'selected-backup.sqlite3');
  const database = join(root, 'forgeboard.sqlite');
  await Promise.all([
    writeFile(source, 'backup database', { mode: 0o600 }),
    writeFile(database, 'old database', { mode: 0o600 }),
    writeFile(`${database}-wal`, 'old wal', { mode: 0o600 }),
    writeFile(`${database}-shm`, 'old shm', { mode: 0o600 }),
  ]);
  return { root, source, database };
}

async function expectExactPriorFiles(fixture: Fixture): Promise<void> {
  await expect(readFile(fixture.database, 'utf8')).resolves.toBe('old database');
  await expect(readFile(`${fixture.database}-wal`, 'utf8')).resolves.toBe('old wal');
  await expect(readFile(`${fixture.database}-shm`, 'utf8')).resolves.toBe('old shm');
}

function injectedFilesystem(
  overrides: Pick<Partial<AtomicRestoreFilesystem>, 'rename'>,
): Partial<AtomicRestoreFilesystem> {
  return overrides;
}

async function verifiedBackup(path: string) {
  const bytes = await readFile(path);
  return {
    stagedPath: path,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
  };
}
