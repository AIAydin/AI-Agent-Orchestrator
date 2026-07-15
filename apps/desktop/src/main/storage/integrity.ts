import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import {
  AppSettingsSchema,
  AuditEventSchema,
  CanvasDocumentSchema,
  ProjectSchema,
} from '../../shared/contracts.js';
import {
  CanvasSnapshotSchema,
  StoredCheckExecutionRecordSchema,
  StoredRunRecordSchema,
  TrustedExtensionLedgerRecordSchema,
  type IntegrityReport,
} from '../storage-schemas.js';
import {
  CHECK_EXECUTION_COLUMNS,
  checkExecutionMirrorsMatch,
  type CheckExecutionRow,
} from './checks.js';
import { MIGRATIONS } from './database.js';
import {
  canvasContentHash,
  errorMessage,
  isRecord,
  parseJson,
  sanitizeCanvasDocument,
  sanitizeCanvasSnapshot,
  safeParseJson,
  TRUSTED_EXTENSION_LEDGER_COLUMNS,
  trustedExtensionLedgerMirrorsMatch,
  type AuditRow,
  type JsonRow,
  type TrustedExtensionLedgerRow,
  validateSettings,
} from './values.js';

interface IntegrityRow {
  integrity_check?: string;
  quick_check?: string;
}

export function checkDatabaseIntegrity(
  database: DatabaseSync,
  mode: 'quick' | 'full',
  checkedAt: Date,
): IntegrityReport {
  const messages: string[] = [];
  try {
    const pragma = mode === 'full' ? 'integrity_check' : 'quick_check';
    const rows = database.prepare(`PRAGMA ${pragma};`).all() as unknown as IntegrityRow[];
    const physicalMessages = rows.map((row) => row.integrity_check ?? row.quick_check ?? '');
    if (physicalMessages.length !== 1 || physicalMessages[0] !== 'ok') {
      messages.push(...physicalMessages.filter(Boolean).map((message) => `SQLite: ${message}`));
    }
    const version = database.prepare('PRAGMA user_version;').get() as
      | { user_version: number }
      | undefined;
    if (version?.user_version !== MIGRATIONS.length) {
      messages.push(
        `Schema version is ${String(version?.user_version)}, expected ${MIGRATIONS.length}.`,
      );
    }
    const migrationRows = database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as unknown as { version: number }[];
    if (
      migrationRows.length !== MIGRATIONS.length ||
      migrationRows.some((row, index) => row.version !== index + 1)
    ) {
      messages.push('The migration ledger does not match the active schema version.');
    }
    const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check;').all();
    if (foreignKeyFailures.length > 0) {
      messages.push(`SQLite reported ${foreignKeyFailures.length} foreign-key violation(s).`);
    }
    validateStoredJson(database, messages);
  } catch (error) {
    messages.push(error instanceof Error ? error.message : 'Unknown integrity-check failure.');
  }
  return {
    ok: messages.length === 0,
    checkedAt: checkedAt.toISOString(),
    mode,
    messages,
  };
}

export function assertIntegrity(database: DatabaseSync): void {
  const report = checkDatabaseIntegrity(database, 'quick', new Date());
  if (!report.ok) {
    throw new Error(
      `The local Forgeboard database failed its startup integrity check: ${report.messages.join(
        '; ',
      )}`,
    );
  }
}

export function assertBackupIntegrity(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const report = checkDatabaseIntegrity(database, 'full', new Date());
    if (!report.ok) {
      throw new Error(`The completed backup failed validation: ${report.messages.join('; ')}`);
    }
  } finally {
    database.close();
  }
}

function validateStoredJson(database: DatabaseSync, messages: string[]): void {
  const validateRows = (
    table: string,
    schema: { parse(value: unknown): unknown },
    extra?: (value: unknown) => void,
  ): void => {
    const rows = database.prepare(`SELECT value_json FROM ${table}`).all() as unknown as JsonRow[];
    rows.forEach((row, index) => {
      try {
        const value = JSON.parse(row.value_json) as unknown;
        schema.parse(value);
        extra?.(value);
      } catch (error) {
        messages.push(`${table} row ${index + 1}: ${errorMessage(error)}`);
      }
    });
  };
  validateRows('app_settings', AppSettingsSchema, (value) => validateSettings(value));
  validateRows('recent_projects', ProjectSchema);
  validateRows('canvas_documents', CanvasDocumentSchema, (value) => {
    const canvas = CanvasDocumentSchema.parse(value);
    if (!isDeepStrictEqual(canvas, sanitizeCanvasDocument(canvas))) {
      throw new Error('extension data is not in its canonical persisted form');
    }
  });
  validateRows('agent_runs', StoredRunRecordSchema);
  validateRows('check_executions', StoredCheckExecutionRecordSchema);
  validateRows('trusted_extension_ledger', TrustedExtensionLedgerRecordSchema);
  validateRows('canvas_snapshots', CanvasSnapshotSchema, (value) => {
    const snapshot = CanvasSnapshotSchema.parse(value);
    if (!isDeepStrictEqual(snapshot, sanitizeCanvasSnapshot(snapshot))) {
      throw new Error('extension data or snapshot hash is not in its canonical persisted form');
    }
    if (snapshot.contentHash !== canvasContentHash(snapshot.document)) {
      throw new Error('snapshot content hash does not match its document');
    }
  });

  validateMirroredColumns(database, messages);

  const auditRows = database
    .prepare(
      `SELECT sequence, occurred_at, category, action, outcome, metadata_json
       FROM audit_events`,
    )
    .all() as unknown as AuditRow[];
  auditRows.forEach((row, index) => {
    try {
      AuditEventSchema.parse({
        sequence: row.sequence,
        occurredAt: row.occurred_at,
        category: row.category,
        action: row.action,
        outcome: row.outcome,
      });
      const metadata = JSON.parse(row.metadata_json) as unknown;
      if (!isRecord(metadata)) throw new Error('metadata must be a JSON object');
    } catch (error) {
      messages.push(`audit_events row ${index + 1}: ${errorMessage(error)}`);
    }
  });
}

function validateMirroredColumns(database: DatabaseSync, messages: string[]): void {
  const projects = database
    .prepare('SELECT id, path, opened_at, value_json FROM recent_projects')
    .all() as unknown as {
    id: string;
    path: string;
    opened_at: string;
    value_json: string;
  }[];
  projects.forEach((row, index) => {
    const parsed = ProjectSchema.safeParse(parseJson(row.value_json));
    if (
      parsed.success &&
      (parsed.data.id !== row.id ||
        parsed.data.path !== row.path ||
        parsed.data.openedAt !== row.opened_at)
    ) {
      messages.push(`recent_projects row ${index + 1}: indexed columns do not match JSON`);
    }
  });

  const canvases = database
    .prepare('SELECT id, project_id, updated_at, value_json FROM canvas_documents')
    .all() as unknown as {
    id: string;
    project_id: string;
    updated_at: string;
    value_json: string;
  }[];
  canvases.forEach((row, index) => {
    const parsed = CanvasDocumentSchema.safeParse(parseJson(row.value_json));
    if (
      parsed.success &&
      (parsed.data.id !== row.id ||
        parsed.data.projectId !== row.project_id ||
        parsed.data.updatedAt !== row.updated_at)
    ) {
      messages.push(`canvas_documents row ${index + 1}: indexed columns do not match JSON`);
    }
  });

  const runs = database
    .prepare(
      `SELECT id, project_id, node_id, adapter_id, status, created_at, updated_at, value_json
       FROM agent_runs`,
    )
    .all() as unknown as {
    id: string;
    project_id: string;
    node_id: string;
    adapter_id: string;
    status: string;
    created_at: string;
    updated_at: string;
    value_json: string;
  }[];
  runs.forEach((row, index) => {
    const parsed = StoredRunRecordSchema.safeParse(parseJson(row.value_json));
    if (
      parsed.success &&
      (parsed.data.id !== row.id ||
        parsed.data.projectId !== row.project_id ||
        parsed.data.nodeId !== row.node_id ||
        parsed.data.adapterId !== row.adapter_id ||
        parsed.data.status !== row.status ||
        parsed.data.createdAt !== row.created_at ||
        parsed.data.updatedAt !== row.updated_at)
    ) {
      messages.push(`agent_runs row ${index + 1}: indexed columns do not match JSON`);
    }
  });

  const trustedExtensions = database
    .prepare(
      `SELECT ${TRUSTED_EXTENSION_LEDGER_COLUMNS}
       FROM trusted_extension_ledger`,
    )
    .all() as unknown as TrustedExtensionLedgerRow[];
  trustedExtensions.forEach((row, index) => {
    const parsed = TrustedExtensionLedgerRecordSchema.safeParse(safeParseJson(row.value_json));
    if (parsed.success && !trustedExtensionLedgerMirrorsMatch(parsed.data, row)) {
      messages.push(`trusted_extension_ledger row ${index + 1}: indexed columns do not match JSON`);
    }
  });

  const checkExecutions = database
    .prepare(`SELECT ${CHECK_EXECUTION_COLUMNS} FROM check_executions`)
    .all() as unknown as CheckExecutionRow[];
  checkExecutions.forEach((row, index) => {
    const parsed = StoredCheckExecutionRecordSchema.safeParse(safeParseJson(row.value_json));
    if (parsed.success && !checkExecutionMirrorsMatch(parsed.data, row)) {
      messages.push(`check_executions row ${index + 1}: indexed columns do not match JSON`);
    }
  });

  const snapshots = database
    .prepare(
      `SELECT id, project_id, canvas_id, content_hash, reason, created_at, value_json
       FROM canvas_snapshots`,
    )
    .all() as unknown as {
    id: string;
    project_id: string;
    canvas_id: string;
    content_hash: string;
    reason: string;
    created_at: string;
    value_json: string;
  }[];
  snapshots.forEach((row, index) => {
    const parsed = CanvasSnapshotSchema.safeParse(parseJson(row.value_json));
    if (
      parsed.success &&
      (parsed.data.id !== row.id ||
        parsed.data.projectId !== row.project_id ||
        parsed.data.canvasId !== row.canvas_id ||
        parsed.data.contentHash !== row.content_hash ||
        parsed.data.reason !== row.reason ||
        parsed.data.createdAt !== row.created_at)
    ) {
      messages.push(`canvas_snapshots row ${index + 1}: indexed columns do not match JSON`);
    }
  });
}
