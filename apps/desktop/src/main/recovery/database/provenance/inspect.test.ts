import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../../storage/database.js';
import { initializeAuditIntegrity } from '../../../storage/security/audit-integrity.js';
import { LocalStore } from '../../../storage.js';
import { inspectForgeboardDatabaseProvenance } from './inspect.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Artemis database provenance inspection', () => {
  it.each([1, Math.max(1, MIGRATIONS.length - 1), MIGRATIONS.length])(
    'accepts a genuine contiguous Artemis schema at version %s',
    async (version) => {
      const path = await forgeboardDatabase(version);
      const before = await readFile(path);

      expect(inspectForgeboardDatabaseProvenance(path)).toEqual({
        ok: true,
        schemaVersion: version,
        currentSchemaVersion: MIGRATIONS.length,
        requiresMigration: version < MIGRATIONS.length,
      });
      await expect(readFile(path)).resolves.toEqual(before);
    },
  );

  it('rejects an empty SQLite database as foreign without migrating it', async () => {
    const path = await databaseFixture();
    new DatabaseSync(path).close();
    const before = await readFile(path);

    expect(inspectForgeboardDatabaseProvenance(path)).toMatchObject({
      ok: false,
      reason: 'foreign',
    });
    await expect(readFile(path)).resolves.toEqual(before);
  });

  it('accepts a database initialized by the production LocalStore runtime', async () => {
    const path = await databaseFixture();
    new LocalStore(path).close();

    expect(inspectForgeboardDatabaseProvenance(path)).toMatchObject({
      ok: true,
      schemaVersion: MIGRATIONS.length,
    });
  });

  it('recognizes the exact legacy schema missing both audit delete-protection triggers', async () => {
    const path = await forgeboardDatabase(MIGRATIONS.length);
    const database = new DatabaseSync(path);
    database.exec('DROP TRIGGER audit_events_no_delete; DROP TRIGGER audit_checkpoints_no_delete;');
    database.close();

    expect(inspectForgeboardDatabaseProvenance(path)).toEqual({
      ok: true,
      schemaVersion: MIGRATIONS.length,
      currentSchemaVersion: MIGRATIONS.length,
      requiresMigration: false,
      requiresAuditDeleteTriggerUpgrade: true,
    });
  });

  it('rejects a schema missing only one audit delete-protection trigger', async () => {
    const path = await forgeboardDatabase(MIGRATIONS.length);
    const database = new DatabaseSync(path);
    database.exec('DROP TRIGGER audit_events_no_delete;');
    database.close();

    expect(inspectForgeboardDatabaseProvenance(path)).toMatchObject({
      ok: false,
      reason: 'corrupt',
    });
  });

  it('rejects another changed trigger even when both legacy delete triggers are missing', async () => {
    const path = await forgeboardDatabase(MIGRATIONS.length);
    const database = new DatabaseSync(path);
    database.exec(`
      DROP TRIGGER audit_events_no_delete;
      DROP TRIGGER audit_checkpoints_no_delete;
      DROP TRIGGER audit_events_no_update;
      CREATE TRIGGER audit_events_no_update
      BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'changed trigger');
      END;
    `);
    database.close();

    expect(inspectForgeboardDatabaseProvenance(path)).toMatchObject({
      ok: false,
      reason: 'corrupt',
    });
  });

  it('rejects an arbitrary foreign database that has no Artemis anchors', async () => {
    const path = await databaseFixture();
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE unrelated(secret TEXT NOT NULL); PRAGMA user_version = 1;');
    database.close();

    expect(inspectForgeboardDatabaseProvenance(path)).toMatchObject({
      ok: false,
      reason: 'foreign',
    });
  });

  it.each([
    ['table', 'CREATE TABLE foreign_table(value TEXT)'],
    ['view', 'CREATE VIEW foreign_view AS SELECT singleton FROM app_settings'],
    ['index', 'CREATE INDEX foreign_index ON app_settings(updated_at)'],
    ['trigger', 'CREATE TRIGGER foreign_trigger AFTER DELETE ON app_settings BEGIN SELECT 1; END'],
  ])('rejects an unknown user %s in an otherwise genuine database', async (_kind, sql) => {
    const path = await forgeboardDatabase(MIGRATIONS.length);
    const database = new DatabaseSync(path);
    database.exec(sql);
    database.close();

    expect(inspectForgeboardDatabaseProvenance(path)).toMatchObject({
      ok: false,
      reason: 'foreign',
    });
  });

  it('distinguishes a database created by a newer Artemis schema', async () => {
    const path = await forgeboardDatabase(MIGRATIONS.length);
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA user_version = ${String(MIGRATIONS.length + 1)};`);
    database.close();

    expect(inspectForgeboardDatabaseProvenance(path)).toEqual({
      ok: false,
      reason: 'newer',
      message: 'This database was created by a newer Artemis version. Update Artemis to open it.',
    });
  });

  it('classifies a missing migration-ledger entry as corrupt', async () => {
    const path = await forgeboardDatabase(2);
    const database = new DatabaseSync(path);
    database.prepare('DELETE FROM schema_migrations WHERE version = 2').run();
    database.close();

    expect(inspectForgeboardDatabaseProvenance(path)).toMatchObject({
      ok: false,
      reason: 'corrupt',
    });
  });

  it('classifies a malformed SQLite file as corrupt without changing its bytes', async () => {
    const path = await databaseFixture();
    await writeFile(path, 'not a sqlite database');
    const before = await readFile(path);

    expect(inspectForgeboardDatabaseProvenance(path)).toMatchObject({
      ok: false,
      reason: 'corrupt',
    });
    await expect(readFile(path)).resolves.toEqual(before);
  });

  it('classifies a forged definition under a known schema-object name as corrupt', async () => {
    const path = await forgeboardDatabase(MIGRATIONS.length);
    const database = new DatabaseSync(path);
    database.exec(
      'DROP INDEX idx_recent_projects_opened_at; CREATE INDEX idx_recent_projects_opened_at ON recent_projects(path);',
    );
    database.close();

    expect(inspectForgeboardDatabaseProvenance(path)).toMatchObject({
      ok: false,
      reason: 'corrupt',
    });
  });

  it('classifies an unavailable path without exposing it or an SQLite error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-provenance-missing-'));
    roots.push(root);
    const path = join(root, 'customer-secret.sqlite');

    const result = inspectForgeboardDatabaseProvenance(path);
    expect(result).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'Artemis could not inspect the database safely.',
    });
    expect(JSON.stringify(result)).not.toContain(path);
    expect(JSON.stringify(result).length).toBeLessThan(256);
  });

  it('never writes through the query-only connection', async () => {
    const path = await forgeboardDatabase(MIGRATIONS.length);
    const before = await readFile(path);
    await writeFile(`${path}.sentinel`, 'outside database');

    inspectForgeboardDatabaseProvenance(path);

    await expect(readFile(path)).resolves.toEqual(before);
    await expect(readFile(`${path}.sentinel`, 'utf8')).resolves.toBe('outside database');
  });
});

async function databaseFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-provenance-'));
  roots.push(root);
  return join(root, 'database.sqlite');
}

async function forgeboardDatabase(version: number): Promise<string> {
  const path = await databaseFixture();
  const database = new DatabaseSync(path);
  try {
    for (let index = 0; index < version; index += 1) {
      const migration = MIGRATIONS[index];
      if (migration === undefined) throw new Error('Missing fixture migration.');
      database.exec(migration);
      database
        .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
        .run(index + 1, '2026-07-17T00:00:00.000Z');
      database.exec(`PRAGMA user_version = ${String(index + 1)};`);
    }
    const supportsAuditChain = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'audit_chain_state'",
      )
      .get();
    if (supportsAuditChain !== undefined) {
      initializeAuditIntegrity(database, new Date('2026-07-17T00:00:00.000Z'));
    }
  } finally {
    database.close();
  }
  return path;
}
