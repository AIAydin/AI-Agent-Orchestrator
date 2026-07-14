import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  CollaborationRoleSchema,
  DisplayNameSchema,
  InviteRoleSchema,
  RoomIdSchema,
  SubjectIdSchema,
  type CollaborationRole,
  type InviteRole,
} from './types.js';

const AUDIT_DETAIL_KEYS = new Set([
  'roomId',
  'actorId',
  'targetId',
  'role',
  'inviteId',
  'reason',
  'bytes',
  'ipHash',
  'origin',
  'route',
  'expiresAt',
  'maxUses',
  'connections',
]);

export type AuditOutcome = 'allowed' | 'denied' | 'failed';

export interface AuditEventInput {
  category: 'authorization' | 'room' | 'invite' | 'membership' | 'document' | 'connection';
  action: string;
  outcome: AuditOutcome;
  details: Record<string, boolean | number | string | null | undefined>;
  occurredAt?: Date;
}

export interface Membership {
  roomId: string;
  subject: string;
  displayName: string;
  role: CollaborationRole;
  tokenVersion: number;
  revokedAt?: string;
}

export interface InviteRecord {
  id: string;
  roomId: string;
  role: InviteRole;
  createdBy: string;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  revokedAt?: string;
}

export interface AuditEvent {
  sequence: number;
  occurredAt: string;
  category: string;
  action: string;
  outcome: AuditOutcome;
  details: Record<string, unknown>;
  previousHash: string;
  eventHash: string;
}

interface MembershipRow {
  room_id: string;
  subject: string;
  display_name: string;
  role: string;
  token_version: number;
  revoked_at: string | null;
}

interface InviteRow {
  id: string;
  room_id: string;
  role: string;
  created_by: string;
  expires_at: string;
  max_uses: number;
  use_count: number;
  revoked_at: string | null;
}

interface DocumentRow {
  state: Uint8Array;
}

interface CountRow {
  count: number;
}

interface QuickCheckRow {
  quick_check: string;
}

interface AuditRow {
  sequence: number;
  occurred_at: string;
  category: string;
  action: string;
  outcome: string;
  details_json: string;
  previous_hash: string;
  event_hash: string;
}

export class RoomAlreadyExistsError extends Error {}
export class InviteNotRedeemableError extends Error {}

export class CollaborationStore {
  private readonly database: DatabaseSync;

  constructor(readonly databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
    this.assertIntegrity();
    this.assertAuditChain();
  }

  close(): void {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    this.database.close();
  }

  isReady(): boolean {
    const row = this.database.prepare('SELECT 1 AS count').get() as unknown as CountRow;
    return row.count === 1;
  }

  roomExists(roomId: string): boolean {
    const parsedRoomId = RoomIdSchema.parse(roomId);
    return Boolean(
      this.database.prepare('SELECT 1 AS count FROM rooms WHERE id = ?').get(parsedRoomId),
    );
  }

  createRoom(
    roomId: string,
    ownerId: string,
    ownerDisplayName: string,
    now = new Date(),
  ): Membership {
    const parsedRoomId = RoomIdSchema.parse(roomId);
    const parsedOwnerId = SubjectIdSchema.parse(ownerId);
    const parsedDisplayName = DisplayNameSchema.parse(ownerDisplayName);
    const timestamp = now.toISOString();
    return this.transaction(() => {
      try {
        this.database
          .prepare('INSERT INTO rooms(id, created_at) VALUES(?, ?)')
          .run(parsedRoomId, timestamp);
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          throw new RoomAlreadyExistsError(
            'A collaboration room with this identifier already exists.',
          );
        }
        throw error;
      }
      this.database
        .prepare(
          `INSERT INTO memberships(
             room_id, subject, display_name, role, token_version, joined_at, revoked_at
           ) VALUES(?, ?, ?, 'owner', 0, ?, NULL)`,
        )
        .run(parsedRoomId, parsedOwnerId, parsedDisplayName, timestamp);
      return {
        roomId: parsedRoomId,
        subject: parsedOwnerId,
        displayName: parsedDisplayName,
        role: 'owner',
        tokenVersion: 0,
      };
    });
  }

  getMembership(roomId: string, subject: string): Membership | undefined {
    const row = this.database
      .prepare(
        `SELECT room_id, subject, display_name, role, token_version, revoked_at
         FROM memberships WHERE room_id = ? AND subject = ?`,
      )
      .get(RoomIdSchema.parse(roomId), SubjectIdSchema.parse(subject)) as MembershipRow | undefined;
    return row ? mapMembership(row) : undefined;
  }

  createInvite(input: {
    id: string;
    roomId: string;
    role: InviteRole;
    createdBy: string;
    expiresAt: Date;
    maxUses: number;
    now?: Date;
  }): InviteRecord {
    const record: InviteRecord = {
      id: input.id,
      roomId: RoomIdSchema.parse(input.roomId),
      role: InviteRoleSchema.parse(input.role),
      createdBy: SubjectIdSchema.parse(input.createdBy),
      expiresAt: input.expiresAt.toISOString(),
      maxUses: input.maxUses,
      useCount: 0,
    };
    this.database
      .prepare(
        `INSERT INTO invites(
           id, room_id, role, created_by, created_at, expires_at, max_uses, use_count, revoked_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      )
      .run(
        record.id,
        record.roomId,
        record.role,
        record.createdBy,
        (input.now ?? new Date()).toISOString(),
        record.expiresAt,
        record.maxUses,
      );
    return record;
  }

  getInvite(inviteId: string): InviteRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, room_id, role, created_by, expires_at, max_uses, use_count, revoked_at
         FROM invites WHERE id = ?`,
      )
      .get(inviteId) as InviteRow | undefined;
    return row ? mapInvite(row) : undefined;
  }

  redeemInvite(
    inviteId: string,
    subject: string,
    displayName: string,
    now = new Date(),
  ): Membership {
    const parsedSubject = SubjectIdSchema.parse(subject);
    const parsedDisplayName = DisplayNameSchema.parse(displayName);
    return this.transaction(() => {
      const invite = this.getInvite(inviteId);
      if (
        !invite ||
        invite.revokedAt ||
        invite.useCount >= invite.maxUses ||
        new Date(invite.expiresAt).getTime() <= now.getTime()
      ) {
        throw new InviteNotRedeemableError('The invite is expired, revoked, or already used.');
      }
      this.database
        .prepare('UPDATE invites SET use_count = use_count + 1 WHERE id = ?')
        .run(invite.id);

      const existing = this.getMembership(invite.roomId, parsedSubject);
      if (existing?.role === 'owner' && !existing.revokedAt) return existing;
      const nextVersion = existing ? existing.tokenVersion + 1 : 0;
      this.database
        .prepare(
          `INSERT INTO memberships(
             room_id, subject, display_name, role, token_version, joined_at, revoked_at
           ) VALUES(?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(room_id, subject) DO UPDATE SET
             display_name = excluded.display_name,
             role = excluded.role,
             token_version = excluded.token_version,
             revoked_at = NULL`,
        )
        .run(
          invite.roomId,
          parsedSubject,
          parsedDisplayName,
          invite.role,
          nextVersion,
          now.toISOString(),
        );
      return {
        roomId: invite.roomId,
        subject: parsedSubject,
        displayName: parsedDisplayName,
        role: invite.role,
        tokenVersion: nextVersion,
      };
    });
  }

  revokeInvite(inviteId: string, roomId: string, now = new Date()): boolean {
    const result = this.database
      .prepare(
        `UPDATE invites SET revoked_at = ?
         WHERE id = ? AND room_id = ? AND revoked_at IS NULL`,
      )
      .run(now.toISOString(), inviteId, RoomIdSchema.parse(roomId));
    return result.changes === 1;
  }

  updateMembershipRole(
    roomId: string,
    subject: string,
    role: Exclude<CollaborationRole, 'owner'>,
  ): Membership | undefined {
    const result = this.database
      .prepare(
        `UPDATE memberships SET role = ?, token_version = token_version + 1
         WHERE room_id = ? AND subject = ? AND role != 'owner' AND revoked_at IS NULL`,
      )
      .run(role, RoomIdSchema.parse(roomId), SubjectIdSchema.parse(subject));
    return result.changes === 1 ? this.getMembership(roomId, subject) : undefined;
  }

  revokeMembership(roomId: string, subject: string, now = new Date()): boolean {
    const result = this.database
      .prepare(
        `UPDATE memberships
         SET revoked_at = ?, token_version = token_version + 1
         WHERE room_id = ? AND subject = ? AND role != 'owner' AND revoked_at IS NULL`,
      )
      .run(now.toISOString(), RoomIdSchema.parse(roomId), SubjectIdSchema.parse(subject));
    return result.changes === 1;
  }

  loadDocument(roomId: string): Uint8Array | undefined {
    const row = this.database
      .prepare('SELECT state FROM documents WHERE room_id = ?')
      .get(RoomIdSchema.parse(roomId)) as DocumentRow | undefined;
    return row ? new Uint8Array(row.state) : undefined;
  }

  saveDocument(roomId: string, state: Uint8Array, now = new Date()): void {
    this.database
      .prepare(
        `INSERT INTO documents(room_id, state, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(RoomIdSchema.parse(roomId), state, now.toISOString());
  }

  appendAudit(input: AuditEventInput): AuditEvent {
    const occurredAt = (input.occurredAt ?? new Date()).toISOString();
    const details = sanitizeAuditDetails(input.details);
    const detailsJson = JSON.stringify(details);
    const prior = this.database
      .prepare('SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1')
      .get() as { event_hash: string } | undefined;
    const previousHash = prior?.event_hash ?? '0'.repeat(64);
    const eventHash = createHash('sha256')
      .update(
        [previousHash, occurredAt, input.category, input.action, input.outcome, detailsJson].join(
          '\n',
        ),
      )
      .digest('hex');
    const result = this.database
      .prepare(
        `INSERT INTO audit_events(
           occurred_at, category, action, outcome, details_json, previous_hash, event_hash
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        occurredAt,
        input.category,
        input.action,
        input.outcome,
        detailsJson,
        previousHash,
        eventHash,
      );
    return {
      sequence: Number(result.lastInsertRowid),
      occurredAt,
      category: input.category,
      action: input.action,
      outcome: input.outcome,
      details,
      previousHash,
      eventHash,
    };
  }

  listAudit(roomId: string, afterSequence = 0, limit = 100): AuditEvent[] {
    const rows = this.database
      .prepare(
        `SELECT sequence, occurred_at, category, action, outcome, details_json,
                previous_hash, event_hash
         FROM audit_events
         WHERE sequence > ? AND json_extract(details_json, '$.roomId') = ?
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(
        afterSequence,
        RoomIdSchema.parse(roomId),
        Math.min(Math.max(limit, 1), 500),
      ) as unknown as AuditRow[];
    return rows.map(mapAudit);
  }

  checkpoint(): void {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'reviewer', 'viewer')),
        token_version INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY(room_id, subject)
      );
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('editor', 'reviewer', 'viewer')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_uses INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 100),
        use_count INTEGER NOT NULL DEFAULT 0,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_invites_room ON invites(room_id);
      CREATE TABLE IF NOT EXISTS documents (
        room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
        state BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('allowed', 'denied', 'failed')),
        details_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE
      );
      CREATE TRIGGER IF NOT EXISTS audit_events_no_update
      BEFORE UPDATE ON audit_events BEGIN
        SELECT RAISE(ABORT, 'audit events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
      BEFORE DELETE ON audit_events BEGIN
        SELECT RAISE(ABORT, 'audit events are append-only');
      END;
    `);
  }

  private assertIntegrity(): void {
    const row = this.database.prepare('PRAGMA quick_check;').get() as unknown as QuickCheckRow;
    if (row.quick_check !== 'ok') {
      throw new Error(`Collaboration database integrity check failed: ${row.quick_check}`);
    }
  }

  private assertAuditChain(): void {
    const rows = this.database
      .prepare(
        `SELECT sequence, occurred_at, category, action, outcome, details_json,
                previous_hash, event_hash FROM audit_events ORDER BY sequence`,
      )
      .all() as unknown as AuditRow[];
    let previousHash = '0'.repeat(64);
    for (const row of rows) {
      const expectedHash = createHash('sha256')
        .update(
          [
            previousHash,
            row.occurred_at,
            row.category,
            row.action,
            row.outcome,
            row.details_json,
          ].join('\n'),
        )
        .digest('hex');
      if (row.previous_hash !== previousHash || row.event_hash !== expectedHash) {
        throw new Error(
          `Collaboration audit chain verification failed at sequence ${row.sequence}.`,
        );
      }
      previousHash = row.event_hash;
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

function mapMembership(row: MembershipRow): Membership {
  return {
    roomId: row.room_id,
    subject: row.subject,
    displayName: row.display_name,
    role: CollaborationRoleSchema.parse(row.role),
    tokenVersion: row.token_version,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function mapInvite(row: InviteRow): InviteRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    role: InviteRoleSchema.parse(row.role),
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function mapAudit(row: AuditRow): AuditEvent {
  return {
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    category: row.category,
    action: row.action,
    outcome: row.outcome as AuditOutcome,
    details: JSON.parse(row.details_json) as Record<string, unknown>,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
  };
}

function sanitizeAuditDetails(
  details: Record<string, boolean | number | string | null | undefined>,
): Record<string, boolean | number | string | null> {
  const sanitized: Record<string, boolean | number | string | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!AUDIT_DETAIL_KEYS.has(key)) throw new Error(`Audit detail key is not allowed: ${key}`);
    if (value === undefined) continue;
    sanitized[key] = typeof value === 'string' ? value.slice(0, 300) : value;
  }
  return sanitized;
}
