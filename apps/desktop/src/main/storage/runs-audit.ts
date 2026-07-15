import type { DatabaseSync } from 'node:sqlite';

import { AuditEventSchema, type AuditEvent } from '../../shared/contracts.js';
import {
  StoredRunRecordSchema,
  type InterruptedRunRecoveryReport,
  type StoredRunRecord,
} from '../storage-schemas.js';
import { transaction } from './database.js';
import { type AuditRow, type JsonRow } from './values.js';
import { writeAudit, writeRun } from './writes.js';

export function appendAudit(
  database: DatabaseSync,
  category: string,
  action: string,
  outcome: 'allowed' | 'denied' | 'failed',
  metadata: Record<string, unknown>,
): void {
  writeAudit(database, new Date().toISOString(), category, action, outcome, metadata);
}

export function listAuditEvents(database: DatabaseSync, limit: number): AuditEvent[] {
  const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = database
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

export function saveRun(database: DatabaseSync, record: StoredRunRecord): StoredRunRecord {
  const parsed = StoredRunRecordSchema.parse(record);
  writeRun(database, parsed);
  return parsed;
}

export function getRun(database: DatabaseSync, runId: string): StoredRunRecord | undefined {
  const row = database.prepare('SELECT value_json FROM agent_runs WHERE id = ?').get(runId) as
    | JsonRow
    | undefined;
  return row === undefined ? undefined : StoredRunRecordSchema.parse(JSON.parse(row.value_json));
}

export function listProjectRuns(
  database: DatabaseSync,
  projectId: string,
  limit = 200,
): StoredRunRecord[] {
  const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
  const rows = database
    .prepare(
      `SELECT value_json FROM agent_runs
       WHERE project_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(projectId, boundedLimit) as unknown as JsonRow[];
  return rows.map((row) => StoredRunRecordSchema.parse(JSON.parse(row.value_json)));
}

export function recoverInterruptedRuns(
  database: DatabaseSync,
  now = new Date(),
): InterruptedRunRecoveryReport {
  const recoveredAt = now.toISOString();
  const rows = database
    .prepare(
      `SELECT value_json FROM agent_runs WHERE status IN ('prepared', 'running')
       ORDER BY updated_at`,
    )
    .all() as unknown as JsonRow[];
  const records = rows.map((row) => StoredRunRecordSchema.parse(JSON.parse(row.value_json)));
  const lostRunIds = records.map((record) => record.id);
  if (records.length > 0) {
    transaction(database, () => {
      for (const record of records) {
        writeRun(database, {
          ...record,
          status: 'lost',
          endedAt: recoveredAt,
          updatedAt: recoveredAt,
        });
      }
      writeAudit(database, recoveredAt, 'recovery', 'interrupted-runs', 'allowed', {
        lostRunIds,
      });
    });
  }
  return { lostRunIds, recoveredAt };
}
