import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { AppSettingsSchema, type AppSettings } from '../../../shared/application/contracts.js';
import {
  SETTINGS_REPAIR_EVIDENCE_MAX_BYTES,
  SETTINGS_REPAIR_HISTORY_LIMIT,
  SettingsRepairEvidenceSchema,
  SettingsRepairSummarySchema,
  type SettingsRepairEvidence,
  type SettingsRepairSummary,
} from '../../../shared/settings/repair/contracts.js';
import { MIGRATIONS, transaction } from '../database.js';
import { appendChainedAudit } from '../security/audit-integrity.js';
import { writeSettings } from '../writes.js';
import {
  assertSettingsRepairEvidenceByteCount,
  assertSettingsRepairEvidenceValue,
  SettingsRepairRecoveryLimitError,
} from './limits.js';
import { planLegacySettingsRepair } from './plan.js';

interface SettingsRepairSummaryRow {
  readonly id: string;
  readonly repaired_at: string;
  readonly source_database_version: number;
  readonly repaired_fields_json: string;
  readonly source_settings_sha256: string;
  readonly repaired_settings_sha256: string;
}

interface SettingsRepairRow extends SettingsRepairSummaryRow {
  readonly source_settings_json: string;
  readonly repaired_settings_json: string;
}

interface BoundedSettingsRepairRow extends SettingsRepairSummaryRow {
  readonly source_settings_bytes: number;
  readonly repaired_settings_bytes: number;
  readonly source_settings_json: string | null;
  readonly repaired_settings_json: string | null;
}

const SETTINGS_REPAIR_SUMMARY_COLUMNS = `
  id, repaired_at, source_database_version, repaired_fields_json,
  source_settings_sha256, repaired_settings_sha256
`;

export function repairLegacyStoredSettings(
  database: DatabaseSync,
  sourceDatabaseVersion: number,
  defaults: AppSettings,
): SettingsRepairSummary | undefined {
  // A process can stop after the schema migration commits but before compatibility repair begins.
  // Re-evaluate current-version rows idempotently so that crash cannot make the upgrade permanent.
  if (sourceDatabaseVersion > MIGRATIONS.length) return undefined;
  const row = database
    .prepare(
      `SELECT length(CAST(value_json AS BLOB)) AS value_bytes,
              CASE WHEN length(CAST(value_json AS BLOB)) <= ? THEN value_json END AS value_json
       FROM app_settings WHERE singleton = 1`,
    )
    .get(SETTINGS_REPAIR_EVIDENCE_MAX_BYTES) as
    | { value_bytes: number; value_json: string | null }
    | undefined;
  if (row === undefined) return undefined;
  assertSettingsRepairEvidenceByteCount(row.value_bytes, 'Stored settings');
  if (row.value_json === null) throw new SettingsRepairRecoveryLimitError('Stored settings');
  const planned = planLegacySettingsRepair(row.value_json, sourceDatabaseVersion, defaults);
  if (planned === undefined) return undefined;

  transaction(database, () => {
    insertRepairEvidence(database, planned.evidence);
    writeSettings(database, planned.settings);
    pruneRepairHistory(database);
    appendChainedAudit(
      database,
      planned.evidence.repairedAt,
      'settings',
      'legacy-settings-repair',
      'allowed',
      {
        repairId: planned.evidence.id,
        repairedFieldPaths: planned.evidence.repairedFieldPaths,
        sourceSettingsSha256Prefix: planned.evidence.sourceSettingsSha256.slice(0, 12),
      },
    );
  });
  return summaryFromEvidence(planned.evidence);
}

export function listSettingsRepairs(database: DatabaseSync): SettingsRepairSummary[] {
  const rows = database
    .prepare(
      `SELECT ${SETTINGS_REPAIR_SUMMARY_COLUMNS}
       FROM settings_repair_history ORDER BY repaired_at DESC, id DESC
       LIMIT ?`,
    )
    .all(SETTINGS_REPAIR_HISTORY_LIMIT) as unknown as SettingsRepairSummaryRow[];
  return rows.map(summaryFromRow);
}

export function getSettingsRepair(
  database: DatabaseSync,
  repairId: string,
): SettingsRepairEvidence | undefined {
  const row = selectBoundedEvidenceRow(database, repairId);
  return row === undefined ? undefined : evidenceFromBoundedRow(row);
}

export function settingsRepairIntegrityMessages(database: DatabaseSync): string[] {
  const messages: string[] = [];
  const updateTrigger = database
    .prepare(
      `SELECT type FROM sqlite_master
       WHERE name = 'settings_repair_history_no_update'`,
    )
    .get() as { type: string } | undefined;
  if (updateTrigger?.type !== 'trigger') {
    messages.push('Settings repair evidence immutability trigger is missing.');
  }
  const rowCount = database
    .prepare('SELECT count(*) AS count FROM settings_repair_history')
    .get() as { count: number } | undefined;
  if (rowCount === undefined || !Number.isSafeInteger(rowCount.count) || rowCount.count < 0) {
    messages.push('Settings repair history count is invalid.');
  } else if (rowCount.count > SETTINGS_REPAIR_HISTORY_LIMIT) {
    messages.push('Settings repair history exceeds its bounded retention limit.');
  }
  const identifiers = database
    .prepare(
      `SELECT id FROM settings_repair_history
       ORDER BY repaired_at DESC, id DESC LIMIT ?`,
    )
    .all(SETTINGS_REPAIR_HISTORY_LIMIT) as unknown as Array<{ id: string }>;
  identifiers.forEach((identifier, index) => {
    try {
      const row = selectBoundedEvidenceRow(database, identifier.id);
      if (row === undefined) throw new Error('repair evidence disappeared during validation');
      const evidence = evidenceFromBoundedRow(row);
      if (sha256(evidence.sourceSettingsJson) !== evidence.sourceSettingsSha256) {
        throw new Error('source settings hash does not match the preserved evidence');
      }
      if (sha256(evidence.repairedSettingsJson) !== evidence.repairedSettingsSha256) {
        throw new Error('repaired settings hash does not match the preserved evidence');
      }
      JSON.parse(evidence.sourceSettingsJson);
      AppSettingsSchema.parse(JSON.parse(evidence.repairedSettingsJson));
      if (evidence.sourceDatabaseVersion > MIGRATIONS.length) {
        throw new Error('repair evidence identifies a future database version');
      }
    } catch (error) {
      messages.push(
        `settings_repair_history row ${index + 1}: ${
          error instanceof Error ? error.message : 'invalid repair evidence'
        }`,
      );
    }
  });
  return messages;
}

function insertRepairEvidence(database: DatabaseSync, evidence: SettingsRepairEvidence): void {
  assertSettingsRepairEvidenceValue(evidence.sourceSettingsJson, 'Stored settings repair evidence');
  assertSettingsRepairEvidenceValue(
    evidence.repairedSettingsJson,
    'Repaired settings repair evidence',
  );
  const parsed = SettingsRepairEvidenceSchema.parse(evidence);
  database
    .prepare(
      `INSERT INTO settings_repair_history(
         id, repaired_at, source_database_version, repaired_fields_json,
         source_settings_sha256, repaired_settings_sha256,
         source_settings_json, repaired_settings_json
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      parsed.id,
      parsed.repairedAt,
      parsed.sourceDatabaseVersion,
      JSON.stringify(parsed.repairedFieldPaths),
      parsed.sourceSettingsSha256,
      parsed.repairedSettingsSha256,
      parsed.sourceSettingsJson,
      parsed.repairedSettingsJson,
    );
}

function pruneRepairHistory(database: DatabaseSync): void {
  database
    .prepare(
      `DELETE FROM settings_repair_history
       WHERE id IN (
         SELECT id FROM settings_repair_history
         ORDER BY repaired_at DESC, id DESC LIMIT -1 OFFSET ?
       )`,
    )
    .run(SETTINGS_REPAIR_HISTORY_LIMIT);
}

function evidenceFromRow(row: SettingsRepairRow): SettingsRepairEvidence {
  const repairedFieldPaths: unknown = JSON.parse(row.repaired_fields_json);
  return SettingsRepairEvidenceSchema.parse({
    id: row.id,
    repairedAt: row.repaired_at,
    sourceDatabaseVersion: row.source_database_version,
    repairedFieldPaths,
    sourceSettingsSha256: row.source_settings_sha256,
    repairedSettingsSha256: row.repaired_settings_sha256,
    sourceSettingsJson: row.source_settings_json,
    repairedSettingsJson: row.repaired_settings_json,
  });
}

function selectBoundedEvidenceRow(
  database: DatabaseSync,
  repairId: string,
): BoundedSettingsRepairRow | undefined {
  return database
    .prepare(
      `SELECT ${SETTINGS_REPAIR_SUMMARY_COLUMNS},
              length(CAST(source_settings_json AS BLOB)) AS source_settings_bytes,
              length(CAST(repaired_settings_json AS BLOB)) AS repaired_settings_bytes,
              CASE WHEN length(CAST(source_settings_json AS BLOB)) <= ?
                THEN source_settings_json END AS source_settings_json,
              CASE WHEN length(CAST(repaired_settings_json AS BLOB)) <= ?
                THEN repaired_settings_json END AS repaired_settings_json
       FROM settings_repair_history WHERE id = ?`,
    )
    .get(SETTINGS_REPAIR_EVIDENCE_MAX_BYTES, SETTINGS_REPAIR_EVIDENCE_MAX_BYTES, repairId) as
    | BoundedSettingsRepairRow
    | undefined;
}

function evidenceFromBoundedRow(row: BoundedSettingsRepairRow): SettingsRepairEvidence {
  assertSettingsRepairEvidenceByteCount(
    row.source_settings_bytes,
    'Stored settings repair evidence',
  );
  assertSettingsRepairEvidenceByteCount(
    row.repaired_settings_bytes,
    'Repaired settings repair evidence',
  );
  if (row.source_settings_json === null) {
    throw new SettingsRepairRecoveryLimitError('Stored settings repair evidence');
  }
  if (row.repaired_settings_json === null) {
    throw new SettingsRepairRecoveryLimitError('Repaired settings repair evidence');
  }
  return evidenceFromRow({
    ...row,
    source_settings_json: row.source_settings_json,
    repaired_settings_json: row.repaired_settings_json,
  });
}

function summaryFromRow(row: SettingsRepairSummaryRow): SettingsRepairSummary {
  const repairedFieldPaths: unknown = JSON.parse(row.repaired_fields_json);
  return SettingsRepairSummarySchema.parse({
    id: row.id,
    repairedAt: row.repaired_at,
    sourceDatabaseVersion: row.source_database_version,
    repairedFieldPaths,
    sourceSettingsSha256: row.source_settings_sha256,
    repairedSettingsSha256: row.repaired_settings_sha256,
  });
}

function summaryFromEvidence(evidence: SettingsRepairEvidence): SettingsRepairSummary {
  return SettingsRepairSummarySchema.parse({
    id: evidence.id,
    repairedAt: evidence.repairedAt,
    sourceDatabaseVersion: evidence.sourceDatabaseVersion,
    repairedFieldPaths: evidence.repairedFieldPaths,
    sourceSettingsSha256: evidence.sourceSettingsSha256,
    repairedSettingsSha256: evidence.repairedSettingsSha256,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
