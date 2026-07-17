import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SETTINGS_REPAIR_EVIDENCE_MAX_BYTES } from '../../shared/settings/repair/contracts.js';
import { COLLABORATION_REJECTED_DISMISSAL_MAX_COMMENT_BYTES } from './collaboration/rejected-comment-dismissals.js';
import { DELIVERY_READINESS_STORAGE_SQL } from './git-readiness/schema.js';
import { resetAuditChain } from './security/audit-integrity.js';

export const MIGRATIONS = [
  `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      value_json TEXT NOT NULL,
      opened_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recent_projects_opened_at ON recent_projects(opened_at DESC);
    CREATE TABLE IF NOT EXISTS canvas_documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      status TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_project_updated
      ON agent_runs(project_id, updated_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS canvas_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_canvas_created
      ON canvas_snapshots(canvas_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_project_created
      ON canvas_snapshots(project_id, created_at DESC, id DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS project_path_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      previous_path TEXT NOT NULL,
      replacement_path TEXT NOT NULL,
      relocated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_path_history_project
      ON project_path_history(project_id, sequence DESC);
    CREATE TABLE IF NOT EXISTS backup_records (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0)
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS trusted_extension_ledger (
      extension_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version > 0),
      extension_version TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'revoked')),
      operation_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trusted_extension_ledger_state_updated
      ON trusted_extension_ledger(state, updated_at DESC, extension_id);
  `,
  `
    CREATE TABLE IF NOT EXISTS check_executions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      check_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(
        status IN ('queued', 'running', 'passed', 'failed', 'cancelled', 'lost')
      ),
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_check_executions_project_updated
      ON check_executions(project_id, updated_at DESC, id DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS backup_health (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      last_attempt_at TEXT NOT NULL,
      last_attempt_outcome TEXT NOT NULL CHECK(last_attempt_outcome IN ('verified', 'failed')),
      last_error TEXT
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS workflow_executions (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version > 0),
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'waiting-for-approval', 'paused', 'cancelling',
        'failed', 'succeeded', 'cancelled', 'lost'
      )),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      runtime_json TEXT NOT NULL CHECK(length(runtime_json) <= 8388608),
      snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) <= 8388608),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES recent_projects(id) ON DELETE CASCADE,
      FOREIGN KEY(canvas_id) REFERENCES canvas_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_executions_recovery
      ON workflow_executions(status, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_workflow_executions_canvas_updated
      ON workflow_executions(canvas_id, updated_at DESC, id);

    CREATE TABLE IF NOT EXISTS workflow_execution_events (
      storage_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK(schema_version > 0),
      execution_sequence INTEGER NOT NULL CHECK(execution_sequence >= 0),
      execution_revision INTEGER NOT NULL CHECK(execution_revision > 0),
      type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(length(payload_json) <= 1048576),
      mutation_digest TEXT NOT NULL CHECK(length(mutation_digest) = 64),
      FOREIGN KEY(execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
      UNIQUE(execution_id, event_id),
      UNIQUE(execution_id, execution_sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_execution_events_ordered
      ON workflow_execution_events(execution_id, execution_sequence);

    CREATE TABLE IF NOT EXISTS workflow_node_bindings (
      execution_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK(schema_version > 0),
      binding_json TEXT NOT NULL CHECK(length(binding_json) <= 1048576),
      execution_revision INTEGER NOT NULL CHECK(execution_revision > 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(execution_id, node_id),
      FOREIGN KEY(execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_node_bindings_revision
      ON workflow_node_bindings(execution_id, execution_revision, node_id);
  `,
  `
    ALTER TABLE audit_events ADD COLUMN previous_hash TEXT;
    ALTER TABLE audit_events ADD COLUMN event_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_hash
      ON audit_events(event_hash) WHERE event_hash IS NOT NULL;

    CREATE TABLE IF NOT EXISTS audit_chain_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      initialized_at TEXT NOT NULL,
      last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
      last_event_hash TEXT NOT NULL CHECK(length(last_event_hash) = 64)
    );
    CREATE TABLE IF NOT EXISTS audit_chain_checkpoints (
      checkpoint_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      first_pruned_sequence INTEGER NOT NULL CHECK(first_pruned_sequence > 0),
      pruned_through_sequence INTEGER NOT NULL CHECK(
        pruned_through_sequence >= first_pruned_sequence
      ),
      pruned_through_hash TEXT NOT NULL CHECK(length(pruned_through_hash) = 64),
      event_count INTEGER NOT NULL CHECK(event_count > 0),
      pruned_at TEXT NOT NULL,
      previous_checkpoint_hash TEXT NOT NULL CHECK(length(previous_checkpoint_hash) = 64),
      checkpoint_hash TEXT NOT NULL UNIQUE CHECK(length(checkpoint_hash) = 64)
    );

    CREATE TABLE IF NOT EXISTS approval_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN (
        'agent-launch', 'command-execute', 'sensitive-file-override', 'git-push',
        'pull-request-create', 'git-merge', 'git-squash', 'git-rebase',
        'git-cherry-pick', 'git-destructive', 'worktree-remove', 'branch-delete',
        'external-open', 'collaboration-join', 'data-export', 'external-send',
        'permission-expand'
      )),
      resource_fingerprint TEXT NOT NULL CHECK(length(resource_fingerprint) BETWEEN 16 AND 512),
      agent_id TEXT,
      run_id TEXT,
      decision TEXT NOT NULL CHECK(decision IN ('approved', 'denied')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      consumed_at TEXT,
      single_use INTEGER NOT NULL CHECK(single_use IN (0, 1)),
      value_json TEXT NOT NULL CHECK(length(value_json) <= 1048576),
      FOREIGN KEY(project_id) REFERENCES recent_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_approval_records_project_created
      ON approval_records(project_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_approval_records_exact_scope
      ON approval_records(
        project_id, action, resource_fingerprint, agent_id, run_id, created_at DESC
      );
  `,
  `
    CREATE TABLE IF NOT EXISTS git_review_notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK(target_kind IN ('primary', 'agent-worktree')),
      run_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('comment', 'revision-request')),
      status TEXT NOT NULL CHECK(status IN ('open', 'resolved')),
      revision_id TEXT NOT NULL CHECK(length(revision_id) = 64),
      relative_path TEXT NOT NULL CHECK(length(relative_path) BETWEEN 1 AND 4096),
      side TEXT NOT NULL CHECK(side IN ('old', 'new')),
      line_number INTEGER NOT NULL CHECK(line_number BETWEEN 1 AND 10000000),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      value_json TEXT NOT NULL CHECK(length(value_json) <= 1048576),
      CHECK(
        (target_kind = 'primary' AND run_id IS NULL) OR
        (target_kind = 'agent-worktree' AND run_id IS NOT NULL)
      ),
      FOREIGN KEY(project_id) REFERENCES recent_projects(id) ON DELETE CASCADE,
      FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_git_review_notes_target_updated
      ON git_review_notes(project_id, target_kind, run_id, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_git_review_notes_revision_path
      ON git_review_notes(revision_id, relative_path, side, line_number);
  `,
  `
    CREATE TABLE IF NOT EXISTS collaboration_sync_states (
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      server_url TEXT NOT NULL CHECK(length(server_url) BETWEEN 1 AND 2048),
      room_id TEXT NOT NULL CHECK(length(room_id) BETWEEN 1 AND 80),
      subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 120),
      baseline_json TEXT,
      pending_json TEXT NOT NULL CHECK(length(pending_json) <= 8388608),
      delivery_id TEXT,
      snapshot_digest TEXT,
      disposition TEXT NOT NULL CHECK(disposition IN (
        'staged', 'sent', 'queued-offline', 'acknowledged', 'rejected', 'synchronized'
      )),
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY(project_id, canvas_id, server_url, room_id, subject),
      CHECK(baseline_json IS NULL OR length(baseline_json) <= 8388608),
      CHECK(delivery_id IS NULL OR length(delivery_id) = 36),
      CHECK(snapshot_digest IS NULL OR length(snapshot_digest) = 64),
      FOREIGN KEY(project_id) REFERENCES recent_projects(id) ON DELETE CASCADE,
      FOREIGN KEY(canvas_id) REFERENCES canvas_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_sync_expiry
      ON collaboration_sync_states(expires_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_collaboration_sync_delivery
      ON collaboration_sync_states(delivery_id) WHERE delivery_id IS NOT NULL;
  `,
  `
    CREATE TABLE IF NOT EXISTS collaboration_sync_deliveries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE CHECK(length(delivery_id) = 36),
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      server_url TEXT NOT NULL CHECK(length(server_url) BETWEEN 1 AND 2048),
      room_id TEXT NOT NULL CHECK(length(room_id) BETWEEN 1 AND 80),
      subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 120),
      baseline_json TEXT,
      candidate_json TEXT NOT NULL CHECK(length(candidate_json) <= 8388608),
      snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64),
      disposition TEXT NOT NULL CHECK(disposition IN (
        'sent', 'queued-offline', 'acknowledged', 'rejected'
      )),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      CHECK(baseline_json IS NULL OR length(baseline_json) <= 8388608),
      FOREIGN KEY(project_id, canvas_id, server_url, room_id, subject)
        REFERENCES collaboration_sync_states(
          project_id, canvas_id, server_url, room_id, subject
        ) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_delivery_scope_sequence
      ON collaboration_sync_deliveries(
        project_id, canvas_id, server_url, room_id, subject, sequence
      );
    CREATE INDEX IF NOT EXISTS idx_collaboration_delivery_expiry
      ON collaboration_sync_deliveries(expires_at, sequence);
    INSERT OR IGNORE INTO collaboration_sync_deliveries(
      delivery_id, project_id, canvas_id, server_url, room_id, subject, baseline_json,
      candidate_json, snapshot_digest, disposition, created_at, expires_at
    )
    SELECT delivery_id, project_id, canvas_id, server_url, room_id, subject, baseline_json,
           pending_json, snapshot_digest, disposition, updated_at, expires_at
    FROM collaboration_sync_states
    WHERE delivery_id IS NOT NULL AND snapshot_digest IS NOT NULL
      AND disposition IN ('sent', 'queued-offline', 'acknowledged', 'rejected');
  `,
  `
    CREATE TABLE IF NOT EXISTS settings_repair_history (
      id TEXT PRIMARY KEY CHECK(length(id) = 36),
      repaired_at TEXT NOT NULL,
      source_database_version INTEGER NOT NULL CHECK(source_database_version >= 0),
      repaired_fields_json TEXT NOT NULL CHECK(length(repaired_fields_json) <= 16384),
      source_settings_sha256 TEXT NOT NULL CHECK(length(source_settings_sha256) = 64),
      repaired_settings_sha256 TEXT NOT NULL CHECK(length(repaired_settings_sha256) = 64),
      source_settings_json TEXT NOT NULL CHECK(
        length(CAST(source_settings_json AS BLOB)) <= ${SETTINGS_REPAIR_EVIDENCE_MAX_BYTES}
      ),
      repaired_settings_json TEXT NOT NULL CHECK(
        length(CAST(repaired_settings_json AS BLOB)) <= ${SETTINGS_REPAIR_EVIDENCE_MAX_BYTES}
      )
    );
    CREATE INDEX IF NOT EXISTS idx_settings_repair_history_repaired
      ON settings_repair_history(repaired_at DESC, id DESC);
    CREATE TRIGGER IF NOT EXISTS settings_repair_history_no_update
    BEFORE UPDATE ON settings_repair_history
    BEGIN
      SELECT RAISE(ABORT, 'settings repair evidence is immutable');
    END;
  `,
  `
    CREATE TABLE IF NOT EXISTS collaboration_rejected_comment_dismissals (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      server_url TEXT NOT NULL CHECK(length(server_url) BETWEEN 1 AND 2048),
      room_id TEXT NOT NULL CHECK(length(room_id) BETWEEN 1 AND 80),
      subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 120),
      comment_id TEXT NOT NULL CHECK(length(comment_id) BETWEEN 1 AND 120),
      comment_json TEXT NOT NULL CHECK(
        length(CAST(comment_json AS BLOB)) <= ${COLLABORATION_REJECTED_DISMISSAL_MAX_COMMENT_BYTES}
      ),
      comment_digest TEXT NOT NULL CHECK(length(comment_digest) = 64),
      rejected_through_sequence INTEGER NOT NULL,
      dismissed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE(
        project_id, canvas_id, server_url, room_id, subject, comment_id,
        comment_digest, rejected_through_sequence
      ),
      FOREIGN KEY(project_id, canvas_id, server_url, room_id, subject)
        REFERENCES collaboration_sync_states(
          project_id, canvas_id, server_url, room_id, subject
        ) ON DELETE CASCADE,
      FOREIGN KEY(rejected_through_sequence)
        REFERENCES collaboration_sync_deliveries(sequence) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_rejected_dismissal_scope
      ON collaboration_rejected_comment_dismissals(
        project_id, canvas_id, server_url, room_id, subject, comment_id
      );
    CREATE INDEX IF NOT EXISTS idx_collaboration_rejected_dismissal_expiry
      ON collaboration_rejected_comment_dismissals(expires_at, sequence);
  `,
  DELIVERY_READINESS_STORAGE_SQL,
  `
    CREATE TABLE IF NOT EXISTS github_cli_executable_binding (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      value_json TEXT NOT NULL CHECK(
        length(CAST(value_json AS BLOB)) BETWEEN 2 AND 131072
      )
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS terminal_sessions (
      id TEXT PRIMARY KEY CHECK(length(id) = 36),
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
      status TEXT NOT NULL CHECK(status IN (
        'starting', 'running', 'exited', 'failed', 'interrupted', 'terminated', 'lost'
      )),
      updated_at TEXT NOT NULL,
      value_json TEXT NOT NULL CHECK(length(CAST(value_json AS BLOB)) <= 1048576),
      FOREIGN KEY(project_id) REFERENCES recent_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_sessions_project_updated
      ON terminal_sessions(project_id, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_terminal_sessions_node_updated
      ON terminal_sessions(project_id, node_id, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_terminal_sessions_recovery
      ON terminal_sessions(status, updated_at, id);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_agent_runs_project_node_updated
      ON agent_runs(project_id, node_id, updated_at DESC, id DESC);
  `,
] as const;

export function openDatabase(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA busy_timeout = 5000;');
    database.exec('PRAGMA trusted_schema = OFF;');
    database.exec('PRAGMA secure_delete = ON;');
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the initialization error when SQLite also rejects cleanup.
    }
    throw error;
  }
}

export function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const result = operation();
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

export function migrate(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version;').get() as
    | { user_version: number }
    | undefined;
  const current = versionRow?.user_version ?? 0;
  for (let index = current; index < MIGRATIONS.length; index += 1) {
    const migration = MIGRATIONS[index];
    if (!migration) throw new Error(`Missing migration ${index + 1}.`);
    transaction(database, () => {
      database.exec(migration);
      database
        .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)')
        .run(index + 1, new Date().toISOString());
      database.exec(`PRAGMA user_version = ${index + 1};`);
    });
  }
}

export function clearAllTables(database: DatabaseSync): void {
  database.prepare('DELETE FROM github_cli_executable_binding').run();
  database.prepare('DELETE FROM terminal_sessions').run();
  database.prepare('DELETE FROM settings_repair_history').run();
  database.prepare('DELETE FROM backup_health').run();
  database.prepare('DELETE FROM delivery_readiness_approvals').run();
  database.prepare('DELETE FROM delivery_readiness_records').run();
  database.prepare('DELETE FROM git_review_notes').run();
  database.prepare('DELETE FROM collaboration_rejected_comment_dismissals').run();
  database.prepare('DELETE FROM collaboration_sync_deliveries').run();
  database.prepare('DELETE FROM collaboration_sync_states').run();
  database.prepare('DELETE FROM workflow_executions').run();
  database.prepare('DELETE FROM check_executions').run();
  database.prepare('DELETE FROM trusted_extension_ledger').run();
  database.prepare('DELETE FROM approval_records').run();
  database.prepare('DELETE FROM canvas_snapshots').run();
  database.prepare('DELETE FROM canvas_documents').run();
  database.prepare('DELETE FROM project_path_history').run();
  database.prepare('DELETE FROM recent_projects').run();
  database.prepare('DELETE FROM agent_runs').run();
  database.prepare('DELETE FROM app_settings').run();
  resetAuditChain(database);
  database.prepare('DELETE FROM backup_records').run();
}

/**
 * Clears only data represented by a portable Forgeboard export.
 *
 * Backup ownership records, the trusted-extension ledger, and the selected GitHub CLI binding are
 * intentionally device-local security state. A portable replace import must not orphan verified
 * backup files, silently revoke extensions, or import another device's executable identity.
 */
export function clearPortableTables(database: DatabaseSync): void {
  // Workflow recovery records are not part of portable export version 3. Clear them before the
  // canvases they bind to so a replace import cannot retain orphaned runtime state.
  database.prepare('DELETE FROM workflow_executions').run();
  database.prepare('DELETE FROM terminal_sessions').run();
  database.prepare('DELETE FROM delivery_readiness_approvals').run();
  database.prepare('DELETE FROM delivery_readiness_records').run();
  database.prepare('DELETE FROM git_review_notes').run();
  database.prepare('DELETE FROM collaboration_rejected_comment_dismissals').run();
  database.prepare('DELETE FROM collaboration_sync_deliveries').run();
  database.prepare('DELETE FROM collaboration_sync_states').run();
  database.prepare('DELETE FROM check_executions').run();
  database.prepare('DELETE FROM approval_records').run();
  database.prepare('DELETE FROM canvas_snapshots').run();
  database.prepare('DELETE FROM canvas_documents').run();
  database.prepare('DELETE FROM project_path_history').run();
  database.prepare('DELETE FROM recent_projects').run();
  database.prepare('DELETE FROM agent_runs').run();
  database.prepare('DELETE FROM app_settings').run();
  resetAuditChain(database);
}

export interface TransactionalAuditEvent {
  readonly category: string;
  readonly action: string;
  readonly outcome: 'allowed' | 'denied' | 'failed';
  readonly metadata: Record<string, unknown>;
  readonly occurredAt?: Date;
}
