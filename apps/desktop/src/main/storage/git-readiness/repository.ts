import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import {
  DeliveryHumanApprovalRecordSchema,
  DeliveryReadinessRecordSchema,
  type DeliveryHumanApprovalRecord,
  type DeliveryReadinessRecord,
  type DeliveryReadinessTarget,
} from '../../git/readiness/contracts.js';
import { deliveryEvidenceFingerprint } from '../../git/readiness/fingerprints.js';
import {
  GIT_DELIVERY_READINESS_MAX_APPROVALS,
  gitDeliverySourceFingerprintsEqual,
} from '../../../shared/git/readiness/index.js';
import { transaction } from '../database.js';
import { parseJson } from '../values.js';
import { DELIVERY_READINESS_REQUIRED_TRIGGERS, DELIVERY_READINESS_STORAGE_SQL } from './schema.js';

export { DELIVERY_READINESS_STORAGE_SQL } from './schema.js';

interface ReadinessRow {
  readonly id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly worktree_id: string;
  readonly source_fingerprint: string;
  readonly revision: number;
  readonly value_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ApprovalRow {
  readonly id: string;
  readonly readiness_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly authority: string;
  readonly source_fingerprint: string;
  readonly evidence_fingerprint: string;
  readonly approved_at: string;
  readonly value_json: string;
}

export interface DeliveryReadinessStore {
  createDeliveryReadiness(
    record: DeliveryReadinessRecord,
    targetRecordLimit?: number,
  ): DeliveryReadinessRecord;
  replaceDeliveryReadiness(
    record: DeliveryReadinessRecord,
    expectedRevision: number,
  ): DeliveryReadinessRecord;
  getDeliveryReadiness(readinessId: string): DeliveryReadinessRecord | undefined;
  listDeliveryReadinessForTarget(
    target: DeliveryReadinessTarget,
    limit?: number,
  ): DeliveryReadinessRecord[];
  pruneDeliveryReadinessForTarget(target: DeliveryReadinessTarget, keep?: number): number;
  saveDeliveryReadinessApproval(
    approval: DeliveryHumanApprovalRecord,
    expectedReadinessRevision: number,
  ): DeliveryHumanApprovalRecord;
  getDeliveryReadinessApproval(approvalId: string): DeliveryHumanApprovalRecord | undefined;
  findDeliveryReadinessApprovalForEvidence(
    readinessId: string,
    evidenceFingerprint: string,
  ): DeliveryHumanApprovalRecord | undefined;
  listDeliveryReadinessApprovals(
    readinessId: string,
    limit?: number,
  ): DeliveryHumanApprovalRecord[];
}

export function initializeDeliveryReadinessStorage(database: DatabaseSync): void {
  database.exec(DELIVERY_READINESS_STORAGE_SQL);
}

/** SQLite implementation with CAS progress and bounded, immutable-while-retained approvals. */
export class SqliteDeliveryReadinessStore implements DeliveryReadinessStore {
  public constructor(private readonly database: DatabaseSync) {}

  public createDeliveryReadiness(
    recordValue: DeliveryReadinessRecord,
    targetRecordLimit?: number,
  ): DeliveryReadinessRecord {
    const record = DeliveryReadinessRecordSchema.parse(recordValue);
    if (record.revision !== 0)
      throw new Error('New delivery readiness must start at revision zero.');
    return transaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO delivery_readiness_records(
             id, project_id, run_id, worktree_id, source_fingerprint, revision,
             value_json, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.target.projectId,
          record.target.runId,
          record.sourceFingerprint.worktreeId,
          record.sourceFingerprint.digest,
          record.revision,
          JSON.stringify(record),
          record.createdAt,
          record.updatedAt,
        );
      if (targetRecordLimit !== undefined) {
        this.pruneDeliveryReadinessForTarget(record.target, targetRecordLimit);
      }
      return record;
    });
  }

  public replaceDeliveryReadiness(
    recordValue: DeliveryReadinessRecord,
    expectedRevision: number,
  ): DeliveryReadinessRecord {
    const record = DeliveryReadinessRecordSchema.parse(recordValue);
    if (record.revision !== expectedRevision + 1) {
      throw new Error('Delivery readiness replacement must advance exactly one revision.');
    }
    const current = this.getDeliveryReadiness(record.id);
    if (current === undefined || current.revision !== expectedRevision) {
      throw new Error('Delivery readiness changed before this update could be recorded.');
    }
    assertImmutableReadinessAuthority(current, record);
    const result = this.database
      .prepare(
        `UPDATE delivery_readiness_records
         SET project_id = ?, run_id = ?, worktree_id = ?, source_fingerprint = ?,
             revision = ?, value_json = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        record.target.projectId,
        record.target.runId,
        record.sourceFingerprint.worktreeId,
        record.sourceFingerprint.digest,
        record.revision,
        JSON.stringify(record),
        record.updatedAt,
        record.id,
        expectedRevision,
      );
    if (result.changes !== 1) {
      throw new Error('Delivery readiness changed before this update could be recorded.');
    }
    return record;
  }

  public getDeliveryReadiness(readinessId: string): DeliveryReadinessRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM delivery_readiness_records WHERE id = ?')
      .get(readinessId) as ReadinessRow | undefined;
    return row === undefined ? undefined : readinessFromRow(row);
  }

  public listDeliveryReadinessForTarget(
    target: DeliveryReadinessTarget,
    limit = 20,
  ): DeliveryReadinessRecord[] {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const rows = this.database
      .prepare(
        `SELECT * FROM delivery_readiness_records
         WHERE project_id = ? AND run_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(target.projectId, target.runId, boundedLimit) as unknown as ReadinessRow[];
    return rows.map(readinessFromRow);
  }

  public pruneDeliveryReadinessForTarget(target: DeliveryReadinessTarget, keep = 32): number {
    const boundedKeep = Math.max(1, Math.min(1_000, Math.trunc(keep)));
    const result = this.database
      .prepare(
        `DELETE FROM delivery_readiness_records
         WHERE id IN (
           SELECT id FROM delivery_readiness_records
           WHERE project_id = ? AND run_id = ?
           ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(target.projectId, target.runId, boundedKeep);
    return Number(result.changes);
  }

  public saveDeliveryReadinessApproval(
    approvalValue: DeliveryHumanApprovalRecord,
    expectedReadinessRevision: number,
  ): DeliveryHumanApprovalRecord {
    const approval = DeliveryHumanApprovalRecordSchema.parse(approvalValue);
    if (!Number.isInteger(expectedReadinessRevision) || expectedReadinessRevision < 0) {
      throw new Error('The expected delivery readiness revision is invalid.');
    }
    return transaction(this.database, () => {
      const readiness = this.getDeliveryReadiness(approval.readinessId);
      if (readiness === undefined)
        throw new Error('The approved delivery readiness does not exist.');
      if (readiness.revision !== expectedReadinessRevision) {
        throw new Error('Delivery readiness changed before human approval could be recorded.');
      }
      if (
        readiness.target.projectId !== approval.target.projectId ||
        readiness.target.runId !== approval.target.runId ||
        !gitDeliverySourceFingerprintsEqual(readiness.sourceFingerprint, approval.sourceFingerprint)
      ) {
        throw new Error('The human approval does not match its delivery readiness source.');
      }
      if (approval.evidenceFingerprint !== deliveryEvidenceFingerprint(readiness)) {
        throw new Error('The human approval does not match the current delivery check evidence.');
      }
      this.database
        .prepare(
          `INSERT INTO delivery_readiness_approvals(
             id, readiness_id, project_id, run_id, authority, source_fingerprint,
             evidence_fingerprint, approved_at, value_json
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          approval.id,
          approval.readinessId,
          approval.target.projectId,
          approval.target.runId,
          approval.authority,
          approval.sourceFingerprint.digest,
          approval.evidenceFingerprint,
          approval.approvedAt,
          JSON.stringify(approval),
        );
      this.#pruneDeliveryReadinessApprovalHistory(approval.readinessId, approval.id);
      return approval;
    });
  }

  /**
   * Keep the approval just accepted for the current evidence plus the newest bounded history.
   * The explicit ID exception matters when timestamps collide and the current UUID sorts below
   * stale rows; renderer view limits alone would otherwise leave physical storage unbounded.
   */
  #pruneDeliveryReadinessApprovalHistory(readinessId: string, currentApprovalId: string): void {
    this.database
      .prepare(
        `DELETE FROM delivery_readiness_approvals
         WHERE readiness_id = ? AND id <> ? AND id NOT IN (
           SELECT id FROM delivery_readiness_approvals
           WHERE readiness_id = ? AND id <> ?
           ORDER BY approved_at DESC, id DESC LIMIT ?
         )`,
      )
      .run(
        readinessId,
        currentApprovalId,
        readinessId,
        currentApprovalId,
        GIT_DELIVERY_READINESS_MAX_APPROVALS - 1,
      );
  }

  public getDeliveryReadinessApproval(approvalId: string): DeliveryHumanApprovalRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM delivery_readiness_approvals WHERE id = ?')
      .get(approvalId) as ApprovalRow | undefined;
    return row === undefined ? undefined : approvalFromRow(row);
  }

  public findDeliveryReadinessApprovalForEvidence(
    readinessId: string,
    evidenceFingerprint: string,
  ): DeliveryHumanApprovalRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM delivery_readiness_approvals
         WHERE readiness_id = ? AND evidence_fingerprint = ? LIMIT 1`,
      )
      .get(readinessId, evidenceFingerprint) as ApprovalRow | undefined;
    return row === undefined ? undefined : approvalFromRow(row);
  }

  public listDeliveryReadinessApprovals(
    readinessId: string,
    limit = GIT_DELIVERY_READINESS_MAX_APPROVALS,
  ): DeliveryHumanApprovalRecord[] {
    const boundedLimit = Math.max(
      1,
      Math.min(GIT_DELIVERY_READINESS_MAX_APPROVALS, Math.trunc(limit)),
    );
    const rows = this.database
      .prepare(
        `SELECT * FROM delivery_readiness_approvals
         WHERE readiness_id = ? ORDER BY approved_at DESC, id DESC LIMIT ?`,
      )
      .all(readinessId, boundedLimit) as unknown as ApprovalRow[];
    return rows.map(approvalFromRow);
  }
}

/** Returns semantic or policy failures for root database integrity reporting. */
export function deliveryReadinessIntegrityMessages(database: DatabaseSync): string[] {
  const messages: string[] = [];
  const readinessRows = database
    .prepare('SELECT * FROM delivery_readiness_records ORDER BY id')
    .all() as unknown as ReadinessRow[];
  const readinessById = new Map<string, DeliveryReadinessRecord>();
  readinessRows.forEach((row, index) => {
    try {
      const readiness = readinessFromRow(row);
      readinessById.set(readiness.id, readiness);
    } catch (error) {
      messages.push(`delivery_readiness_records row ${String(index + 1)}: ${errorMessage(error)}`);
    }
  });
  const approvalRows = database
    .prepare('SELECT * FROM delivery_readiness_approvals ORDER BY id')
    .all() as unknown as ApprovalRow[];
  approvalRows.forEach((row, index) => {
    try {
      const approval = approvalFromRow(row);
      const readiness = readinessById.get(approval.readinessId);
      if (
        readiness === undefined ||
        readiness.target.projectId !== approval.target.projectId ||
        readiness.target.runId !== approval.target.runId ||
        !gitDeliverySourceFingerprintsEqual(readiness.sourceFingerprint, approval.sourceFingerprint)
      ) {
        throw new Error('approval does not belong to its stored readiness source');
      }
    } catch (error) {
      messages.push(
        `delivery_readiness_approvals row ${String(index + 1)}: ${errorMessage(error)}`,
      );
    }
  });
  const triggers = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name LIKE 'delivery_readiness_%'`,
    )
    .all() as unknown as { name: string }[];
  const triggerNames = new Set(triggers.map((row) => row.name));
  for (const trigger of DELIVERY_READINESS_REQUIRED_TRIGGERS) {
    if (!triggerNames.has(trigger))
      messages.push(`Delivery readiness trigger ${trigger} is missing.`);
  }
  return messages;
}

function readinessFromRow(row: ReadinessRow): DeliveryReadinessRecord {
  const record = DeliveryReadinessRecordSchema.parse(parseJson(row.value_json));
  if (
    record.id !== row.id ||
    record.target.projectId !== row.project_id ||
    record.target.runId !== row.run_id ||
    record.sourceFingerprint.worktreeId !== row.worktree_id ||
    record.sourceFingerprint.digest !== row.source_fingerprint ||
    record.revision !== row.revision ||
    record.createdAt !== row.created_at ||
    record.updatedAt !== row.updated_at
  ) {
    throw new Error('Delivery readiness indexed columns do not match its authoritative record.');
  }
  return record;
}

function approvalFromRow(row: ApprovalRow): DeliveryHumanApprovalRecord {
  const approval = DeliveryHumanApprovalRecordSchema.parse(parseJson(row.value_json));
  if (
    approval.id !== row.id ||
    approval.readinessId !== row.readiness_id ||
    approval.target.projectId !== row.project_id ||
    approval.target.runId !== row.run_id ||
    approval.authority !== row.authority ||
    approval.sourceFingerprint.digest !== row.source_fingerprint ||
    approval.evidenceFingerprint !== row.evidence_fingerprint ||
    approval.approvedAt !== row.approved_at
  ) {
    throw new Error('Delivery readiness approval indexes do not match its authoritative record.');
  }
  return approval;
}

function assertImmutableReadinessAuthority(
  current: DeliveryReadinessRecord,
  replacement: DeliveryReadinessRecord,
): void {
  const authority = (record: DeliveryReadinessRecord) => ({
    schemaVersion: record.schemaVersion,
    id: record.id,
    target: record.target,
    sourceFingerprint: record.sourceFingerprint,
    sourceBranch: record.sourceBranch,
    baseCommit: record.baseCommit,
    availableChecks: record.availableChecks,
    requiredChecks: record.requiredChecks.map((check) => ({
      checkId: check.checkId,
      label: check.label,
      kind: check.kind,
      configurationDigest: check.configurationDigest,
      command: check.command,
      resolvedCommand: check.resolvedCommand,
    })),
    createdAt: record.createdAt,
  });
  if (!isDeepStrictEqual(authority(current), authority(replacement))) {
    throw new Error('Delivery readiness source and check authority are immutable after prepare.');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
