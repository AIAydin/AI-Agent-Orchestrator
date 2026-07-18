import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  reconcileInterruptedDatabaseRestores,
  type InterruptedRestorePrivacyAuthority,
} from './interrupted-restore.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe('interrupted database restore reconciliation', () => {
  it('durably discards a private POSIX restore directory left before journal publication', async () => {
    const fixture = await unpublishedFixture('posix-unpublished');
    await writeFile(join(fixture.restore, 'candidate.sqlite'), 'validated candidate', {
      mode: 0o600,
    });

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: fixture.database }),
    ).resolves.toEqual({ reconciledOperationIds: [] });
    await expect(access(fixture.restore)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(fixture.database)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('write-through discards a Windows restore directory interrupted before journal publication', async () => {
    const fixture = await unpublishedFixture('windows-unpublished');
    await writeFile(join(fixture.restore, 'candidate.sqlite'), 'validated candidate', {
      mode: 0o600,
    });
    await writeFile(join(fixture.restore, 'operation.jsonl.prepared'), '{"torn":', {
      mode: 0o600,
    });
    const durableRenames: Array<{ source: string; destination: string }> = [];

    await reconcileInterruptedDatabaseRestores({
      databasePath: fixture.database,
      platform: 'win32',
      privacyAuthority: {
        assertPrivateDirectory: () => Promise.resolve(),
        assertPrivateFile: () => Promise.resolve(),
      },
      windowsDurability: {
        renameWriteThrough: async (source, destination) => {
          durableRenames.push({ source, destination });
          await rename(source, destination);
        },
        syncFile: () => Promise.resolve(),
      },
    });

    expect(durableRenames).toHaveLength(1);
    expect(durableRenames[0]?.source).toBe(fixture.restore);
    expect(basename(durableRenames[0]?.destination ?? '')).toBe(
      '.forgeboard-database-discard-windows-unpublished',
    );
    await expect(access(fixture.restore)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects ambiguous no-journal restore evidence without deleting it', async () => {
    const fixture = await unpublishedFixture('ambiguous-unpublished');
    await writeFile(join(fixture.restore, 'previous-db.sqlite'), 'prior bytes', {
      mode: 0o600,
    });

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: fixture.database }),
    ).rejects.toThrow('cannot safely reconcile');
    await expect(readFile(join(fixture.restore, 'previous-db.sqlite'), 'utf8')).resolves.toBe(
      'prior bytes',
    );
  });

  it('durably enters rolling-back before mutation and resumes after a second crash', async () => {
    const fixture = await fixtureFor('installed', ['db.sqlite', 'db.sqlite-wal']);
    await writeFile(fixture.database, 'installed candidate', { mode: 0o600 });
    let crashed = false;

    await expect(
      reconcileInterruptedDatabaseRestores({
        databasePath: fixture.database,
        filesystem: {
          rename: async (source, destination) => {
            await rename(source, destination);
            if (!crashed && String(source).endsWith('previous-db.sqlite')) {
              crashed = true;
              throw new Error('simulated power loss after primary rollback rename');
            }
          },
        },
      }),
    ).rejects.toThrow('cannot safely reconcile');
    expect(await journalPhases(fixture.restore)).toContain('rolling-back');

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: fixture.database }),
    ).resolves.toEqual({ reconciledOperationIds: [fixture.operationId] });
    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('prior-db.sqlite');
    await expect(readFile(`${fixture.database}-wal`, 'utf8')).resolves.toBe('prior-db.sqlite-wal');
  });

  it.each(['prepared', 'quarantined', 'installed', 'completed'] as const)(
    'reconciles a journaled absent prior database from %s without creating an empty database',
    async (phase) => {
      const fixture = await fixtureFor(phase, [], `absent-${phase}`, undefined, 'absent');
      if (phase === 'installed') {
        await writeFile(fixture.database, 'installed candidate', { mode: 0o600 });
      }

      await reconcileInterruptedDatabaseRestores({ databasePath: fixture.database });

      if (phase === 'completed') {
        await expect(readFile(fixture.database, 'utf8')).resolves.toBe('installed candidate');
      } else {
        await expect(access(fixture.database)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(access(fixture.restore)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['quarantining', 'quarantined'] as const)(
    'restores an exact prior database and sidecars from %s',
    async (phase) => {
      const fixture = await fixtureFor(phase, ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm']);
      await writeFile(join(fixture.restore, 'candidate.sqlite'), 'candidate', {
        mode: 0o600,
      });

      const result = await reconcileInterruptedDatabaseRestores({
        databasePath: fixture.database,
      });

      expect(result.reconciledOperationIds).toEqual([fixture.operationId]);
      await expect(readFile(fixture.database, 'utf8')).resolves.toBe('prior-db.sqlite');
      await expect(readFile(`${fixture.database}-wal`, 'utf8')).resolves.toBe(
        'prior-db.sqlite-wal',
      );
      await expect(readFile(`${fixture.database}-shm`, 'utf8')).resolves.toBe(
        'prior-db.sqlite-shm',
      );
      await expect(access(fixture.restore)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('preserves an installed candidate and resumes a partially completed rollback', async () => {
    const fixture = await fixtureFor('rolling-back', ['db.sqlite', 'db.sqlite-wal']);
    await writeFile(fixture.database, 'prior-db.sqlite', { mode: 0o600 });
    await writeFile(`${fixture.database}-wal`, 'failed candidate wal', {
      mode: 0o600,
    });
    await writeFile(join(fixture.restore, 'failed-db.sqlite'), 'failed candidate', { mode: 0o600 });
    await rm(join(fixture.restore, 'previous-db.sqlite'));

    await reconcileInterruptedDatabaseRestores({
      databasePath: fixture.database,
    });

    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('prior-db.sqlite');
    await expect(readFile(`${fixture.database}-wal`, 'utf8')).resolves.toBe('prior-db.sqlite-wal');
    await expect(access(fixture.restore)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a newly installed database before restoring every prior file', async () => {
    const fixture = await fixtureFor('installed', ['db.sqlite', 'db.sqlite-shm']);
    await writeFile(fixture.database, 'installed candidate', { mode: 0o600 });
    await writeFile(`${fixture.database}-wal`, 'candidate wal', {
      mode: 0o600,
    });

    await reconcileInterruptedDatabaseRestores({
      databasePath: fixture.database,
    });

    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('prior-db.sqlite');
    await expect(readFile(`${fixture.database}-shm`, 'utf8')).resolves.toBe('prior-db.sqlite-shm');
    await expect(access(fixture.restore)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a candidate installed before its durable installed event', async () => {
    const fixture = await fixtureFor('quarantined', ['db.sqlite']);
    await writeFile(fixture.database, 'candidate before journal event', {
      mode: 0o600,
    });

    await reconcileInterruptedDatabaseRestores({
      databasePath: fixture.database,
    });

    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('prior-db.sqlite');
    await expect(access(fixture.restore)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when an installed operation has lost prior quarantine evidence', async () => {
    const fixture = await fixtureFor('installed', ['db.sqlite']);
    await rm(join(fixture.restore, 'previous-db.sqlite'));
    await writeFile(fixture.database, 'installed candidate', { mode: 0o600 });

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: fixture.database }),
    ).rejects.toThrow('cannot safely reconcile');
    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('installed candidate');
  });

  it.each(['completed', 'rolled-back', 'prepared'] as const)(
    'validates and removes terminal or pre-mutation %s evidence',
    async (phase) => {
      const fixture = await fixtureFor(phase, ['db.sqlite']);

      await expect(
        reconcileInterruptedDatabaseRestores({
          databasePath: fixture.database,
        }),
      ).resolves.toEqual({ reconciledOperationIds: [] });
      await expect(access(fixture.restore)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('retains completed quarantine when the installed database no longer matches completion', async () => {
    const fixture = await fixtureFor('completed', ['db.sqlite']);
    await writeFile(fixture.database, 'substituted installed database', { mode: 0o600 });

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: fixture.database }),
    ).rejects.toThrow('cannot safely reconcile');
    await expect(readFile(fixture.database, 'utf8')).resolves.toBe(
      'substituted installed database',
    );
    await expect(readFile(join(fixture.restore, 'previous-db.sqlite'), 'utf8')).resolves.toBe(
      'prior-db.sqlite',
    );
  });

  it.each(['completed', 'rolled-back', 'prepared'] as const)(
    'fails closed when %s journal state is missing the authoritative primary',
    async (phase) => {
      const fixture = await fixtureFor(phase, ['db.sqlite']);
      await rm(fixture.database, { force: true });

      await expect(
        reconcileInterruptedDatabaseRestores({
          databasePath: fixture.database,
        }),
      ).rejects.toThrow('cannot safely reconcile');
      await expect(access(fixture.database)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('ignores one unterminated final journal fragment and reconciles from the last durable event', async () => {
    const fixture = await fixtureFor('quarantined', ['db.sqlite']);
    await writeFile(
      join(fixture.restore, 'operation.jsonl'),
      `${await readFile(join(fixture.restore, 'operation.jsonl'), 'utf8')}{"schemaVersion":1`,
      { mode: 0o600 },
    );

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: fixture.database }),
    ).resolves.toEqual({ reconciledOperationIds: [fixture.operationId] });
    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('prior-db.sqlite');
  });

  it('still rejects a malformed newline-terminated journal record', async () => {
    const fixture = await fixtureFor('quarantined', ['db.sqlite']);
    await writeFile(
      join(fixture.restore, 'operation.jsonl'),
      `${await readFile(join(fixture.restore, 'operation.jsonl'), 'utf8')}{bad}\n`,
      { mode: 0o600 },
    );

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: fixture.database }),
    ).rejects.toThrow('cannot safely reconcile');
  });

  it.each([
    ['path traversal', ['../db.sqlite']],
    ['absolute path', ['/private/db.sqlite']],
    ['unbound basename', ['other.sqlite']],
  ])('rejects %s journal entries without leaking the database path', async (_label, files) => {
    const fixture = await fixtureFor('quarantined', files);

    const failure = await reconcileInterruptedDatabaseRestores({
      databasePath: fixture.database,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(fixture.root);
    await expect(access(fixture.database)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed on missing evidence and never creates an empty database', async () => {
    const fixture = await fixtureFor('quarantined', ['db.sqlite']);
    await rm(join(fixture.restore, 'previous-db.sqlite'));

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: fixture.database }),
    ).rejects.toThrow('No database was opened or created');
    await expect(access(fixture.database)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await journalPhases(fixture.restore)).not.toContain('rolled-back');
  });

  it('fails closed when quarantined prior bytes do not match the journal identity', async () => {
    const fixture = await fixtureFor('quarantined', ['db.sqlite']);
    await writeFile(join(fixture.restore, 'previous-db.sqlite'), 'substituted bytes', {
      mode: 0o600,
    });

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: fixture.database }),
    ).rejects.toThrow('cannot safely reconcile');
    await expect(access(fixture.database)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(fixture.restore, 'previous-db.sqlite'), 'utf8')).resolves.toBe(
      'substituted bytes',
    );
  });

  it('fails closed when an already-restored original does not match the journal identity', async () => {
    const fixture = await fixtureFor('rolling-back', ['db.sqlite']);
    await rm(join(fixture.restore, 'previous-db.sqlite'));
    await writeFile(fixture.database, 'substituted restored bytes', { mode: 0o600 });

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: fixture.database }),
    ).rejects.toThrow('cannot safely reconcile');
    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('substituted restored bytes');
    await expect(access(fixture.restore)).resolves.toBeUndefined();
  });

  it('refuses to overwrite an unexpected file and retains both copies', async () => {
    const fixture = await fixtureFor('quarantining', ['db.sqlite']);
    await writeFile(fixture.database, 'unexpected', { mode: 0o600 });

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: fixture.database }),
    ).rejects.toThrow('cannot safely reconcile');
    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('unexpected');
    await expect(readFile(join(fixture.restore, 'previous-db.sqlite'), 'utf8')).resolves.toBe(
      'prior-db.sqlite',
    );
  });

  it('bounds sibling scanning before any restore mutation', async () => {
    const first = await fixtureFor('quarantined', ['db.sqlite'], 'one');
    await fixtureFor('quarantined', ['db.sqlite'], 'two', first.root);

    await expect(
      reconcileInterruptedDatabaseRestores({
        databasePath: first.database,
        scanLimit: 1,
      }),
    ).rejects.toThrow('cannot safely reconcile');
    await expect(access(first.database)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('cleans completed restore evidence before enforcing the active-operation limit', async () => {
    const first = await fixtureFor('quarantined', ['db.sqlite'], 'active');
    for (let index = 0; index < 33; index += 1) {
      await fixtureFor('completed', ['db.sqlite'], `complete-${index}`, first.root);
    }

    await expect(
      reconcileInterruptedDatabaseRestores({ databasePath: first.database }),
    ).resolves.toEqual({ reconciledOperationIds: ['active'] });
    await expect(readFile(first.database, 'utf8')).resolves.toBe('prior-db.sqlite');
  });

  it('requires and invokes an injected Windows ACL authority', async () => {
    const fixture = await fixtureFor('quarantined', ['db.sqlite']);
    await expect(
      reconcileInterruptedDatabaseRestores({
        databasePath: fixture.database,
        platform: 'win32',
      }),
    ).rejects.toThrow('cannot safely reconcile');

    const authority: InterruptedRestorePrivacyAuthority = {
      assertPrivateDirectory: vi.fn(() => Promise.resolve()),
      assertPrivateFile: vi.fn(() => Promise.resolve()),
    };
    await expect(
      reconcileInterruptedDatabaseRestores({
        databasePath: fixture.database,
        platform: 'win32',
        privacyAuthority: authority,
      }),
    ).rejects.toThrow('cannot safely reconcile');
    await reconcileInterruptedDatabaseRestores({
      databasePath: fixture.database,
      platform: 'win32',
      privacyAuthority: authority,
      windowsDurability: {
        renameWriteThrough: async (source, destination) => await rename(source, destination),
        syncFile: () => Promise.resolve(),
      },
    });

    expect(authority.assertPrivateDirectory).toHaveBeenCalledWith(fixture.restore);
    expect(authority.assertPrivateFile).toHaveBeenCalledWith(fixture.database);
  });

  it('flushes the rolling-back journal through the Windows authority before its first rename', async () => {
    const fixture = await fixtureFor('quarantined', ['db.sqlite']);
    const events: string[] = [];
    const authority: InterruptedRestorePrivacyAuthority = {
      assertPrivateDirectory: () => Promise.resolve(),
      assertPrivateFile: () => Promise.resolve(),
    };

    await reconcileInterruptedDatabaseRestores({
      databasePath: fixture.database,
      platform: 'win32',
      privacyAuthority: authority,
      windowsDurability: {
        renameWriteThrough: async (source, destination) => {
          events.push(`rename:${basename(String(source))}`);
          await rename(source, destination);
        },
        syncFile: (path) => {
          events.push(`sync:${basename(String(path))}`);
          return Promise.resolve();
        },
      },
    });

    expect(events.indexOf('sync:operation.jsonl')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('sync:operation.jsonl')).toBeLessThan(
      events.indexOf('rename:previous-db.sqlite'),
    );
  });

  it('fsyncs the terminal journal event only after successful restoration', async () => {
    const fixture = await fixtureFor('quarantined', ['db.sqlite']);
    const appendAndSync = vi.fn((path: string, text: string) => {
      void path;
      void text;
      return Promise.resolve();
    });

    await reconcileInterruptedDatabaseRestores({
      databasePath: fixture.database,
      filesystem: { appendAndSync },
    });

    expect(appendAndSync).toHaveBeenCalledTimes(2);
    expect(appendAndSync.mock.calls[0]?.[1]).toContain('"phase":"rolling-back"');
    expect(appendAndSync.mock.calls[1]?.[1]).toContain('"phase":"rolled-back"');
    await expect(readFile(fixture.database, 'utf8')).resolves.toBe('prior-db.sqlite');
  });
});

interface Fixture {
  readonly root: string;
  readonly database: string;
  readonly restore: string;
  readonly operationId: string;
}

async function unpublishedFixture(operationId: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-unpublished-restore-'));
  roots.push(root);
  const database = join(root, 'db.sqlite');
  const restore = join(root, `.forgeboard-database-restore-${operationId}`);
  await mkdir(restore, { mode: 0o700 });
  return { root, database, restore, operationId };
}

async function fixtureFor(
  phase: string,
  files: readonly string[],
  operationId = 'interrupted',
  existingRoot?: string,
  priorState: 'absent' | 'present' = 'present',
): Promise<Fixture> {
  const root = existingRoot ?? (await mkdtemp(join(tmpdir(), 'forgeboard-interrupted-restore-')));
  if (existingRoot === undefined) roots.push(root);
  const database = join(root, 'db.sqlite');
  const restore = join(root, `.forgeboard-database-restore-${operationId}`);
  await mkdir(restore, { mode: 0o700 });
  for (const file of files) {
    if (!['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm'].includes(file)) continue;
    const priorPath =
      phase === 'prepared' || phase === 'rolled-back'
        ? join(root, file)
        : join(restore, `previous-${file}`);
    await writeFile(priorPath, `prior-${file}`, {
      mode: 0o600,
    });
  }
  if (phase === 'completed') {
    await writeFile(database, 'installed candidate', { mode: 0o600 });
  }
  const phaseOrder = [
    'prepared',
    'quarantining',
    'quarantined',
    'installed',
    ...(phase === 'rolling-back' ? ['rolling-back'] : []),
    ...(phase === 'completed' ? ['completed'] : []),
    ...(phase === 'rolled-back' ? ['rolling-back', 'rolled-back'] : []),
  ];
  const endIndex = phaseOrder.indexOf(phase);
  const priorSha256 = Object.fromEntries(
    files.map((file) => [file, createHash('sha256').update(`prior-${file}`).digest('hex')]),
  );
  const records = phaseOrder.slice(0, endIndex + 1).map((recordPhase, index) => ({
    schemaVersion: 1,
    operationId,
    phase: recordPhase,
    ...(index === 0
      ? {
          files,
          ...(priorState === 'present' ? { priorSha256 } : {}),
          priorState,
          sourceSha256: createHash('sha256').update('selected source').digest('hex'),
        }
      : recordPhase === 'rolling-back'
        ? { files }
        : recordPhase === 'completed'
          ? {
              installedSha256: {
                'db.sqlite': createHash('sha256').update('installed candidate').digest('hex'),
              },
            }
          : {}),
  }));
  await writeFile(
    join(restore, 'operation.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );
  await chmod(restore, 0o700);
  return { root, database, restore, operationId };
}

async function journalPhases(restoreDirectory: string): Promise<string[]> {
  return (await readFile(join(restoreDirectory, 'operation.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { phase: string }).phase);
}
