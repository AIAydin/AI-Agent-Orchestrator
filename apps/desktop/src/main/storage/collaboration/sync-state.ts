import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import {
  CollaborationMetadataSnapshotSchema,
  CollaborationCommentMetadataSchema,
  CollaborationServerUrlSchema,
  CollaborationSyncRecoverySchema,
  CollaborationRoomIdSchema,
  CollaborationSubjectSchema,
  collaborationCommentMetadataEquals,
  collaborationRecoveryCanCheckpoint,
  serializeCollaborationMetadataSnapshot,
  type CollaborationCommentMetadata,
  type CollaborationMetadataSnapshot,
  type CollaborationSyncRecovery,
} from '../../../shared/collaboration/index.js';
import { transaction } from '../database.js';
import {
  deleteRejectedCommentDismissals,
  extendRejectedCommentDismissalExpiry,
  pruneExpiredRejectedCommentDismissals,
  recordRejectedCommentDismissal,
  rejectedCommentDismissalIntegrityMessages,
  rejectedCommentDismissalOverlay,
  type RejectedCommentStorageEntry,
} from './rejected-comment-dismissals.js';

export const COLLABORATION_SYNC_MAX_SNAPSHOT_BYTES = 8_388_608;
export const COLLABORATION_SYNC_MAX_ROWS_PER_PROJECT = 32;
export const COLLABORATION_SYNC_MAX_DELIVERIES_PER_SCOPE = 256;
export const COLLABORATION_SYNC_MAX_DELIVERY_BYTES_PER_SCOPE = 16_777_216;
export const COLLABORATION_SYNC_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface CollaborationSyncStorageScope {
  readonly projectId: string;
  readonly canvasId: string;
  readonly serverUrl: string;
  readonly roomId: string;
  readonly subject: string;
}

interface SyncRow {
  readonly baseline_json: string | null;
  readonly pending_json: string;
  readonly delivery_id: string | null;
  readonly snapshot_digest: string | null;
  readonly disposition: CollaborationSyncRecovery['disposition'];
  readonly expires_at: string;
}

interface DeliveryRow {
  readonly sequence: number;
  readonly delivery_id: string;
  readonly baseline_json: string | null;
  readonly candidate_json: string;
  readonly snapshot_digest: string;
  readonly disposition: 'sent' | 'queued-offline' | 'acknowledged' | 'rejected';
  readonly expires_at: string;
}

const StorageScopeSchema = z
  .object({
    projectId: z.string().uuid(),
    canvasId: z.string().uuid(),
    serverUrl: CollaborationServerUrlSchema,
    roomId: CollaborationRoomIdSchema,
    subject: CollaborationSubjectSchema,
  })
  .strict();

export function recoverCollaborationSyncState(
  database: DatabaseSync,
  rawScope: CollaborationSyncStorageScope,
  now = new Date(),
): CollaborationSyncRecovery | null {
  const scope = StorageScopeSchema.parse(rawScope);
  pruneExpiredCollaborationSyncStates(database, now);
  const row = database
    .prepare(
      `SELECT baseline_json, pending_json, delivery_id, snapshot_digest, disposition, expires_at
       FROM collaboration_sync_states
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
    )
    .get(scope.projectId, scope.canvasId, scope.serverUrl, scope.roomId, scope.subject) as
    | SyncRow
    | undefined;
  if (row === undefined) return null;
  const rejected = activeRejectedCommentState(database, scope);
  return CollaborationSyncRecoverySchema.parse({
    baseline: parseSnapshot(row.baseline_json),
    pending: parseSnapshot(row.pending_json),
    ...(row.delivery_id === null ? {} : { deliveryId: row.delivery_id }),
    ...(row.snapshot_digest === null ? {} : { snapshotDigest: row.snapshot_digest }),
    disposition: row.disposition,
    rejectedCommentIds: rejected.entries.map((entry) => entry.comment.id),
    rejectedComments: rejected.entries.map((entry) => entry.comment),
    rejectedCommentEntries: rejected.entries.map((entry) => ({
      comment: entry.comment,
      rejectedDeliveryId: entry.rejectedDeliveryId,
    })),
    dismissedRejectedComments: rejected.dismissedComments,
    dismissedRejectedCommentEntries: rejected.dismissedEntries.map((entry) => ({
      comment: entry.comment,
      rejectedDeliveryId: entry.rejectedDeliveryId,
    })),
    expiresAt: row.expires_at,
  });
}

export function stageCollaborationSyncState(
  database: DatabaseSync,
  rawScope: CollaborationSyncStorageScope,
  baseline: CollaborationMetadataSnapshot | null,
  pending: CollaborationMetadataSnapshot,
  now = new Date(),
): CollaborationSyncRecovery {
  const scope = StorageScopeSchema.parse(rawScope);
  const parsedBaseline =
    baseline === null ? null : CollaborationMetadataSnapshotSchema.parse(baseline);
  const parsedPending = CollaborationMetadataSnapshotSchema.parse(pending);
  assertCanvasMatches(scope.canvasId, parsedBaseline);
  assertCanvasMatches(scope.canvasId, parsedPending);
  const baselineJson = parsedBaseline === null ? null : boundedSnapshotJson(parsedBaseline);
  const pendingJson = boundedSnapshotJson(parsedPending);
  pruneExpiredCollaborationSyncStates(database, now);
  enforceProjectQuota(database, scope);
  const updatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + COLLABORATION_SYNC_TTL_MS).toISOString();
  database
    .prepare(
      `INSERT INTO collaboration_sync_states(
         project_id, canvas_id, server_url, room_id, subject, baseline_json, pending_json,
         delivery_id, snapshot_digest, disposition, updated_at, expires_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'staged', ?, ?)
       ON CONFLICT(project_id, canvas_id, server_url, room_id, subject) DO UPDATE SET
         baseline_json = excluded.baseline_json,
         pending_json = excluded.pending_json,
         delivery_id = NULL,
         snapshot_digest = NULL,
         disposition = 'staged',
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
    )
    .run(
      scope.projectId,
      scope.canvasId,
      scope.serverUrl,
      scope.roomId,
      scope.subject,
      baselineJson,
      pendingJson,
      updatedAt,
      expiresAt,
    );
  extendRejectedCommentDismissalExpiry(database, scope, expiresAt);
  return requiredRecovery(database, scope, now);
}

export function checkpointCollaborationSyncState(
  database: DatabaseSync,
  rawScope: CollaborationSyncStorageScope,
  snapshot: CollaborationMetadataSnapshot,
  now = new Date(),
): CollaborationSyncRecovery {
  const scope = StorageScopeSchema.parse(rawScope);
  const parsedSnapshot = CollaborationMetadataSnapshotSchema.parse(snapshot);
  assertCanvasMatches(scope.canvasId, parsedSnapshot);
  return transaction(database, () => {
    const recovery = recoverCollaborationSyncState(database, scope, now);
    if ((recovery?.rejectedCommentEntries?.length ?? 0) > 0) {
      throw new Error('Rejected collaboration comments cannot be checkpointed away.');
    }
    if (recovery !== null && !collaborationRecoveryCanCheckpoint(recovery, parsedSnapshot)) {
      throw new Error('Unresolved collaboration intent cannot be checkpointed away.');
    }
    stageCollaborationSyncState(database, scope, parsedSnapshot, parsedSnapshot, now);
    deleteDeliveryLedger(database, scope);
    deleteRejectedCommentDismissals(database, scope);
    database
      .prepare(
        `UPDATE collaboration_sync_states
         SET disposition = 'synchronized'
         WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
      )
      .run(scope.projectId, scope.canvasId, scope.serverUrl, scope.roomId, scope.subject);
    return requiredRecovery(database, scope, now);
  });
}

export function discardRejectedCollaborationComment(
  database: DatabaseSync,
  rawScope: CollaborationSyncStorageScope,
  rawComment: CollaborationCommentMetadata,
  rejectedDeliveryId: string,
  now = new Date(),
): CollaborationSyncRecovery {
  const scope = StorageScopeSchema.parse(rawScope);
  const comment = CollaborationCommentMetadataSchema.parse(rawComment);
  return transaction(database, () => {
    pruneExpiredCollaborationSyncStates(database, now);
    const row = database
      .prepare(
        `SELECT expires_at FROM collaboration_sync_states
         WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
      )
      .get(scope.projectId, scope.canvasId, scope.serverUrl, scope.roomId, scope.subject) as
      | { expires_at: string }
      | undefined;
    if (row === undefined) {
      throw new Error('The rejected collaboration comment is no longer retained locally.');
    }
    const entries = recoverRejectedCommentEntries(database, scope);
    recordRejectedCommentDismissal(
      database,
      scope,
      comment,
      rejectedDeliveryId,
      entries,
      row.expires_at,
      now,
    );
    return requiredRecovery(database, scope, now);
  });
}

export function recordCollaborationSyncDelivery(
  database: DatabaseSync,
  rawScope: CollaborationSyncStorageScope,
  rawInput: CollaborationDeliveryStorageInput,
  now = new Date(),
): void {
  const scope = StorageScopeSchema.parse(rawScope);
  const input = CollaborationDeliveryStorageInputSchema.parse(rawInput);
  transaction(database, () => recordDelivery(database, scope, input, now));
}

export interface CollaborationDeliveryStorageInput {
  readonly deliveryId: string;
  readonly snapshotDigest: string;
  readonly disposition: 'sent' | 'queued-offline';
}

const CollaborationDeliveryStorageInputSchema = z
  .object({
    deliveryId: z.string().uuid(),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    disposition: z.enum(['sent', 'queued-offline']),
  })
  .strict();

/** Atomically stages the exact candidate and binds its durable delivery identity. */
export function stageCollaborationSyncDelivery(
  database: DatabaseSync,
  rawScope: CollaborationSyncStorageScope,
  baseline: CollaborationMetadataSnapshot | null,
  pending: CollaborationMetadataSnapshot,
  rawInput: CollaborationDeliveryStorageInput,
  now = new Date(),
): CollaborationSyncRecovery {
  const scope = StorageScopeSchema.parse(rawScope);
  const input = CollaborationDeliveryStorageInputSchema.parse(rawInput);
  return transaction(database, () => {
    stageCollaborationSyncState(database, scope, baseline, pending, now);
    recordDelivery(database, scope, input, now);
    return requiredRecovery(database, scope, now);
  });
}

export function settleCollaborationSyncDelivery(
  database: DatabaseSync,
  deliveryId: string,
  disposition: 'acknowledged' | 'rejected',
  now = new Date(),
): void {
  const parsedDeliveryId = z.string().uuid().parse(deliveryId);
  const parsedDisposition = z.enum(['acknowledged', 'rejected']).parse(disposition);
  transaction(database, () => {
    const ledger = database
      .prepare(
        `SELECT project_id, canvas_id, server_url, room_id, subject
         FROM collaboration_sync_deliveries WHERE delivery_id = ?`,
      )
      .get(parsedDeliveryId) as
      | {
          project_id: string;
          canvas_id: string;
          server_url: string;
          room_id: string;
          subject: string;
        }
      | undefined;
    if (ledger === undefined) {
      // Migration-11 rows have no per-delivery ledger. Preserve their legacy settlement path.
      database
        .prepare(`UPDATE collaboration_sync_states SET disposition = ? WHERE delivery_id = ?`)
        .run(parsedDisposition, parsedDeliveryId);
      return;
    }
    const updated = database
      .prepare(`UPDATE collaboration_sync_deliveries SET disposition = ? WHERE delivery_id = ?`)
      .run(parsedDisposition, parsedDeliveryId);
    if (updated.changes !== 1) {
      throw new Error('The collaboration delivery settlement could not be recorded.');
    }
    projectDeliveryLedger(
      database,
      StorageScopeSchema.parse({
        projectId: ledger.project_id,
        canvasId: ledger.canvas_id,
        serverUrl: ledger.server_url,
        roomId: ledger.room_id,
        subject: ledger.subject,
      }),
      now,
    );
  });
}

function recordDelivery(
  database: DatabaseSync,
  scope: CollaborationSyncStorageScope,
  input: z.infer<typeof CollaborationDeliveryStorageInputSchema>,
  now: Date,
): void {
  const staged = database
    .prepare(
      `SELECT baseline_json, pending_json, expires_at FROM collaboration_sync_states
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
    )
    .get(scope.projectId, scope.canvasId, scope.serverUrl, scope.roomId, scope.subject) as
    | { baseline_json: string | null; pending_json: string; expires_at: string }
    | undefined;
  if (staged === undefined) {
    throw new Error('The collaboration delivery has no staged durable recovery record.');
  }
  const candidate = parseSnapshot(staged.pending_json);
  if (candidate === null) throw new Error('The collaboration delivery candidate is missing.');
  assertCanvasMatches(scope.canvasId, candidate);
  const candidateJson = boundedSnapshotJson(candidate);
  const candidateDigest = createHash('sha256').update(candidateJson).digest('hex');
  if (candidateDigest !== input.snapshotDigest) {
    throw new Error('The collaboration delivery digest does not match its durable candidate.');
  }
  // The scope row has a sliding inactivity TTL. Keep the exact settlement prefix alive for the
  // same interval so pruning can never discard the acknowledged baseline needed by newer rows.
  database
    .prepare(
      `UPDATE collaboration_sync_deliveries SET expires_at = ?
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
    )
    .run(
      staged.expires_at,
      scope.projectId,
      scope.canvasId,
      scope.serverUrl,
      scope.roomId,
      scope.subject,
    );
  const baselineBytes =
    staged.baseline_json === null ? 0 : Buffer.byteLength(staged.baseline_json, 'utf8');
  enforceDeliveryLedgerQuota(
    database,
    scope,
    baselineBytes + Buffer.byteLength(candidateJson, 'utf8'),
  );
  database
    .prepare(
      `INSERT INTO collaboration_sync_deliveries(
         delivery_id, project_id, canvas_id, server_url, room_id, subject, baseline_json,
         candidate_json, snapshot_digest, disposition, created_at, expires_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.deliveryId,
      scope.projectId,
      scope.canvasId,
      scope.serverUrl,
      scope.roomId,
      scope.subject,
      staged.baseline_json,
      candidateJson,
      input.snapshotDigest,
      input.disposition,
      now.toISOString(),
      staged.expires_at,
    );
  const result = database
    .prepare(
      `UPDATE collaboration_sync_states
       SET delivery_id = ?, snapshot_digest = ?, disposition = ?, updated_at = ?
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
    )
    .run(
      input.deliveryId,
      input.snapshotDigest,
      input.disposition,
      now.toISOString(),
      scope.projectId,
      scope.canvasId,
      scope.serverUrl,
      scope.roomId,
      scope.subject,
    );
  if (result.changes !== 1) {
    throw new Error('The collaboration delivery has no staged durable recovery record.');
  }
  projectDeliveryLedger(database, scope, now);
}

function projectDeliveryLedger(
  database: DatabaseSync,
  scope: CollaborationSyncStorageScope,
  now: Date,
): void {
  const current = database
    .prepare(
      `SELECT 1 AS present FROM collaboration_sync_states
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
    )
    .get(scope.projectId, scope.canvasId, scope.serverUrl, scope.roomId, scope.subject) as
    | { present: number }
    | undefined;
  if (current === undefined) {
    throw new Error('The collaboration delivery scope no longer has recovery state.');
  }
  const deliveries = database
    .prepare(
      `SELECT sequence, delivery_id, baseline_json, candidate_json, snapshot_digest, disposition,
              expires_at
       FROM collaboration_sync_deliveries
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?
       ORDER BY sequence`,
    )
    .all(
      scope.projectId,
      scope.canvasId,
      scope.serverUrl,
      scope.roomId,
      scope.subject,
    ) as unknown as DeliveryRow[];
  const latest = deliveries.at(-1);
  if (latest === undefined) return;
  const latestAcknowledged = deliveries.findLast(
    (delivery) => delivery.disposition === 'acknowledged',
  );
  const baselineJson = latestAcknowledged?.candidate_json ?? deliveries[0]?.baseline_json ?? null;
  const projected = latestAcknowledged?.sequence === latest.sequence ? latestAcknowledged : latest;
  parseSnapshot(baselineJson);
  parseSnapshot(projected.candidate_json);
  database
    .prepare(
      `UPDATE collaboration_sync_states
       SET baseline_json = ?, pending_json = ?, delivery_id = ?, snapshot_digest = ?,
           disposition = ?, updated_at = ?, expires_at = ?
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
    )
    .run(
      baselineJson,
      projected.candidate_json,
      projected.delivery_id,
      projected.snapshot_digest,
      projected.disposition,
      now.toISOString(),
      projected.expires_at,
      scope.projectId,
      scope.canvasId,
      scope.serverUrl,
      scope.roomId,
      scope.subject,
    );
}

function enforceDeliveryLedgerQuota(
  database: DatabaseSync,
  scope: CollaborationSyncStorageScope,
  deliveryBytes: number,
): void {
  const totals = database
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(
                length(CAST(candidate_json AS BLOB)) +
                COALESCE(length(CAST(baseline_json AS BLOB)), 0)
              ), 0) AS bytes
       FROM collaboration_sync_deliveries
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
    )
    .get(scope.projectId, scope.canvasId, scope.serverUrl, scope.roomId, scope.subject) as {
    count: number;
    bytes: number;
  };
  if (totals.count >= COLLABORATION_SYNC_MAX_DELIVERIES_PER_SCOPE) {
    throw new Error(
      'This collaboration session is waiting for too many durable delivery settlements.',
    );
  }
  if (totals.bytes + deliveryBytes > COLLABORATION_SYNC_MAX_DELIVERY_BYTES_PER_SCOPE) {
    throw new Error('This collaboration session has reached its durable delivery byte limit.');
  }
}

function deleteDeliveryLedger(database: DatabaseSync, scope: CollaborationSyncStorageScope): void {
  database
    .prepare(
      `DELETE FROM collaboration_sync_deliveries
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
    )
    .run(scope.projectId, scope.canvasId, scope.serverUrl, scope.roomId, scope.subject);
}

export function pruneExpiredCollaborationSyncStates(
  database: DatabaseSync,
  now = new Date(),
): number {
  const expiredDismissals = pruneExpiredRejectedCommentDismissals(database, now);
  const expiredDeliveries = Number(
    database
      .prepare('DELETE FROM collaboration_sync_deliveries WHERE expires_at <= ?')
      .run(now.toISOString()).changes,
  );
  const expiredStates = Number(
    database
      .prepare('DELETE FROM collaboration_sync_states WHERE expires_at <= ?')
      .run(now.toISOString()).changes,
  );
  return expiredDismissals + expiredDeliveries + expiredStates;
}

export function collaborationSyncIntegrityMessages(database: DatabaseSync): string[] {
  const rows = database
    .prepare(
      `SELECT project_id, canvas_id, server_url, room_id, subject, baseline_json, pending_json,
              delivery_id, snapshot_digest, disposition, expires_at
       FROM collaboration_sync_states`,
    )
    .all() as unknown as Array<
    SyncRow & {
      project_id: string;
      canvas_id: string;
      server_url: string;
      room_id: string;
      subject: string;
    }
  >;
  const stateMessages = rows.flatMap((row, index) => {
    try {
      const scope = StorageScopeSchema.parse({
        projectId: row.project_id,
        canvasId: row.canvas_id,
        serverUrl: row.server_url,
        roomId: row.room_id,
        subject: row.subject,
      });
      const rejected = activeRejectedCommentState(database, scope);
      const recovery = CollaborationSyncRecoverySchema.parse({
        baseline: parseSnapshot(row.baseline_json),
        pending: parseSnapshot(row.pending_json),
        ...(row.delivery_id === null ? {} : { deliveryId: row.delivery_id }),
        ...(row.snapshot_digest === null ? {} : { snapshotDigest: row.snapshot_digest }),
        disposition: row.disposition,
        rejectedCommentIds: rejected.entries.map((entry) => entry.comment.id),
        rejectedComments: rejected.entries.map((entry) => entry.comment),
        rejectedCommentEntries: rejected.entries.map((entry) => ({
          comment: entry.comment,
          rejectedDeliveryId: entry.rejectedDeliveryId,
        })),
        dismissedRejectedComments: rejected.dismissedComments,
        dismissedRejectedCommentEntries: rejected.dismissedEntries.map((entry) => ({
          comment: entry.comment,
          rejectedDeliveryId: entry.rejectedDeliveryId,
        })),
        expiresAt: row.expires_at,
      });
      assertCanvasMatches(scope.canvasId, recovery.baseline);
      assertCanvasMatches(scope.canvasId, recovery.pending);
      return collaborationProjectionIntegrityMessages(database, scope, row);
    } catch (error) {
      return [
        `collaboration_sync_states row ${index + 1}: ${
          error instanceof Error ? error.message : 'invalid recovery record'
        }`,
      ];
    }
  });
  const deliveries = database
    .prepare(
      `SELECT sequence, delivery_id, project_id, canvas_id, server_url, room_id, subject,
              baseline_json, candidate_json, snapshot_digest, disposition, expires_at
       FROM collaboration_sync_deliveries ORDER BY sequence`,
    )
    .all() as unknown as Array<
    DeliveryRow & {
      project_id: string;
      canvas_id: string;
      server_url: string;
      room_id: string;
      subject: string;
    }
  >;
  const deliveryMessages = deliveries.flatMap((row, index) => {
    try {
      if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) {
        throw new Error('invalid delivery sequence');
      }
      const scope = StorageScopeSchema.parse({
        projectId: row.project_id,
        canvasId: row.canvas_id,
        serverUrl: row.server_url,
        roomId: row.room_id,
        subject: row.subject,
      });
      z.string().uuid().parse(row.delivery_id);
      z.enum(['sent', 'queued-offline', 'acknowledged', 'rejected']).parse(row.disposition);
      z.string().datetime({ offset: true }).parse(row.expires_at);
      const baseline = parseSnapshot(row.baseline_json);
      const candidate = parseSnapshot(row.candidate_json);
      if (candidate === null) throw new Error('missing delivery candidate');
      assertCanvasMatches(scope.canvasId, baseline);
      assertCanvasMatches(scope.canvasId, candidate);
      const digest = createHash('sha256').update(row.candidate_json).digest('hex');
      if (digest !== row.snapshot_digest) throw new Error('delivery digest mismatch');
      return [];
    } catch (error) {
      return [
        `collaboration_sync_deliveries row ${index + 1}: ${
          error instanceof Error ? error.message : 'invalid delivery record'
        }`,
      ];
    }
  });
  return [
    ...stateMessages,
    ...deliveryMessages,
    ...rejectedCommentDismissalIntegrityMessages(database),
  ];
}

function collaborationProjectionIntegrityMessages(
  database: DatabaseSync,
  scope: CollaborationSyncStorageScope,
  state: SyncRow,
): string[] {
  const deliveries = database
    .prepare(
      `SELECT sequence, delivery_id, baseline_json, candidate_json, snapshot_digest, disposition,
              expires_at
       FROM collaboration_sync_deliveries
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?
       ORDER BY sequence`,
    )
    .all(
      scope.projectId,
      scope.canvasId,
      scope.serverUrl,
      scope.roomId,
      scope.subject,
    ) as unknown as DeliveryRow[];
  const deliveredDisposition =
    state.disposition === 'sent' ||
    state.disposition === 'queued-offline' ||
    state.disposition === 'acknowledged' ||
    state.disposition === 'rejected';
  if (deliveries.length === 0) {
    return deliveredDisposition || state.delivery_id !== null || state.snapshot_digest !== null
      ? ['collaboration sync projection: delivered state has no exact delivery ledger row']
      : [];
  }
  const latest = deliveries.at(-1);
  if (latest === undefined) return ['collaboration sync projection: missing latest delivery'];
  const latestAcknowledged = deliveries.findLast(
    (delivery) => delivery.disposition === 'acknowledged',
  );
  const projected = latestAcknowledged?.sequence === latest.sequence ? latestAcknowledged : latest;
  const expectedBaseline =
    latestAcknowledged?.candidate_json ?? deliveries[0]?.baseline_json ?? null;
  const messages: string[] = [];
  if (state.delivery_id !== projected.delivery_id) {
    messages.push('collaboration sync projection: state delivery identity does not match ledger');
  }
  if (state.snapshot_digest !== projected.snapshot_digest) {
    messages.push('collaboration sync projection: state digest does not match ledger');
  }
  if (state.disposition !== projected.disposition) {
    messages.push('collaboration sync projection: state disposition does not match ledger');
  }
  if (!snapshotJsonEquals(state.pending_json, projected.candidate_json)) {
    messages.push('collaboration sync projection: pending candidate does not match ledger');
  }
  if (!snapshotJsonEquals(state.baseline_json, expectedBaseline)) {
    messages.push('collaboration sync projection: acknowledged baseline does not match ledger');
  }
  return messages;
}

function snapshotJsonEquals(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const leftSnapshot = parseSnapshot(left);
  const rightSnapshot = parseSnapshot(right);
  return (
    leftSnapshot !== null &&
    rightSnapshot !== null &&
    serializeCollaborationMetadataSnapshot(leftSnapshot) ===
      serializeCollaborationMetadataSnapshot(rightSnapshot)
  );
}

function activeRejectedCommentState(
  database: DatabaseSync,
  scope: CollaborationSyncStorageScope,
): {
  readonly entries: RejectedCommentStorageEntry[];
  readonly dismissedEntries: RejectedCommentStorageEntry[];
  readonly dismissedComments: CollaborationCommentMetadata[];
} {
  const overlay = rejectedCommentDismissalOverlay(
    database,
    scope,
    recoverRejectedCommentEntries(database, scope),
  );
  return {
    entries: overlay.rejectedEntries,
    dismissedEntries: overlay.dismissedEntries,
    dismissedComments: overlay.dismissedComments,
  };
}

/** Returns the latest rejected local comment values and their exact durable delivery origins. */
function recoverRejectedCommentEntries(
  database: DatabaseSync,
  scope: CollaborationSyncStorageScope,
): RejectedCommentStorageEntry[] {
  const deliveries = database
    .prepare(
      `SELECT sequence, delivery_id, baseline_json, candidate_json, disposition
       FROM collaboration_sync_deliveries
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?
       ORDER BY sequence`,
    )
    .all(
      scope.projectId,
      scope.canvasId,
      scope.serverUrl,
      scope.roomId,
      scope.subject,
    ) as unknown as Array<
    Pick<
      DeliveryRow,
      'sequence' | 'delivery_id' | 'baseline_json' | 'candidate_json' | 'disposition'
    >
  >;
  const acknowledgedThroughByCommentValue = new Map<string, Map<string, number>>();
  for (const delivery of deliveries) {
    if (delivery.disposition !== 'acknowledged') continue;
    const comments = parseSnapshot(delivery.candidate_json)?.comments ?? {};
    for (const comment of Object.values(comments)) {
      const sequences =
        acknowledgedThroughByCommentValue.get(comment.id) ?? new Map<string, number>();
      sequences.set(commentValueKey(comment), delivery.sequence);
      acknowledgedThroughByCommentValue.set(comment.id, sequences);
    }
  }
  const rejected = new Map<string, RejectedCommentStorageEntry>();
  let latestAcknowledgedComments: Readonly<Record<string, CollaborationCommentMetadata>> = {};
  for (const delivery of deliveries) {
    if (delivery.disposition === 'acknowledged') {
      latestAcknowledgedComments = parseSnapshot(delivery.candidate_json)?.comments ?? {};
      continue;
    }
    if (delivery.disposition !== 'rejected') continue;
    const baseline = parseSnapshot(delivery.baseline_json);
    const candidate = parseSnapshot(delivery.candidate_json);
    if (candidate === null) throw new Error('The collaboration delivery candidate is missing.');
    for (const comment of Object.values(candidate.comments)) {
      const exactlyAcknowledgedBefore = collaborationCommentMetadataEquals(
        latestAcknowledgedComments[comment.id],
        comment,
      );
      const exactlyAcknowledgedAfter =
        (acknowledgedThroughByCommentValue.get(comment.id)?.get(commentValueKey(comment)) ?? 0) >
        delivery.sequence;
      if (
        baseline?.comments[comment.id] === undefined &&
        !exactlyAcknowledgedBefore &&
        !exactlyAcknowledgedAfter &&
        comment.authorId === scope.subject
      ) {
        rejected.set(comment.id, {
          comment,
          rejectedDeliveryId: delivery.delivery_id,
          rejectedThroughSequence: delivery.sequence,
        });
      }
    }
  }
  return [...rejected.values()];
}

function commentValueKey(comment: CollaborationCommentMetadata): string {
  return JSON.stringify(CollaborationCommentMetadataSchema.parse(comment));
}

function enforceProjectQuota(database: DatabaseSync, scope: CollaborationSyncStorageScope): void {
  const existing = database
    .prepare(
      `SELECT 1 FROM collaboration_sync_states
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
    )
    .get(scope.projectId, scope.canvasId, scope.serverUrl, scope.roomId, scope.subject);
  if (existing !== undefined) return;
  const row = database
    .prepare('SELECT COUNT(*) AS count FROM collaboration_sync_states WHERE project_id = ?')
    .get(scope.projectId) as { count: number };
  if (row.count < COLLABORATION_SYNC_MAX_ROWS_PER_PROJECT) return;
  throw new Error(
    'This project has reached the retained collaboration recovery limit. Rejoin an existing room or clear local data before adding another room identity.',
  );
}

function boundedSnapshotJson(snapshot: CollaborationMetadataSnapshot): string {
  const value = serializeCollaborationMetadataSnapshot(snapshot);
  if (Buffer.byteLength(value, 'utf8') > COLLABORATION_SYNC_MAX_SNAPSHOT_BYTES) {
    throw new Error('The collaboration recovery snapshot exceeds the local size limit.');
  }
  return value;
}

function parseSnapshot(value: string | null): CollaborationMetadataSnapshot | null {
  if (value === null) return null;
  return CollaborationMetadataSnapshotSchema.parse(JSON.parse(value));
}

function assertCanvasMatches(
  canvasId: string,
  snapshot: CollaborationMetadataSnapshot | null,
): void {
  if (snapshot !== null && snapshot.canvas.id !== canvasId) {
    throw new Error('The collaboration recovery snapshot belongs to another canvas.');
  }
}

function requiredRecovery(
  database: DatabaseSync,
  scope: CollaborationSyncStorageScope,
  now: Date,
): CollaborationSyncRecovery {
  const value = recoverCollaborationSyncState(database, scope, now);
  if (value === null) throw new Error('The collaboration recovery record was not persisted.');
  return value;
}
