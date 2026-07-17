const MAX_RECORD_BYTES = 4 * 1_024 * 1_024;
const MAX_APPROVAL_BYTES = 1 * 1_024 * 1_024;

/** Root-migration fragment for content-bound readiness and bounded immutable human evidence. */
export const DELIVERY_READINESS_STORAGE_SQL = `
  CREATE TABLE IF NOT EXISTS delivery_readiness_records (
    id TEXT PRIMARY KEY CHECK(length(id) = 36),
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL CHECK(length(worktree_id) = 36),
    source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint) = 64),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    value_json TEXT NOT NULL CHECK(length(CAST(value_json AS BLOB)) <= ${String(MAX_RECORD_BYTES)}),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES recent_projects(id) ON DELETE CASCADE,
    FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_readiness_target_updated
    ON delivery_readiness_records(project_id, run_id, updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_delivery_readiness_source
    ON delivery_readiness_records(project_id, run_id, source_fingerprint, updated_at DESC);
  CREATE TRIGGER IF NOT EXISTS delivery_readiness_records_run_project_insert
  BEFORE INSERT ON delivery_readiness_records
  WHEN NOT EXISTS(
    SELECT 1 FROM agent_runs
    WHERE id = NEW.run_id AND project_id = NEW.project_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'delivery readiness run does not belong to its project');
  END;
  CREATE TRIGGER IF NOT EXISTS delivery_readiness_records_run_project_update
  BEFORE UPDATE OF project_id, run_id ON delivery_readiness_records
  WHEN NOT EXISTS(
    SELECT 1 FROM agent_runs
    WHERE id = NEW.run_id AND project_id = NEW.project_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'delivery readiness run does not belong to its project');
  END;

  CREATE TABLE IF NOT EXISTS delivery_readiness_approvals (
    id TEXT PRIMARY KEY CHECK(length(id) = 36),
    readiness_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    authority TEXT NOT NULL CHECK(authority = 'human'),
    source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint) = 64),
    evidence_fingerprint TEXT NOT NULL CHECK(length(evidence_fingerprint) = 64),
    approved_at TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK(length(CAST(value_json AS BLOB)) <= ${String(MAX_APPROVAL_BYTES)}),
    FOREIGN KEY(readiness_id) REFERENCES delivery_readiness_records(id) ON DELETE CASCADE,
    FOREIGN KEY(project_id) REFERENCES recent_projects(id) ON DELETE CASCADE,
    FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
    UNIQUE(readiness_id, evidence_fingerprint)
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_readiness_approvals_readiness
    ON delivery_readiness_approvals(readiness_id, approved_at DESC, id DESC);
  CREATE TRIGGER IF NOT EXISTS delivery_readiness_approvals_exact_source_insert
  BEFORE INSERT ON delivery_readiness_approvals
  WHEN NOT EXISTS(
    SELECT 1 FROM delivery_readiness_records
    WHERE id = NEW.readiness_id
      AND project_id = NEW.project_id
      AND run_id = NEW.run_id
      AND source_fingerprint = NEW.source_fingerprint
  )
  BEGIN
    SELECT RAISE(ABORT, 'delivery readiness approval does not match its source');
  END;
  CREATE TRIGGER IF NOT EXISTS delivery_readiness_approvals_no_update
  BEFORE UPDATE ON delivery_readiness_approvals
  BEGIN
    SELECT RAISE(ABORT, 'delivery readiness approvals are immutable');
  END;
`;

export const DELIVERY_READINESS_REQUIRED_TRIGGERS = Object.freeze([
  'delivery_readiness_records_run_project_insert',
  'delivery_readiness_records_run_project_update',
  'delivery_readiness_approvals_exact_source_insert',
  'delivery_readiness_approvals_no_update',
]);
