import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AppSettingsSchema,
  AuditEventSchema,
  CanvasDocumentSchema,
  ProjectSchema,
  type AppSettings,
  type AuditEvent,
  type CanvasDocument,
  type Project,
} from '../shared/contracts.js';

const MIGRATIONS = [
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
] as const;

interface JsonRow {
  value_json: string;
}

interface IntegrityRow {
  quick_check: string;
}

interface AuditRow {
  sequence: number;
  occurred_at: string;
  category: string;
  action: string;
  outcome: string;
}

export interface StoredRunRecord {
  id: string;
  projectId: string;
  nodeId: string;
  adapterId: string;
  status: 'prepared' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'terminated' | 'lost';
  cwd: string;
  branch: string | null;
  worktreeId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}

export class LocalStore {
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL;');
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.assertIntegrity();
    this.recoverInterruptedRuns();
  }

  close(): void {
    this.database.close();
  }

  getSettings(fallback: AppSettings): AppSettings {
    const row = this.database
      .prepare('SELECT value_json FROM app_settings WHERE singleton = 1')
      .get() as JsonRow | undefined;
    if (!row) return fallback;
    return AppSettingsSchema.parse(JSON.parse(row.value_json));
  }

  saveSettings(settings: AppSettings): AppSettings {
    const parsed = AppSettingsSchema.parse(settings);
    if (parsed.previewPortEnd <= parsed.previewPortStart) {
      throw new Error('Preview port end must be greater than preview port start.');
    }
    this.database
      .prepare(
        `INSERT INTO app_settings(singleton, value_json, updated_at) VALUES(1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(parsed), new Date().toISOString());
    return parsed;
  }

  listProjects(): Project[] {
    const rows = this.database
      .prepare('SELECT value_json FROM recent_projects ORDER BY opened_at DESC LIMIT 30')
      .all() as unknown as JsonRow[];
    return rows.map((row) => ProjectSchema.parse(JSON.parse(row.value_json)));
  }

  saveProject(project: Project): Project {
    const parsed = ProjectSchema.parse(project);
    this.database
      .prepare(
        `INSERT INTO recent_projects(id, path, value_json, opened_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET id = excluded.id, value_json = excluded.value_json,
         opened_at = excluded.opened_at`,
      )
      .run(parsed.id, parsed.path, JSON.stringify(parsed), parsed.openedAt);
    return parsed;
  }

  loadCanvas(projectId: string): CanvasDocument | undefined {
    const row = this.database
      .prepare('SELECT value_json FROM canvas_documents WHERE project_id = ?')
      .get(projectId) as JsonRow | undefined;
    return row ? CanvasDocumentSchema.parse(JSON.parse(row.value_json)) : undefined;
  }

  saveCanvas(document: CanvasDocument): CanvasDocument {
    const parsed = CanvasDocumentSchema.parse(document);
    this.database
      .prepare(
        `INSERT INTO canvas_documents(id, project_id, value_json, updated_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET id = excluded.id, value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      )
      .run(parsed.id, parsed.projectId, JSON.stringify(parsed), parsed.updatedAt);
    return parsed;
  }

  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void {
    this.database
      .prepare(
        `INSERT INTO audit_events(occurred_at, category, action, outcome, metadata_json)
         VALUES(?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), category, action, outcome, JSON.stringify(redact(metadata)));
  }

  listAuditEvents(limit: number): AuditEvent[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.database
      .prepare(
        `SELECT sequence, occurred_at, category, action, outcome
         FROM audit_events ORDER BY sequence DESC LIMIT ?`,
      )
      .all(boundedLimit) as unknown as AuditRow[];
    return rows.map((row) =>
      AuditEventSchema.parse({
        sequence: row.sequence,
        occurredAt: row.occurred_at,
        category: row.category,
        action: row.action,
        outcome: row.outcome,
      }),
    );
  }

  saveRun(record: StoredRunRecord): StoredRunRecord {
    this.database
      .prepare(
        `INSERT INTO agent_runs(
           id, project_id, node_id, adapter_id, status, value_json, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.projectId,
        record.nodeId,
        record.adapterId,
        record.status,
        JSON.stringify(record),
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  exportData(): Record<string, unknown> {
    return {
      format: 'forgeboard-local-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: this.database.prepare('SELECT value_json FROM app_settings').all(),
      projects: this.database.prepare('SELECT value_json FROM recent_projects').all(),
      canvases: this.database.prepare('SELECT value_json FROM canvas_documents').all(),
      runs: this.database.prepare('SELECT value_json FROM agent_runs ORDER BY updated_at').all(),
      audit: this.database
        .prepare(
          `SELECT sequence, occurred_at, category, action, outcome, metadata_json
           FROM audit_events ORDER BY sequence`,
        )
        .all(),
    };
  }

  deleteAllLocalData(): void {
    this.transaction(() => {
      this.database.prepare('DELETE FROM canvas_documents').run();
      this.database.prepare('DELETE FROM recent_projects').run();
      this.database.prepare('DELETE FROM agent_runs').run();
      this.database.prepare('DELETE FROM app_settings').run();
      this.database.prepare('DELETE FROM audit_events').run();
    });
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  private migrate(): void {
    const versionRow = this.database.prepare('PRAGMA user_version;').get() as
      | { user_version: number }
      | undefined;
    const current = versionRow?.user_version ?? 0;
    for (let index = current; index < MIGRATIONS.length; index += 1) {
      const migration = MIGRATIONS[index];
      if (!migration) throw new Error(`Missing migration ${index + 1}.`);
      this.transaction(() => {
        this.database.exec(migration);
        this.database
          .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)')
          .run(index + 1, new Date().toISOString());
        this.database.exec(`PRAGMA user_version = ${index + 1};`);
      });
    }
  }

  private assertIntegrity(): void {
    const row = this.database.prepare('PRAGMA quick_check;').get() as IntegrityRow | undefined;
    if (!row || row.quick_check !== 'ok') {
      throw new Error('The local Forgeboard database failed its startup integrity check.');
    }
  }

  private recoverInterruptedRuns(): void {
    const now = new Date().toISOString();
    const rows = this.database
      .prepare(
        `SELECT value_json FROM agent_runs WHERE status IN ('prepared', 'running')
         ORDER BY updated_at`,
      )
      .all() as unknown as JsonRow[];
    for (const row of rows) {
      const value = JSON.parse(row.value_json) as StoredRunRecord;
      this.saveRun({
        ...value,
        status: 'lost',
        endedAt: now,
        updatedAt: now,
      });
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }
}

const SECRET_KEY = /(token|secret|password|authorization|cookie|credential|private.?key)/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEY.test(key) ? '[REDACTED]' : redact(child),
      ]),
    );
  }
  return value;
}
