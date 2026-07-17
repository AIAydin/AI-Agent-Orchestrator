import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import {
  CanvasDocumentSchema,
  ProjectSchema,
  type AppSettings,
  type CanvasDocument,
  type Project,
} from '../../shared/application/contracts.js';
import {
  CanvasSnapshotSchema,
  effectiveRunWorktreeState,
  StoredRunRecordSchema,
  TrustedExtensionLedgerRecordSchema,
  type CanvasSnapshot,
  type StoredRunRecord,
  type TrustedExtensionLedgerRecord,
} from '../storage-schemas.js';
import {
  canvasContentHash,
  type JsonRow,
  parseJson,
  sanitizeCanvasDocument,
  sanitizeProject,
} from './values.js';
import { appendChainedAudit } from './security/audit-integrity.js';

export function writeSettings(database: DatabaseSync, settings: AppSettings): void {
  database
    .prepare(
      `INSERT INTO app_settings(singleton, value_json, updated_at) VALUES(1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
    )
    .run(JSON.stringify(settings), new Date().toISOString());
}

export function writeProject(database: DatabaseSync, project: Project): void {
  const sanitized = sanitizeProject(ProjectSchema.parse(project));
  const samePath = database
    .prepare('SELECT id FROM recent_projects WHERE path = ?')
    .get(sanitized.path) as { id: string } | undefined;
  if (samePath !== undefined && samePath.id !== sanitized.id) {
    throw new Error('The project path is already bound to a different project identity.');
  }
  const sameId = database
    .prepare('SELECT path FROM recent_projects WHERE id = ?')
    .get(sanitized.id) as { path: string } | undefined;
  if (sameId !== undefined && sameId.path !== sanitized.path) {
    throw new Error('Project relocation must preserve identity through relocateProject().');
  }
  database
    .prepare(
      `INSERT INTO recent_projects(id, path, value_json, opened_at) VALUES(?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json,
       opened_at = excluded.opened_at`,
    )
    .run(sanitized.id, sanitized.path, JSON.stringify(sanitized), sanitized.openedAt);
}

export function loadCanvas(database: DatabaseSync, projectId: string): CanvasDocument | undefined {
  const row = database
    .prepare('SELECT value_json FROM canvas_documents WHERE project_id = ?')
    .get(projectId) as JsonRow | undefined;
  if (!row) return undefined;
  const parsed = CanvasDocumentSchema.parse(parseJson(row.value_json));
  const sanitized = sanitizeCanvasDocument(parsed);
  if (!isDeepStrictEqual(parsed, sanitized)) {
    database
      .prepare('UPDATE canvas_documents SET value_json = ? WHERE project_id = ?')
      .run(JSON.stringify(sanitized), projectId);
  }
  return sanitized;
}

export function writeCanvas(
  database: DatabaseSync,
  document: CanvasDocument,
  capturePrevious: boolean,
  reason: 'autosave' | 'restore' | 'import',
): CanvasDocument {
  const existing = loadCanvas(database, document.projectId);
  const sanitized = sanitizeCanvasDocument({
    ...document,
    canonical: document.canonical ?? existing?.canonical,
  });
  if (capturePrevious && existing && canvasContentHash(existing) !== canvasContentHash(sanitized)) {
    insertCanvasSnapshot(database, existing, reason);
  }
  database
    .prepare(
      `INSERT INTO canvas_documents(id, project_id, value_json, updated_at) VALUES(?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET id = excluded.id, value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
    )
    .run(sanitized.id, sanitized.projectId, JSON.stringify(sanitized), sanitized.updatedAt);
  return sanitized;
}

export function insertCanvasSnapshot(
  database: DatabaseSync,
  document: CanvasDocument,
  reason: 'autosave' | 'manual' | 'restore' | 'import',
): CanvasSnapshot {
  const sanitizedDocument = sanitizeCanvasDocument(document);
  const snapshot = CanvasSnapshotSchema.parse({
    id: randomUUID(),
    projectId: sanitizedDocument.projectId,
    canvasId: sanitizedDocument.id,
    document: sanitizedDocument,
    contentHash: canvasContentHash(sanitizedDocument),
    createdAt: new Date().toISOString(),
    reason,
  });
  writeSnapshot(database, snapshot);
  return snapshot;
}

export function writeSnapshot(database: DatabaseSync, snapshot: CanvasSnapshot): void {
  const parsedInput = CanvasSnapshotSchema.parse(snapshot);
  const document = sanitizeCanvasDocument(parsedInput.document);
  const parsed = CanvasSnapshotSchema.parse({
    ...parsedInput,
    document,
    contentHash: canvasContentHash(document),
  });
  database
    .prepare(
      `INSERT INTO canvas_snapshots(
         id, project_id, canvas_id, content_hash, reason, value_json, created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id,
         canvas_id = excluded.canvas_id, content_hash = excluded.content_hash,
         reason = excluded.reason, value_json = excluded.value_json,
         created_at = excluded.created_at`,
    )
    .run(
      parsed.id,
      parsed.projectId,
      parsed.canvasId,
      parsed.contentHash,
      parsed.reason,
      JSON.stringify(parsed),
      parsed.createdAt,
    );
}

export function writeRun(database: DatabaseSync, record: StoredRunRecord): void {
  writeRunWithLifecyclePolicy(database, record, false);
}

/** Persistence capability reserved for the exact run-worktree lifecycle transition operation. */
export function writeRunForWorktreeTransition(
  database: DatabaseSync,
  record: StoredRunRecord,
): void {
  writeRunWithLifecyclePolicy(database, record, true);
}

function writeRunWithLifecyclePolicy(
  database: DatabaseSync,
  record: StoredRunRecord,
  allowWorktreeStateChange: boolean,
): void {
  const current = database
    .prepare('SELECT value_json FROM agent_runs WHERE id = ?')
    .get(record.id) as JsonRow | undefined;
  if (current !== undefined) {
    const existing = StoredRunRecordSchema.parse(parseJson(current.value_json));
    if (
      existing.projectId !== record.projectId ||
      existing.nodeId !== record.nodeId ||
      existing.adapterId !== record.adapterId ||
      (existing.model ?? null) !== (record.model ?? null) ||
      (existing.permissionProfile ?? null) !== (record.permissionProfile ?? null) ||
      (existing.action ?? 'launch') !== (record.action ?? 'launch') ||
      (existing.parentRunId ?? null) !== (record.parentRunId ?? null) ||
      existing.createdAt !== record.createdAt ||
      existing.cwd !== record.cwd ||
      existing.branch !== record.branch ||
      existing.worktreeId !== record.worktreeId ||
      existing.repositoryRoot !== record.repositoryRoot ||
      existing.managedRoot !== record.managedRoot ||
      existing.baseRef !== record.baseRef ||
      existing.baseCommit !== record.baseCommit
    ) {
      throw new Error('A run record cannot change its persisted identity.');
    }
    if (
      !allowWorktreeStateChange &&
      effectiveRunWorktreeState(existing) !== effectiveRunWorktreeState(record)
    ) {
      throw new Error(
        'A run worktree lifecycle can change only through its exact transition operation.',
      );
    }
  }
  database
    .prepare(
      `INSERT INTO agent_runs(
         id, project_id, node_id, adapter_id, status, value_json, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
    )
    .run(
      record.id,
      record.projectId,
      record.nodeId,
      record.adapterId,
      record.status,
      JSON.stringify(record),
      record.createdAt,
      record.updatedAt,
    );
}

export function assertTrustedExtensionReplacementIsCurrent(
  current: TrustedExtensionLedgerRecord | undefined,
  replacement: TrustedExtensionLedgerRecord,
): void {
  if (!current) return;
  if (
    current.operationId === replacement.operationId &&
    (current.schemaVersion !== replacement.schemaVersion ||
      current.extensionVersion !== replacement.extensionVersion ||
      current.manifestDigest !== replacement.manifestDigest ||
      current.snapshotDigest !== replacement.snapshotDigest ||
      JSON.stringify(current.permissions) !== JSON.stringify(replacement.permissions) ||
      current.approvedAt !== replacement.approvedAt)
  ) {
    throw new Error('A trusted extension operation cannot change its approved content.');
  }
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const replacementUpdatedAt = Date.parse(replacement.updatedAt);
  if (
    replacementUpdatedAt < currentUpdatedAt ||
    (replacementUpdatedAt === currentUpdatedAt && replacement.operationId !== current.operationId)
  ) {
    throw new Error('A stale trusted extension operation cannot replace a newer ledger entry.');
  }
}

export function writeTrustedExtension(
  database: DatabaseSync,
  record: TrustedExtensionLedgerRecord,
): void {
  const parsed = TrustedExtensionLedgerRecordSchema.parse(record);
  const permissionsJson = JSON.stringify(parsed.permissions);
  database
    .prepare(
      `INSERT INTO trusted_extension_ledger(
         extension_id, schema_version, extension_version, manifest_digest, snapshot_digest,
         permissions_json, approved_at, state, operation_id, value_json, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(extension_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         extension_version = excluded.extension_version,
         manifest_digest = excluded.manifest_digest,
         snapshot_digest = excluded.snapshot_digest,
         permissions_json = excluded.permissions_json,
         approved_at = excluded.approved_at,
         state = excluded.state,
         operation_id = excluded.operation_id,
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      parsed.extensionId,
      parsed.schemaVersion,
      parsed.extensionVersion,
      parsed.manifestDigest,
      parsed.snapshotDigest,
      permissionsJson,
      parsed.approvedAt,
      parsed.state,
      parsed.operationId,
      JSON.stringify(parsed),
      parsed.updatedAt,
    );
}

export function writeAudit(
  database: DatabaseSync,
  occurredAt: string,
  category: string,
  action: string,
  outcome: 'allowed' | 'denied' | 'failed',
  metadata: Record<string, unknown>,
): void {
  appendChainedAudit(database, occurredAt, category, action, outcome, metadata);
}
