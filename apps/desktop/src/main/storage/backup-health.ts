import type { DatabaseSync } from 'node:sqlite';

import {
  BackupHealthSchema,
  type BackupHealth,
  type BackupResult,
} from '../../shared/contracts.js';

const MAX_ERROR_LENGTH = 4_096;

export interface BackupAttempt {
  readonly attemptedAt: Date;
  readonly outcome: 'verified' | 'failed';
  readonly error?: unknown;
}

interface BackupHealthRow {
  last_attempt_at: string;
  last_attempt_outcome: 'verified' | 'failed';
  last_error: string | null;
}

interface VerifiedBackupRow {
  created_at: string;
  sha256: string;
  size_bytes: number;
}

export function recordBackupAttempt(database: DatabaseSync, attempt: BackupAttempt): void {
  const attemptedAt = attempt.attemptedAt.toISOString();
  const lastError = attempt.outcome === 'failed' ? boundedError(attempt.error) : null;
  database
    .prepare(
      `INSERT INTO backup_health(singleton, last_attempt_at, last_attempt_outcome, last_error)
       VALUES(1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
         last_attempt_outcome = excluded.last_attempt_outcome,
         last_error = excluded.last_error`,
    )
    .run(attemptedAt, attempt.outcome, lastError);
}

export function getBackupHealth(database: DatabaseSync): BackupHealth {
  const attempt = database
    .prepare(
      `SELECT last_attempt_at, last_attempt_outcome, last_error
       FROM backup_health WHERE singleton = 1`,
    )
    .get() as BackupHealthRow | undefined;
  const verified = database
    .prepare(
      `SELECT created_at, sha256, size_bytes
       FROM backup_records ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as VerifiedBackupRow | undefined;
  const count = database.prepare('SELECT COUNT(*) AS count FROM backup_records').get() as {
    count: number;
  };
  return BackupHealthSchema.parse({
    lastAttemptAt: attempt?.last_attempt_at ?? null,
    lastAttemptOutcome: attempt?.last_attempt_outcome ?? null,
    lastError: attempt?.last_error ?? null,
    lastVerifiedAt: verified?.created_at ?? null,
    lastVerifiedSizeBytes: verified?.size_bytes ?? null,
    lastVerifiedSha256Prefix: verified?.sha256.slice(0, 12) ?? null,
    verifiedBackupCount: count.count,
  });
}

export function backupAttemptFromResult(result: BackupResult): BackupAttempt {
  return { attemptedAt: new Date(result.createdAt), outcome: 'verified' };
}

function boundedError(error: unknown): string {
  const source = error instanceof Error ? error.message : 'Unknown backup failure';
  const safe = [...source]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127 && !isBidirectionalControl(code);
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  return (safe || 'Unknown backup failure').slice(0, MAX_ERROR_LENGTH);
}

function isBidirectionalControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}
