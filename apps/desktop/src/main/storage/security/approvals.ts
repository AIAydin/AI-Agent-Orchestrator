import type { DatabaseSync } from 'node:sqlite';

import {
  ApprovalActionSchema,
  ApprovalRecordSchema,
  isApprovalActive,
  type ApprovalRecord,
} from '@forgeboard/core';

import { parseJson } from '../values.js';

interface ApprovalRow {
  readonly id: string;
  readonly project_id: string;
  readonly action: string;
  readonly resource_fingerprint: string;
  readonly agent_id: string | null;
  readonly run_id: string | null;
  readonly decision: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
  readonly consumed_at: string | null;
  readonly single_use: number;
  readonly value_json: string;
}

export function saveApproval(database: DatabaseSync, recordValue: ApprovalRecord): ApprovalRecord {
  const record = ApprovalRecordSchema.parse(recordValue);
  const existing = database.prepare('SELECT 1 FROM approval_records WHERE id = ?').get(record.id);
  if (existing !== undefined) throw new Error('An approval with this identity already exists.');
  database
    .prepare(
      `INSERT INTO approval_records(
         id, project_id, action, resource_fingerprint, agent_id, run_id, decision,
         created_at, expires_at, revoked_at, consumed_at, single_use, value_json
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.scope.projectId,
      record.scope.action,
      record.scope.resourceFingerprint,
      record.scope.agentId ?? null,
      record.scope.runId ?? null,
      record.decision,
      record.createdAt,
      record.expiresAt,
      record.revokedAt ?? null,
      record.consumedAt ?? null,
      record.singleUse ? 1 : 0,
      JSON.stringify(record),
    );
  return record;
}

export function getApproval(
  database: DatabaseSync,
  approvalId: string,
): ApprovalRecord | undefined {
  const row = database.prepare('SELECT * FROM approval_records WHERE id = ?').get(approvalId) as
    | ApprovalRow
    | undefined;
  return row === undefined ? undefined : parseApprovalRow(row);
}

export function listApprovals(
  database: DatabaseSync,
  input: {
    readonly projectId?: string;
    readonly action?: ApprovalRecord['scope']['action'];
    readonly limit: number;
  },
): ApprovalRecord[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (input.projectId !== undefined) {
    clauses.push('project_id = ?');
    values.push(input.projectId);
  }
  if (input.action !== undefined) {
    clauses.push('action = ?');
    values.push(ApprovalActionSchema.parse(input.action));
  }
  const limit = Math.max(1, Math.min(1_000, Math.trunc(input.limit)));
  values.push(limit);
  const rows = database
    .prepare(
      `SELECT * FROM approval_records
       ${clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...values) as unknown as ApprovalRow[];
  return rows.map(parseApprovalRow);
}

export function findApprovalsByScope(
  database: DatabaseSync,
  scope: ApprovalRecord['scope'],
): ApprovalRecord[] {
  const rows = database
    .prepare(
      `SELECT * FROM approval_records
       WHERE project_id = ? AND action = ? AND resource_fingerprint = ?
         AND agent_id IS ? AND run_id IS ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(
      scope.projectId,
      scope.action,
      scope.resourceFingerprint,
      scope.agentId ?? null,
      scope.runId ?? null,
    ) as unknown as ApprovalRow[];
  return rows.map(parseApprovalRow);
}

export function consumeApproval(
  database: DatabaseSync,
  approvalId: string,
  expectedScope: ApprovalRecord['scope'],
  consumedAt: Date,
): ApprovalRecord {
  const current = requiredApproval(database, approvalId);
  if (!Number.isFinite(consumedAt.getTime()))
    throw new Error('Approval consumption time is invalid.');
  if (!isApprovalActive(current, expectedScope, consumedAt)) {
    throw new Error('The scoped approval is no longer active for this exact action.');
  }
  if (!current.singleUse) return current;
  const next = ApprovalRecordSchema.parse({ ...current, consumedAt: consumedAt.toISOString() });
  const nextConsumedAt = next.consumedAt;
  if (nextConsumedAt === undefined)
    throw new Error('The consumed approval is missing its timestamp.');
  const result = database
    .prepare(
      `UPDATE approval_records SET consumed_at = ?, value_json = ?
       WHERE id = ? AND value_json = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
    )
    .run(nextConsumedAt, JSON.stringify(next), approvalId, JSON.stringify(current));
  if (result.changes !== 1) throw new Error('The scoped approval changed before it was consumed.');
  return next;
}

export function revokeApproval(
  database: DatabaseSync,
  approvalId: string,
  revokedAt: Date,
): ApprovalRecord {
  const current = requiredApproval(database, approvalId);
  if (current.revokedAt !== undefined) throw new Error('The scoped approval is already revoked.');
  const next = ApprovalRecordSchema.parse({ ...current, revokedAt: revokedAt.toISOString() });
  const nextRevokedAt = next.revokedAt;
  if (nextRevokedAt === undefined)
    throw new Error('The revoked approval is missing its timestamp.');
  const result = database
    .prepare(
      `UPDATE approval_records SET revoked_at = ?, value_json = ?
       WHERE id = ? AND value_json = ? AND revoked_at IS NULL`,
    )
    .run(nextRevokedAt, JSON.stringify(next), approvalId, JSON.stringify(current));
  if (result.changes !== 1) throw new Error('The scoped approval changed before it was revoked.');
  return next;
}

export function approvalIntegrityMessages(database: DatabaseSync): string[] {
  const rows = database
    .prepare('SELECT * FROM approval_records ORDER BY id')
    .all() as unknown as ApprovalRow[];
  const messages: string[] = [];
  rows.forEach((row, index) => {
    try {
      parseApprovalRow(row);
    } catch (error) {
      messages.push(
        `approval_records row ${index + 1}: ${error instanceof Error ? error.message : 'invalid record'}`,
      );
    }
  });
  return messages;
}

function requiredApproval(database: DatabaseSync, approvalId: string): ApprovalRecord {
  const record = getApproval(database, approvalId);
  if (record === undefined) throw new Error('The scoped approval does not exist.');
  return record;
}

function parseApprovalRow(row: ApprovalRow): ApprovalRecord {
  const record = ApprovalRecordSchema.parse(parseJson(row.value_json));
  if (
    record.id !== row.id ||
    record.scope.projectId !== row.project_id ||
    record.scope.action !== row.action ||
    record.scope.resourceFingerprint !== row.resource_fingerprint ||
    (record.scope.agentId ?? null) !== row.agent_id ||
    (record.scope.runId ?? null) !== row.run_id ||
    record.decision !== row.decision ||
    record.createdAt !== row.created_at ||
    record.expiresAt !== row.expires_at ||
    (record.revokedAt ?? null) !== row.revoked_at ||
    (record.consumedAt ?? null) !== row.consumed_at ||
    (record.singleUse ? 1 : 0) !== row.single_use
  ) {
    throw new Error('Approval indexed columns do not match the authoritative record.');
  }
  return record;
}
