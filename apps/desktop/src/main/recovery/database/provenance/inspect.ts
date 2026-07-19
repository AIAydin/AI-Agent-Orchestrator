import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';

import { MIGRATIONS } from '../../../storage/database.js';
import { initializeAuditIntegrity } from '../../../storage/security/audit-integrity.js';

export type ForgeboardDatabaseProvenanceFailureReason =
  | 'newer'
  | 'foreign'
  | 'corrupt'
  | 'unavailable';

export type ForgeboardDatabaseProvenanceResult =
  | {
      readonly ok: true;
      readonly schemaVersion: number;
      readonly currentSchemaVersion: number;
      readonly requiresMigration: boolean;
      readonly requiresAuditDeleteTriggerUpgrade?: true;
    }
  | {
      readonly ok: false;
      readonly reason: ForgeboardDatabaseProvenanceFailureReason;
      /** A bounded, path-free explanation suitable for native startup policy. */
      readonly message: string;
    };

interface SchemaObjectRow {
  readonly name: string;
  readonly sql: string | null;
  readonly tbl_name: string;
  readonly type: string;
}

interface MigrationVersionRow {
  readonly version: number;
}

const CURRENT_SCHEMA_VERSION = MIGRATIONS.length;
const expectedSchemaByVersion = new Map<number, ReadonlyMap<string, string>>();
const LEGACY_MISSING_AUDIT_DELETE_TRIGGERS = [
  'trigger:audit_events_no_delete',
  'trigger:audit_checkpoints_no_delete',
] as const;

const MESSAGES = {
  newer: 'This database was created by a newer Forgeboard version. Update Forgeboard to open it.',
  foreign: 'The selected database is not a verified Forgeboard database.',
  corrupt: 'The Forgeboard database provenance or schema is inconsistent.',
  unavailable: 'Forgeboard could not inspect the database safely.',
} as const satisfies Record<ForgeboardDatabaseProvenanceFailureReason, string>;

/**
 * Inspects a database through a read-only, query-only connection before any migration is allowed.
 * The result never includes a filesystem path or an underlying SQLite error.
 */
export function inspectForgeboardDatabaseProvenance(
  databasePath: string,
): ForgeboardDatabaseProvenanceResult {
  if (!isAbsolute(databasePath) || databasePath.includes('\0')) return failure('unavailable');

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
  } catch {
    return failure('unavailable');
  }

  try {
    const schemaVersion = readSchemaVersion(database);
    if (schemaVersion > CURRENT_SCHEMA_VERSION) return failure('newer');
    if (schemaVersion < 1) return failure('foreign');
    if (!hasHealthySqliteStructure(database)) return failure('corrupt');

    const actualSchema = readUserSchema(database);
    if (!hasForgeboardAnchors(actualSchema)) return failure('foreign');
    if (!hasContiguousMigrationLedger(database, schemaVersion)) return failure('corrupt');

    const expectedSchema = expectedSchemaForVersion(schemaVersion);
    if (hasUnknownSchemaObjects(actualSchema, expectedSchema)) return failure('foreign');
    const requiresAuditDeleteTriggerUpgrade = needsAuditDeleteTriggerUpgrade(
      actualSchema,
      expectedSchema,
    );
    if (!schemasMatch(actualSchema, expectedSchema) && !requiresAuditDeleteTriggerUpgrade) {
      return failure('corrupt');
    }

    return {
      ok: true,
      schemaVersion,
      currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      requiresMigration: schemaVersion < CURRENT_SCHEMA_VERSION,
      ...(requiresAuditDeleteTriggerUpgrade ? { requiresAuditDeleteTriggerUpgrade: true } : {}),
    };
  } catch {
    return failure('corrupt');
  } finally {
    try {
      database.close();
    } catch {
      // Inspection has already completed; never expose local connection details.
    }
  }
}

function failure(
  reason: ForgeboardDatabaseProvenanceFailureReason,
): ForgeboardDatabaseProvenanceResult {
  return { ok: false, reason, message: MESSAGES[reason] };
}

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version;').get() as
    | { readonly user_version?: unknown }
    | undefined;
  const version = row?.user_version;
  if (!Number.isSafeInteger(version)) throw new Error('Invalid schema version.');
  return version as number;
}

function hasHealthySqliteStructure(database: DatabaseSync): boolean {
  const rows = database.prepare('PRAGMA quick_check;').all() as unknown as readonly {
    readonly quick_check?: unknown;
  }[];
  return rows.length === 1 && rows[0]?.quick_check === 'ok';
}

function hasForgeboardAnchors(schema: ReadonlyMap<string, string>): boolean {
  return ['table:schema_migrations', 'table:app_settings', 'table:canvas_documents'].every((key) =>
    schema.has(key),
  );
}

function hasContiguousMigrationLedger(database: DatabaseSync, schemaVersion: number): boolean {
  let rows: readonly MigrationVersionRow[];
  try {
    rows = database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as unknown as readonly MigrationVersionRow[];
  } catch {
    return false;
  }
  return rows.length === schemaVersion && rows.every((row, index) => row.version === index + 1);
}

function readUserSchema(database: DatabaseSync): ReadonlyMap<string, string> {
  const rows = database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY type, name`,
    )
    .all() as unknown as readonly SchemaObjectRow[];
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!['table', 'index', 'trigger', 'view'].includes(row.type) || row.sql === null) {
      throw new Error('Unsupported schema object.');
    }
    const key = `${row.type}:${row.name}`;
    if (result.has(key)) throw new Error('Duplicate schema object.');
    result.set(key, schemaIdentity(row));
  }
  return result;
}

function expectedSchemaForVersion(version: number): ReadonlyMap<string, string> {
  const cached = expectedSchemaByVersion.get(version);
  if (cached !== undefined) return cached;

  const database = new DatabaseSync(':memory:');
  try {
    for (let index = 0; index < version; index += 1) {
      const migration = MIGRATIONS[index];
      if (migration === undefined) throw new Error('Missing Forgeboard migration.');
      database.exec('BEGIN IMMEDIATE;');
      try {
        database.exec(migration);
        database
          .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)')
          .run(index + 1, '2000-01-01T00:00:00.000Z');
        database.exec(`PRAGMA user_version = ${String(index + 1)}; COMMIT;`);
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    }
    installRuntimeSchemaAuthorities(database);
    const expected = readUserSchema(database);
    expectedSchemaByVersion.set(version, expected);
    return expected;
  } finally {
    database.close();
  }
}

function installRuntimeSchemaAuthorities(database: DatabaseSync): void {
  const supportsAuditChain = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'audit_chain_state'",
    )
    .get();
  if (supportsAuditChain === undefined) return;
  // Audit immutability is installed by LocalStore immediately after schema migration rather than
  // embedded in MIGRATIONS. Derive those trigger identities from the production authority too.
  initializeAuditIntegrity(database, new Date('2000-01-01T00:00:00.000Z'));
}

function hasUnknownSchemaObjects(
  actual: ReadonlyMap<string, string>,
  expected: ReadonlyMap<string, string>,
): boolean {
  return [...actual.keys()].some((key) => !expected.has(key));
}

function schemasMatch(
  actual: ReadonlyMap<string, string>,
  expected: ReadonlyMap<string, string>,
): boolean {
  return (
    actual.size === expected.size &&
    [...expected].every(([key, identity]) => actual.get(key) === identity)
  );
}

function needsAuditDeleteTriggerUpgrade(
  actual: ReadonlyMap<string, string>,
  expected: ReadonlyMap<string, string>,
): boolean {
  if (actual.size !== expected.size - LEGACY_MISSING_AUDIT_DELETE_TRIGGERS.length) {
    return false;
  }
  if (LEGACY_MISSING_AUDIT_DELETE_TRIGGERS.some((key) => !expected.has(key) || actual.has(key))) {
    return false;
  }
  if ([...actual].some(([key, identity]) => expected.get(key) !== identity)) {
    return false;
  }
  return true;
}

function schemaIdentity(row: SchemaObjectRow): string {
  return `${row.type}\n${row.name}\n${row.tbl_name}\n${normalizeSchemaSql(row.sql ?? '')}`;
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}
