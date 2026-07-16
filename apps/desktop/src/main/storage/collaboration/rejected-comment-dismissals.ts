import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import {
  collaborationCommentMetadataEquals,
  CollaborationCommentMetadataSchema,
  CollaborationMetadataSnapshotSchema,
  CollaborationRoomIdSchema,
  CollaborationServerUrlSchema,
  CollaborationSubjectSchema,
  type CollaborationCommentMetadata,
  type CollaborationMetadataSnapshot,
} from '../../../shared/collaboration/index.js';

export const COLLABORATION_REJECTED_DISMISSAL_MAX_ROWS_PER_SCOPE = 50_000;
export const COLLABORATION_REJECTED_DISMISSAL_MAX_BYTES_PER_SCOPE = 16_777_216;
export const COLLABORATION_REJECTED_DISMISSAL_MAX_COMMENT_BYTES = 65_536;

export interface RejectedCommentDismissalScope {
  readonly projectId: string;
  readonly canvasId: string;
  readonly serverUrl: string;
  readonly roomId: string;
  readonly subject: string;
}

export interface RejectedCommentStorageEntry {
  readonly comment: CollaborationCommentMetadata;
  readonly rejectedDeliveryId: string;
  readonly rejectedThroughSequence: number;
}

interface DismissalRow {
  readonly sequence: number;
  readonly project_id: string;
  readonly canvas_id: string;
  readonly server_url: string;
  readonly room_id: string;
  readonly subject: string;
  readonly comment_id: string;
  readonly comment_json: string;
  readonly comment_digest: string;
  readonly rejected_through_sequence: number;
  readonly dismissed_at: string;
  readonly expires_at: string;
}

const ScopeSchema = z
  .object({
    projectId: z.string().uuid(),
    canvasId: z.string().uuid(),
    serverUrl: CollaborationServerUrlSchema,
    roomId: CollaborationRoomIdSchema,
    subject: CollaborationSubjectSchema,
  })
  .strict();

export function rejectedCommentDismissalOverlay(
  database: DatabaseSync,
  rawScope: RejectedCommentDismissalScope,
  rawEntries: readonly RejectedCommentStorageEntry[],
): {
  readonly rejectedEntries: RejectedCommentStorageEntry[];
  readonly dismissedEntries: RejectedCommentStorageEntry[];
  readonly dismissedComments: CollaborationCommentMetadata[];
} {
  const scope = ScopeSchema.parse(rawScope);
  const entries = z
    .array(
      z.object({
        comment: CollaborationCommentMetadataSchema,
        rejectedDeliveryId: z.string().uuid(),
        rejectedThroughSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .max(50_000)
    .parse(rawEntries);
  const byCommentId = new Map<string, DismissalRow[]>();
  for (const row of dismissalRows(database, scope)) {
    validateDismissalRow(row);
    const values = byCommentId.get(row.comment_id) ?? [];
    values.push(row);
    byCommentId.set(row.comment_id, values);
  }
  const rejectedEntries: RejectedCommentStorageEntry[] = [];
  const dismissedEntries: RejectedCommentStorageEntry[] = [];
  const dismissedComments: CollaborationCommentMetadata[] = [];
  for (const entry of entries) {
    const dismissed = (byCommentId.get(entry.comment.id) ?? []).some((row) => {
      if (entry.rejectedThroughSequence > row.rejected_through_sequence) return false;
      return collaborationCommentMetadataEquals(parseComment(row.comment_json), entry.comment);
    });
    if (dismissed) {
      dismissedEntries.push(entry);
      dismissedComments.push(entry.comment);
    } else rejectedEntries.push(entry);
  }
  return { rejectedEntries, dismissedEntries, dismissedComments };
}

export function recordRejectedCommentDismissal(
  database: DatabaseSync,
  rawScope: RejectedCommentDismissalScope,
  rawComment: CollaborationCommentMetadata,
  rejectedDeliveryId: string,
  currentEntries: readonly RejectedCommentStorageEntry[],
  expiresAt: string,
  now = new Date(),
): void {
  const scope = ScopeSchema.parse(rawScope);
  const comment = CollaborationCommentMetadataSchema.parse(rawComment);
  const deliveryId = z.string().uuid().parse(rejectedDeliveryId);
  z.string().datetime({ offset: true }).parse(expiresAt);
  if (comment.authorId !== scope.subject) {
    throw new Error('Only this local collaboration identity can discard its rejected comment.');
  }
  const current = currentEntries.find(
    (entry) =>
      entry.rejectedDeliveryId === deliveryId &&
      collaborationCommentMetadataEquals(entry.comment, comment),
  );
  if (current === undefined) {
    throw new Error('The rejected collaboration comment changed before it could be discarded.');
  }
  const sequence = current.rejectedThroughSequence;
  const commentJson = serializeComment(comment);
  const commentBytes = Buffer.byteLength(commentJson, 'utf8');
  if (commentBytes > COLLABORATION_REJECTED_DISMISSAL_MAX_COMMENT_BYTES) {
    throw new Error('The rejected collaboration comment exceeds the local dismissal limit.');
  }
  const digest = createHash('sha256').update(commentJson).digest('hex');
  const existing = database
    .prepare(
      `SELECT comment_json FROM collaboration_rejected_comment_dismissals
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?
         AND comment_id = ? AND comment_digest = ? AND rejected_through_sequence = ?`,
    )
    .get(
      scope.projectId,
      scope.canvasId,
      scope.serverUrl,
      scope.roomId,
      scope.subject,
      comment.id,
      digest,
      sequence,
    ) as { comment_json: string } | undefined;
  if (existing !== undefined) {
    if (!collaborationCommentMetadataEquals(parseComment(existing.comment_json), comment)) {
      throw new Error('The rejected comment dismissal digest is not value-bound.');
    }
    return;
  }
  enforceDismissalQuota(database, scope, commentBytes);
  database
    .prepare(
      `INSERT INTO collaboration_rejected_comment_dismissals(
         project_id, canvas_id, server_url, room_id, subject, comment_id, comment_json,
         comment_digest, rejected_through_sequence, dismissed_at, expires_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scope.projectId,
      scope.canvasId,
      scope.serverUrl,
      scope.roomId,
      scope.subject,
      comment.id,
      commentJson,
      digest,
      sequence,
      now.toISOString(),
      expiresAt,
    );
}

export function extendRejectedCommentDismissalExpiry(
  database: DatabaseSync,
  scope: RejectedCommentDismissalScope,
  expiresAt: string,
): void {
  database
    .prepare(
      `UPDATE collaboration_rejected_comment_dismissals SET expires_at = ?
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
    )
    .run(expiresAt, scope.projectId, scope.canvasId, scope.serverUrl, scope.roomId, scope.subject);
}

export function deleteRejectedCommentDismissals(
  database: DatabaseSync,
  scope: RejectedCommentDismissalScope,
): number {
  return Number(
    database
      .prepare(
        `DELETE FROM collaboration_rejected_comment_dismissals
         WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
      )
      .run(scope.projectId, scope.canvasId, scope.serverUrl, scope.roomId, scope.subject).changes,
  );
}

export function pruneExpiredRejectedCommentDismissals(database: DatabaseSync, now: Date): number {
  return Number(
    database
      .prepare('DELETE FROM collaboration_rejected_comment_dismissals WHERE expires_at <= ?')
      .run(now.toISOString()).changes,
  );
}

export function rejectedCommentDismissalIntegrityMessages(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        `SELECT sequence, project_id, canvas_id, server_url, room_id, subject, comment_id,
              comment_json, comment_digest, rejected_through_sequence, dismissed_at, expires_at
       FROM collaboration_rejected_comment_dismissals ORDER BY sequence`,
      )
      .all() as unknown as DismissalRow[]
  ).flatMap((row, index) => {
    try {
      const scope = ScopeSchema.parse({
        projectId: row.project_id,
        canvasId: row.canvas_id,
        serverUrl: row.server_url,
        roomId: row.room_id,
        subject: row.subject,
      });
      z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(row.sequence);
      z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(row.rejected_through_sequence);
      z.string().datetime({ offset: true }).parse(row.dismissed_at);
      z.string().datetime({ offset: true }).parse(row.expires_at);
      const comment = parseComment(row.comment_json);
      if (comment.id !== row.comment_id || comment.authorId !== scope.subject) {
        throw new Error('dismissed comment identity mismatch');
      }
      if (
        Buffer.byteLength(row.comment_json, 'utf8') >
        COLLABORATION_REJECTED_DISMISSAL_MAX_COMMENT_BYTES
      ) {
        throw new Error('dismissed comment exceeds byte limit');
      }
      const digest = createHash('sha256').update(serializeComment(comment)).digest('hex');
      if (digest !== row.comment_digest || serializeComment(comment) !== row.comment_json) {
        throw new Error('dismissed comment value or digest mismatch');
      }
      const delivery = database
        .prepare(
          `SELECT project_id, canvas_id, server_url, room_id, subject, disposition,
                  baseline_json, candidate_json
           FROM collaboration_sync_deliveries WHERE sequence = ?`,
        )
        .get(row.rejected_through_sequence) as
        | {
            project_id: string;
            canvas_id: string;
            server_url: string;
            room_id: string;
            subject: string;
            disposition: string;
            baseline_json: string | null;
            candidate_json: string;
          }
        | undefined;
      if (
        delivery === undefined ||
        delivery.project_id !== scope.projectId ||
        delivery.canvas_id !== scope.canvasId ||
        delivery.server_url !== scope.serverUrl ||
        delivery.room_id !== scope.roomId ||
        delivery.subject !== scope.subject
      ) {
        throw new Error('dismissal cutoff is not bound to its delivery scope');
      }
      if (delivery.disposition !== 'rejected') {
        throw new Error('dismissal cutoff does not reference a rejected delivery');
      }
      const baseline = parseSnapshot(delivery.baseline_json);
      const candidate = parseSnapshot(delivery.candidate_json);
      if (candidate === null) throw new Error('dismissal cutoff delivery has no candidate');
      if (
        baseline?.comments[comment.id] !== undefined ||
        !collaborationCommentMetadataEquals(candidate.comments[comment.id], comment)
      ) {
        throw new Error('dismissal cutoff does not reference the exact rejected addition');
      }
      return [];
    } catch (error) {
      return [
        `collaboration_rejected_comment_dismissals row ${index + 1}: ${
          error instanceof Error ? error.message : 'invalid dismissal record'
        }`,
      ];
    }
  });
}

function dismissalRows(
  database: DatabaseSync,
  scope: RejectedCommentDismissalScope,
): DismissalRow[] {
  return database
    .prepare(
      `SELECT sequence, project_id, canvas_id, server_url, room_id, subject, comment_id,
              comment_json, comment_digest, rejected_through_sequence, dismissed_at, expires_at
       FROM collaboration_rejected_comment_dismissals
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?
       ORDER BY sequence`,
    )
    .all(
      scope.projectId,
      scope.canvasId,
      scope.serverUrl,
      scope.roomId,
      scope.subject,
    ) as unknown as DismissalRow[];
}

function enforceDismissalQuota(
  database: DatabaseSync,
  scope: RejectedCommentDismissalScope,
  addedBytes: number,
): void {
  const totals = database
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(length(CAST(comment_json AS BLOB))), 0) AS bytes
       FROM collaboration_rejected_comment_dismissals
       WHERE project_id = ? AND canvas_id = ? AND server_url = ? AND room_id = ? AND subject = ?`,
    )
    .get(scope.projectId, scope.canvasId, scope.serverUrl, scope.roomId, scope.subject) as {
    count: number;
    bytes: number;
  };
  if (totals.count >= COLLABORATION_REJECTED_DISMISSAL_MAX_ROWS_PER_SCOPE) {
    throw new Error('This collaboration session has reached its local dismissal count limit.');
  }
  if (totals.bytes + addedBytes > COLLABORATION_REJECTED_DISMISSAL_MAX_BYTES_PER_SCOPE) {
    throw new Error('This collaboration session has reached its local dismissal byte limit.');
  }
}

function validateDismissalRow(row: DismissalRow): void {
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(row.sequence);
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(row.rejected_through_sequence);
  const comment = parseComment(row.comment_json);
  if (comment.id !== row.comment_id || comment.authorId !== row.subject) {
    throw new Error('The rejected comment dismissal identity is invalid.');
  }
  if (createHash('sha256').update(row.comment_json).digest('hex') !== row.comment_digest) {
    throw new Error('The rejected comment dismissal digest is invalid.');
  }
}

function parseComment(value: string): CollaborationCommentMetadata {
  return CollaborationCommentMetadataSchema.parse(JSON.parse(value));
}

function parseSnapshot(value: string | null): CollaborationMetadataSnapshot | null {
  if (value === null) return null;
  return CollaborationMetadataSnapshotSchema.parse(JSON.parse(value));
}

function serializeComment(comment: CollaborationCommentMetadata): string {
  return JSON.stringify(CollaborationCommentMetadataSchema.parse(comment));
}
