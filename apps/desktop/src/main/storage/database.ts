import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS = [
  `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      value_json TEXT NOT NULL,
      opened_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recent_projects_opened_at ON recent_projects(opened_at DESC);
    CREATE TABLE IF NOT EXISTS canvas_documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      status TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_project_updated
      ON agent_runs(project_id, updated_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS canvas_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_canvas_created
      ON canvas_snapshots(canvas_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_project_created
      ON canvas_snapshots(project_id, created_at DESC, id DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS project_path_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      previous_path TEXT NOT NULL,
      replacement_path TEXT NOT NULL,
      relocated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_path_history_project
      ON project_path_history(project_id, sequence DESC);
    CREATE TABLE IF NOT EXISTS backup_records (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0)
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS trusted_extension_ledger (
      extension_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version > 0),
      extension_version TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'revoked')),
      operation_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trusted_extension_ledger_state_updated
      ON trusted_extension_ledger(state, updated_at DESC, extension_id);
  `,
] as const;

export function openDatabase(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA busy_timeout = 5000;');
    database.exec('PRAGMA trusted_schema = OFF;');
    database.exec('PRAGMA secure_delete = ON;');
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the initialization error when SQLite also rejects cleanup.
    }
    throw error;
  }
}

export function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const result = operation();
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

export function migrate(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version;').get() as
    | { user_version: number }
    | undefined;
  const current = versionRow?.user_version ?? 0;
  for (let index = current; index < MIGRATIONS.length; index += 1) {
    const migration = MIGRATIONS[index];
    if (!migration) throw new Error(`Missing migration ${index + 1}.`);
    transaction(database, () => {
      database.exec(migration);
      database
        .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)')
        .run(index + 1, new Date().toISOString());
      database.exec(`PRAGMA user_version = ${index + 1};`);
    });
  }
}

export function clearAllTables(database: DatabaseSync): void {
  database.prepare('DELETE FROM trusted_extension_ledger').run();
  database.prepare('DELETE FROM canvas_snapshots').run();
  database.prepare('DELETE FROM canvas_documents').run();
  database.prepare('DELETE FROM project_path_history').run();
  database.prepare('DELETE FROM recent_projects').run();
  database.prepare('DELETE FROM agent_runs').run();
  database.prepare('DELETE FROM app_settings').run();
  database.prepare('DELETE FROM audit_events').run();
  database.prepare('DELETE FROM backup_records').run();
}
