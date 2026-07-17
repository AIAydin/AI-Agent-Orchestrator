import type { DatabaseSync } from 'node:sqlite';

import {
  TerminalSessionStatusSchema,
  TerminalSessionViewSchema,
  type TerminalSessionView,
} from '../../../shared/terminal/index.js';
import {
  StoredTerminalSessionSchema,
  terminalStorageRecord,
  type StoredTerminalSession,
} from './contracts.js';

interface TerminalSessionRow {
  readonly id: string;
  readonly project_id: string;
  readonly node_id: string;
  readonly status: string;
  readonly updated_at: string;
  readonly value_json: string;
}

export interface TerminalRecoveryReport {
  readonly lostSessionIds: readonly string[];
  readonly recoveredAt: string;
}

export function createTerminalSession(database: DatabaseSync, session: TerminalSessionView): void {
  const record = terminalStorageRecord(session);
  database
    .prepare(
      `INSERT INTO terminal_sessions(id, project_id, node_id, status, updated_at, value_json)
       VALUES(?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.session.id,
      record.session.projectId,
      record.session.nodeId,
      record.session.status,
      record.session.updatedAt,
      JSON.stringify(record),
    );
}

export function updateTerminalSession(
  database: DatabaseSync,
  session: TerminalSessionView,
  transcript?: {
    readonly transcriptBytes: number;
    readonly lastPersistedSequence: number;
  },
): void {
  const current = getTerminalSessionRecord(database, session.id);
  if (current === undefined) throw new Error('The terminal session no longer exists.');
  if (
    current.session.projectId !== session.projectId ||
    current.session.nodeId !== session.nodeId
  ) {
    throw new Error('The terminal session target changed before its update.');
  }
  const record = terminalStorageRecord(session, transcript ?? current);
  const result = database
    .prepare(
      `UPDATE terminal_sessions
       SET status = ?, updated_at = ?, value_json = ?
       WHERE id = ? AND project_id = ? AND node_id = ?`,
    )
    .run(
      record.session.status,
      record.session.updatedAt,
      JSON.stringify(record),
      record.session.id,
      record.session.projectId,
      record.session.nodeId,
    );
  if (Number(result.changes) !== 1) {
    throw new Error('The terminal session changed before its exact update.');
  }
}

export function getTerminalSession(
  database: DatabaseSync,
  sessionId: string,
): TerminalSessionView | undefined {
  return getTerminalSessionRecord(database, sessionId)?.session;
}

export function getTerminalSessionRecord(
  database: DatabaseSync,
  sessionId: string,
): StoredTerminalSession | undefined {
  const row = database
    .prepare(
      `SELECT id, project_id, node_id, status, updated_at, value_json
       FROM terminal_sessions WHERE id = ?`,
    )
    .get(sessionId) as TerminalSessionRow | undefined;
  return row === undefined ? undefined : parseTerminalSessionRow(row);
}

export function listTerminalSessions(
  database: DatabaseSync,
  projectId: string,
  nodeId?: string,
  limit = 100,
): TerminalSessionView[] {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = (nodeId === undefined
    ? database
        .prepare(
          `SELECT id, project_id, node_id, status, updated_at, value_json
             FROM terminal_sessions WHERE project_id = ?
             ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(projectId, boundedLimit)
    : database
        .prepare(
          `SELECT id, project_id, node_id, status, updated_at, value_json
             FROM terminal_sessions WHERE project_id = ? AND node_id = ?
             ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(projectId, nodeId, boundedLimit)) as unknown as TerminalSessionRow[];
  return rows.map((row) => parseTerminalSessionRow(row).session);
}

export function recoverInterruptedTerminalSessions(
  database: DatabaseSync,
  now = new Date(),
): TerminalRecoveryReport {
  const recoveredAt = now.toISOString();
  const rows = database
    .prepare(
      `SELECT id, project_id, node_id, status, updated_at, value_json
       FROM terminal_sessions WHERE status IN ('starting', 'running')
       ORDER BY updated_at, id`,
    )
    .all() as unknown as TerminalSessionRow[];
  for (const row of rows) {
    const record = parseTerminalSessionRow(row);
    const startedAt = record.session.startedAt ?? record.session.updatedAt;
    const lost = TerminalSessionViewSchema.parse({
      ...record.session,
      status: 'lost',
      startedAt,
      endedAt: recoveredAt,
      exitCode: null,
      exitSignal: null,
      updatedAt: recoveredAt,
    });
    updateTerminalSession(database, lost);
  }
  return { lostSessionIds: rows.map((row) => row.id), recoveredAt };
}

export function deleteTerminalSessions(database: DatabaseSync): number {
  return Number(database.prepare('DELETE FROM terminal_sessions').run().changes);
}

export function deleteTerminalSession(database: DatabaseSync, sessionId: string): boolean {
  return (
    Number(database.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(sessionId).changes) >
    0
  );
}

export function listAllTerminalSessionIds(database: DatabaseSync): string[] {
  const rows = database
    .prepare('SELECT id FROM terminal_sessions ORDER BY id')
    .all() as unknown as {
    readonly id: string;
  }[];
  return rows.map((row) => row.id);
}

export function listExpiredTerminalSessionIds(database: DatabaseSync, cutoff: string): string[] {
  const rows = database
    .prepare(
      `SELECT id FROM terminal_sessions
       WHERE updated_at < ? AND status NOT IN ('starting', 'running')
       ORDER BY updated_at, id`,
    )
    .all(cutoff) as unknown as { readonly id: string }[];
  return rows.map((row) => row.id);
}

export function terminalSessionIntegrityMessages(database: DatabaseSync): string[] {
  const rows = database
    .prepare(
      `SELECT id, project_id, node_id, status, updated_at, value_json
       FROM terminal_sessions ORDER BY id`,
    )
    .all() as unknown as TerminalSessionRow[];
  const messages: string[] = [];
  rows.forEach((row, index) => {
    try {
      parseTerminalSessionRow(row);
    } catch (error) {
      messages.push(
        `terminal_sessions row ${index + 1}: ${error instanceof Error ? error.message : 'invalid session'}`,
      );
    }
  });
  return messages;
}

function parseTerminalSessionRow(row: TerminalSessionRow): StoredTerminalSession {
  let value: unknown;
  try {
    value = JSON.parse(row.value_json) as unknown;
  } catch {
    throw new Error('session JSON is invalid');
  }
  const record = StoredTerminalSessionSchema.parse(value);
  const status = TerminalSessionStatusSchema.parse(row.status);
  if (
    record.session.id !== row.id ||
    record.session.projectId !== row.project_id ||
    record.session.nodeId !== row.node_id ||
    record.session.status !== status ||
    record.session.updatedAt !== row.updated_at
  ) {
    throw new Error('indexed columns do not match path-free session JSON');
  }
  return record;
}
