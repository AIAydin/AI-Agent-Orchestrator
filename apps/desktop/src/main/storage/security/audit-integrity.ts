import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { AuditEventSchema } from '../../../shared/application/contracts.js';
import { isRecord, redact, safeParseJson } from '../values.js';

export const AUDIT_ZERO_HASH = '0'.repeat(64);

const AUDIT_UPDATE_TRIGGER = `CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END`;
const AUDIT_DELETE_TRIGGER = `CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END`;
const AUDIT_INSERT_TRIGGER = `CREATE TRIGGER audit_events_valid_insert
BEFORE INSERT ON audit_events
WHEN NEW.previous_hash IS NULL OR length(NEW.previous_hash) != 64
  OR NEW.event_hash IS NULL OR length(NEW.event_hash) != 64
BEGIN
  SELECT RAISE(ABORT, 'audit events require integrity hashes');
END`;
const CHECKPOINT_UPDATE_TRIGGER = `CREATE TRIGGER audit_checkpoints_no_update
BEFORE UPDATE ON audit_chain_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'audit checkpoints are immutable');
END`;
const CHECKPOINT_DELETE_TRIGGER = `CREATE TRIGGER audit_checkpoints_no_delete
BEFORE DELETE ON audit_chain_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'audit checkpoints are append-only');
END`;

const REQUIRED_TRIGGERS = new Map([
  ['audit_events_no_update', AUDIT_UPDATE_TRIGGER],
  ['audit_events_no_delete', AUDIT_DELETE_TRIGGER],
  ['audit_events_valid_insert', AUDIT_INSERT_TRIGGER],
  ['audit_checkpoints_no_update', CHECKPOINT_UPDATE_TRIGGER],
  ['audit_checkpoints_no_delete', CHECKPOINT_DELETE_TRIGGER],
]);

const CONTROLLED_DELETE_TRIGGERS = [
  ['audit_events_no_delete', AUDIT_DELETE_TRIGGER],
  ['audit_checkpoints_no_delete', CHECKPOINT_DELETE_TRIGGER],
] as const;
const deleteAuthority = new WeakSet<DatabaseSync>();
const installedDeleteAuthorities = new WeakSet<DatabaseSync>();

interface AuditIntegrityRow {
  readonly sequence: number;
  readonly occurred_at: string;
  readonly category: string;
  readonly action: string;
  readonly outcome: string;
  readonly metadata_json: string;
  readonly previous_hash: string | null;
  readonly event_hash: string | null;
}

interface AuditChainStateRow {
  readonly initialized_at: string;
  readonly last_sequence: number;
  readonly last_event_hash: string;
}

interface AuditCheckpointRow {
  readonly checkpoint_sequence: number;
  readonly first_pruned_sequence: number;
  readonly pruned_through_sequence: number;
  readonly pruned_through_hash: string;
  readonly event_count: number;
  readonly pruned_at: string;
  readonly previous_checkpoint_hash: string;
  readonly checkpoint_hash: string;
}

let nextSavepoint = 1;

export function initializeAuditIntegrity(database: DatabaseSync, now = new Date()): void {
  const state = getAuditState(database);
  const installed = installedTriggerNames(database);
  if (state !== undefined) {
    const messages = triggerIntegrityMessages(database);
    if (messages.length > 0) throw new Error(messages.join('; '));
    registerControlledAuditDeletion(database);
    return;
  }
  if (installed.some((name) => REQUIRED_TRIGGERS.has(name))) {
    throw new Error('Audit integrity initialization is incomplete; refusing to rebaseline it.');
  }
  const initializedAt = validTimestamp(now, 'Audit integrity initialization time');
  withSavepoint(database, () => {
    let previousHash = AUDIT_ZERO_HASH;
    let lastSequence = 0;
    const rows = selectAuditRows(database);
    const update = database.prepare(
      `UPDATE audit_events
       SET metadata_json = ?, previous_hash = ?, event_hash = ?
       WHERE sequence = ? AND previous_hash IS NULL AND event_hash IS NULL`,
    );
    for (const row of rows) {
      if (row.previous_hash !== null || row.event_hash !== null) {
        throw new Error(
          'Legacy audit rows contain partial integrity data; refusing to rebaseline.',
        );
      }
      const metadataJson = redactedMetadata(row.metadata_json);
      const eventHash = auditEventHash(previousHash, row, metadataJson);
      const result = update.run(metadataJson, previousHash, eventHash, row.sequence);
      if (result.changes !== 1) throw new Error('An audit row changed during initialization.');
      previousHash = eventHash;
      lastSequence = row.sequence;
    }
    database
      .prepare(
        `INSERT INTO audit_chain_state(
           singleton, initialized_at, last_sequence, last_event_hash
         ) VALUES(1, ?, ?, ?)`,
      )
      .run(initializedAt, lastSequence, previousHash);
    for (const sql of REQUIRED_TRIGGERS.values()) database.exec(`${sql};`);
  });
  registerControlledAuditDeletion(database);
}

export function appendChainedAudit(
  database: DatabaseSync,
  occurredAtValue: string,
  category: string,
  action: string,
  outcome: 'allowed' | 'denied' | 'failed',
  metadata: Record<string, unknown>,
): number {
  const occurredAt = validTimestampString(occurredAtValue, 'Audit event time');
  AuditEventSchema.parse({ sequence: 1, occurredAt, category, action, outcome });
  return withSavepoint(database, () => {
    assertAuditTail(database);
    const state = requiredAuditState(database);
    const metadataJson = redactedMetadata(JSON.stringify(metadata));
    if (Buffer.byteLength(metadataJson, 'utf8') > 1_048_576) {
      throw new Error('Audit metadata exceeds the 1 MiB storage limit.');
    }
    const eventHash = auditEventHash(
      state.last_event_hash,
      { occurred_at: occurredAt, category, action, outcome },
      metadataJson,
    );
    const result = database
      .prepare(
        `INSERT INTO audit_events(
           occurred_at, category, action, outcome, metadata_json, previous_hash, event_hash
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(occurredAt, category, action, outcome, metadataJson, state.last_event_hash, eventHash);
    const sequence = Number(result.lastInsertRowid);
    const updated = database
      .prepare(
        `UPDATE audit_chain_state SET last_sequence = ?, last_event_hash = ?
         WHERE singleton = 1 AND last_sequence = ? AND last_event_hash = ?`,
      )
      .run(sequence, eventHash, state.last_sequence, state.last_event_hash);
    if (updated.changes !== 1) throw new Error('The audit chain head changed during append.');
    return sequence;
  });
}

export function pruneAuditPrefix(database: DatabaseSync, cutoff: string, now = new Date()): number {
  const cutoffTime = Date.parse(cutoff);
  if (!Number.isFinite(cutoffTime)) throw new Error('Audit retention cutoff must be valid.');
  const prunedAt = validTimestamp(now, 'Audit retention time');
  return withSavepoint(database, () => {
    const integrityMessages = auditIntegrityMessages(database);
    if (integrityMessages.length > 0) {
      throw new Error(`Audit retention refused an invalid chain: ${integrityMessages.join('; ')}`);
    }
    const rows = selectAuditRows(database);
    const prefix: AuditIntegrityRow[] = [];
    for (const row of rows) {
      if (Date.parse(row.occurred_at) >= cutoffTime) break;
      prefix.push(row);
    }
    const first = prefix[0];
    const last = prefix[prefix.length - 1];
    if (first === undefined || last === undefined || last.event_hash === null) return 0;
    const previousCheckpointHash = latestCheckpoint(database)?.checkpoint_hash ?? AUDIT_ZERO_HASH;
    const checkpointHash = auditCheckpointHash({
      firstPrunedSequence: first.sequence,
      prunedThroughSequence: last.sequence,
      prunedThroughHash: last.event_hash,
      eventCount: prefix.length,
      prunedAt,
      previousCheckpointHash,
    });
    database
      .prepare(
        `INSERT INTO audit_chain_checkpoints(
           first_pruned_sequence, pruned_through_sequence, pruned_through_hash,
           event_count, pruned_at, previous_checkpoint_hash, checkpoint_hash
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        first.sequence,
        last.sequence,
        last.event_hash,
        prefix.length,
        prunedAt,
        previousCheckpointHash,
        checkpointHash,
      );
    const deleted = withControlledAuditDeletion(database, () =>
      database.prepare('DELETE FROM audit_events WHERE sequence <= ?').run(last.sequence),
    );
    if (Number(deleted.changes) !== prefix.length) {
      throw new Error('Audit retention did not delete the verified contiguous prefix.');
    }
    const messages = auditIntegrityMessages(database);
    if (messages.length > 0)
      throw new Error(`Audit retention broke the chain: ${messages.join('; ')}`);
    return prefix.length;
  });
}

/** Explicit privacy/replace reset. Ordinary retention must use pruneAuditPrefix instead. */
export function resetAuditChain(database: DatabaseSync, now = new Date()): void {
  // Privacy/import cleanup is also used by migration-level storage consumers. Bring a valid
  // migrated connection under the same trigger and controlled-delete boundary before resetting.
  initializeAuditIntegrity(database, now);
  const initializedAt = validTimestamp(now, 'Audit reset time');
  withSavepoint(database, () => {
    withControlledAuditDeletion(database, () => {
      database.prepare('DELETE FROM audit_events').run();
      database.prepare('DELETE FROM audit_chain_checkpoints').run();
    });
    database
      .prepare(
        `INSERT INTO audit_chain_state(
           singleton, initialized_at, last_sequence, last_event_hash
         ) VALUES(1, ?, 0, ?)
         ON CONFLICT(singleton) DO UPDATE SET initialized_at = excluded.initialized_at,
           last_sequence = 0, last_event_hash = excluded.last_event_hash`,
      )
      .run(initializedAt, AUDIT_ZERO_HASH);
  });
}

export function auditIntegrityMessages(database: DatabaseSync): string[] {
  const messages = triggerIntegrityMessages(database);
  try {
    const states = database
      .prepare(
        `SELECT initialized_at, last_sequence, last_event_hash
         FROM audit_chain_state ORDER BY singleton`,
      )
      .all() as unknown as AuditChainStateRow[];
    if (states.length !== 1) {
      messages.push(`audit_chain_state has ${states.length} rows; expected exactly one.`);
      return messages;
    }
    const state = states[0];
    if (state === undefined) return messages;
    if (
      !isHash(state.last_event_hash) ||
      !Number.isInteger(state.last_sequence) ||
      state.last_sequence < 0
    ) {
      messages.push('audit_chain_state contains an invalid chain head.');
    }
    if (!Number.isFinite(Date.parse(state.initialized_at))) {
      messages.push('audit_chain_state contains an invalid initialization time.');
    }

    let checkpointAnchor = AUDIT_ZERO_HASH;
    let prunedThroughSequence = 0;
    let checkpointSequence = 0;
    const checkpoints = selectCheckpoints(database);
    for (const checkpoint of checkpoints) {
      const expected = auditCheckpointHash({
        firstPrunedSequence: checkpoint.first_pruned_sequence,
        prunedThroughSequence: checkpoint.pruned_through_sequence,
        prunedThroughHash: checkpoint.pruned_through_hash,
        eventCount: checkpoint.event_count,
        prunedAt: checkpoint.pruned_at,
        previousCheckpointHash: checkpoint.previous_checkpoint_hash,
      });
      if (
        checkpoint.previous_checkpoint_hash !== checkpointAnchor ||
        checkpoint.checkpoint_sequence <= checkpointSequence ||
        checkpoint.first_pruned_sequence <= prunedThroughSequence ||
        checkpoint.pruned_through_sequence < checkpoint.first_pruned_sequence ||
        checkpoint.event_count < 1 ||
        checkpoint.event_count >
          checkpoint.pruned_through_sequence - checkpoint.first_pruned_sequence + 1 ||
        !Number.isFinite(Date.parse(checkpoint.pruned_at)) ||
        !isHash(checkpoint.pruned_through_hash) ||
        checkpoint.checkpoint_hash !== expected
      ) {
        messages.push(`audit checkpoint ${checkpoint.checkpoint_sequence} is invalid.`);
      }
      checkpointAnchor = checkpoint.checkpoint_hash;
      checkpointSequence = checkpoint.checkpoint_sequence;
      prunedThroughSequence = checkpoint.pruned_through_sequence;
    }

    let previousEventHash =
      checkpoints[checkpoints.length - 1]?.pruned_through_hash ?? AUDIT_ZERO_HASH;
    let lastSequence = checkpoints[checkpoints.length - 1]?.pruned_through_sequence ?? 0;
    const rows = selectAuditRows(database);
    for (const [index, row] of rows.entries()) {
      try {
        AuditEventSchema.parse({
          sequence: row.sequence,
          occurredAt: row.occurred_at,
          category: row.category,
          action: row.action,
          outcome: row.outcome,
        });
        const metadataJson = verifiedRedactedMetadata(row.metadata_json);
        const expected = auditEventHash(previousEventHash, row, metadataJson);
        if (
          row.sequence <= lastSequence ||
          row.previous_hash !== previousEventHash ||
          row.event_hash !== expected
        ) {
          throw new Error('hash-chain fields do not match the preceding event or checkpoint');
        }
        previousEventHash = expected;
        lastSequence = row.sequence;
      } catch (error) {
        messages.push(
          `audit_events row ${index + 1}: ${error instanceof Error ? error.message : 'invalid row'}`,
        );
      }
    }
    if (state.last_sequence !== lastSequence || state.last_event_hash !== previousEventHash) {
      messages.push('audit_chain_state does not match the verified chain head.');
    }
  } catch (error) {
    messages.push(error instanceof Error ? error.message : 'Unknown audit integrity failure.');
  }
  return messages;
}

function assertAuditTail(database: DatabaseSync): void {
  const state = requiredAuditState(database);
  const latestEvent = database
    .prepare('SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1')
    .get() as { sequence: number; event_hash: string | null } | undefined;
  if (latestEvent !== undefined) {
    if (
      latestEvent.sequence !== state.last_sequence ||
      latestEvent.event_hash !== state.last_event_hash
    ) {
      throw new Error('The audit chain head does not match its latest event.');
    }
    return;
  }
  const checkpoint = latestCheckpoint(database);
  const expectedSequence = checkpoint?.pruned_through_sequence ?? 0;
  const expectedHash = checkpoint?.pruned_through_hash ?? AUDIT_ZERO_HASH;
  if (state.last_sequence !== expectedSequence || state.last_event_hash !== expectedHash) {
    throw new Error('The audit chain head does not match its retention checkpoint.');
  }
}

function requiredAuditState(database: DatabaseSync): AuditChainStateRow {
  const state = getAuditState(database);
  if (state === undefined) throw new Error('Audit integrity has not been initialized.');
  return state;
}

function getAuditState(database: DatabaseSync): AuditChainStateRow | undefined {
  return database
    .prepare(
      `SELECT initialized_at, last_sequence, last_event_hash
       FROM audit_chain_state WHERE singleton = 1`,
    )
    .get() as AuditChainStateRow | undefined;
}

function selectAuditRows(database: DatabaseSync): AuditIntegrityRow[] {
  return database
    .prepare(
      `SELECT sequence, occurred_at, category, action, outcome, metadata_json,
         previous_hash, event_hash
       FROM audit_events ORDER BY sequence`,
    )
    .all() as unknown as AuditIntegrityRow[];
}

function selectCheckpoints(database: DatabaseSync): AuditCheckpointRow[] {
  return database
    .prepare(
      `SELECT checkpoint_sequence, first_pruned_sequence, pruned_through_sequence,
         pruned_through_hash, event_count, pruned_at, previous_checkpoint_hash, checkpoint_hash
       FROM audit_chain_checkpoints ORDER BY checkpoint_sequence`,
    )
    .all() as unknown as AuditCheckpointRow[];
}

function latestCheckpoint(database: DatabaseSync): AuditCheckpointRow | undefined {
  return database
    .prepare(
      `SELECT checkpoint_sequence, first_pruned_sequence, pruned_through_sequence,
         pruned_through_hash, event_count, pruned_at, previous_checkpoint_hash, checkpoint_hash
       FROM audit_chain_checkpoints ORDER BY checkpoint_sequence DESC LIMIT 1`,
    )
    .get() as AuditCheckpointRow | undefined;
}

function redactedMetadata(value: string): string {
  const parsed = safeParseJson(value);
  if (!isRecord(parsed)) throw new Error('audit metadata must be a JSON object');
  return JSON.stringify(redact(parsed));
}

function verifiedRedactedMetadata(value: string): string {
  const canonical = redactedMetadata(value);
  if (canonical !== value) throw new Error('audit metadata is not canonical and fully redacted');
  return canonical;
}

function auditEventHash(
  previousHash: string,
  event: Pick<AuditIntegrityRow, 'occurred_at' | 'category' | 'action' | 'outcome'>,
  metadataJson: string,
): string {
  return hashFields('forgeboard.audit.event.v1', [
    previousHash,
    event.occurred_at,
    event.category,
    event.action,
    event.outcome,
    metadataJson,
  ]);
}

function auditCheckpointHash(input: {
  readonly firstPrunedSequence: number;
  readonly prunedThroughSequence: number;
  readonly prunedThroughHash: string;
  readonly eventCount: number;
  readonly prunedAt: string;
  readonly previousCheckpointHash: string;
}): string {
  return hashFields('forgeboard.audit.checkpoint.v1', [
    input.previousCheckpointHash,
    String(input.firstPrunedSequence),
    String(input.prunedThroughSequence),
    input.prunedThroughHash,
    String(input.eventCount),
    input.prunedAt,
  ]);
}

function hashFields(domain: string, fields: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([domain, ...fields]))
    .digest('hex');
}

function triggerIntegrityMessages(database: DatabaseSync): string[] {
  const placeholders = [...REQUIRED_TRIGGERS].map(() => '?').join(', ');
  const rows = database
    .prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'trigger' AND name IN (${placeholders})`,
    )
    .all(...REQUIRED_TRIGGERS.keys()) as unknown as Array<{ name: string; sql: string | null }>;
  const actual = new Map(rows.map((row) => [row.name, normalizeSql(row.sql ?? '')]));
  const messages: string[] = [];
  for (const [name, sql] of REQUIRED_TRIGGERS) {
    if (actual.get(name) !== normalizeSql(sql))
      messages.push(`Required audit trigger ${name} is missing or changed.`);
  }
  return messages;
}

/** Retention and an explicit privacy reset are the only production delete authorities. */
function withControlledAuditDeletion<T>(database: DatabaseSync, operation: () => T): T {
  if (!installedDeleteAuthorities.has(database)) {
    throw new Error('Audit deletion authority is not installed for this database connection.');
  }
  if (deleteAuthority.has(database)) throw new Error('Audit deletion authority cannot be nested.');
  deleteAuthority.add(database);
  try {
    for (const [name] of CONTROLLED_DELETE_TRIGGERS) database.exec(`DROP TRIGGER ${name};`);
    const result = operation();
    for (const [, sql] of CONTROLLED_DELETE_TRIGGERS) database.exec(`${sql};`);
    return result;
  } finally {
    deleteAuthority.delete(database);
  }
}

/** Registers the privately owned connection for the two controlled deletion operations. */
function registerControlledAuditDeletion(database: DatabaseSync): void {
  installedDeleteAuthorities.add(database);
}

function installedTriggerNames(database: DatabaseSync): string[] {
  return (
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'")
      .all() as unknown as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().replace(/;$/u, '').toLowerCase();
}

function isHash(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function validTimestamp(value: Date, label: string): string {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be valid.`);
  return value.toISOString();
}

function validTimestampString(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be valid.`);
  return value;
}

function withSavepoint<T>(database: DatabaseSync, operation: () => T): T {
  const name = `forgeboard_audit_${nextSavepoint}`;
  nextSavepoint += 1;
  database.exec(`SAVEPOINT ${name};`);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${name};`);
    return result;
  } catch (error) {
    try {
      database.exec(`ROLLBACK TO SAVEPOINT ${name};`);
      database.exec(`RELEASE SAVEPOINT ${name};`);
    } catch {
      // A trigger may already have rolled back the outer transaction. Preserve the root failure.
    }
    throw error;
  }
}
