import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import {
  CanvasDocumentSchema,
  ProjectSchema,
  type CanvasDocument,
  type Project,
} from '../../shared/application/contracts.js';
import { CanvasSnapshotSchema, type CanvasSnapshot } from '../storage-schemas.js';
import { transaction, type TransactionalAuditEvent } from './database.js';
import { clearCanvasHistory } from './canvas-history/repository.js';
import {
  canvasContentHash,
  type JsonRow,
  parseJson,
  sanitizeCanvasDocument,
  sanitizeProject,
  sanitizeReadableCanvasSnapshot,
} from './values.js';
import {
  insertCanvasSnapshot,
  loadCanvas,
  writeAudit,
  writeCanvas,
  writeProject,
  writeSnapshot,
} from './writes.js';

export function listProjects(database: DatabaseSync, limit = 30): Project[] {
  const boundedLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
  const rows = database
    .prepare('SELECT value_json FROM recent_projects ORDER BY opened_at DESC LIMIT ?')
    .all(boundedLimit) as unknown as JsonRow[];
  return rows.map((row) => sanitizeProject(ProjectSchema.parse(JSON.parse(row.value_json))));
}

export function getProject(database: DatabaseSync, projectId: string): Project | undefined {
  const row = database
    .prepare('SELECT value_json FROM recent_projects WHERE id = ?')
    .get(projectId) as JsonRow | undefined;
  return row ? sanitizeProject(ProjectSchema.parse(JSON.parse(row.value_json))) : undefined;
}

export function getProjectByPath(database: DatabaseSync, projectPath: string): Project | undefined {
  const row = database
    .prepare('SELECT value_json FROM recent_projects WHERE path = ?')
    .get(projectPath) as JsonRow | undefined;
  return row ? sanitizeProject(ProjectSchema.parse(JSON.parse(row.value_json))) : undefined;
}

export function saveProject(database: DatabaseSync, project: Project): Project {
  const parsed = sanitizeProject(ProjectSchema.parse(project));
  writeProject(database, parsed);
  return parsed;
}

export function saveProjectAndCanvas(
  database: DatabaseSync,
  project: Project,
  document: CanvasDocument,
): CanvasDocument {
  const parsedProject = sanitizeProject(ProjectSchema.parse(project));
  const parsedDocument = CanvasDocumentSchema.parse(document);
  if (parsedDocument.projectId !== parsedProject.id) {
    throw new Error('Canvas project does not match the project being saved.');
  }
  return transaction(database, () => {
    writeProject(database, parsedProject);
    return writeCanvas(database, parsedDocument, true, 'autosave');
  });
}

export function setProjectMissing(
  database: DatabaseSync,
  projectId: string,
  missing: boolean,
): Project {
  const current = getProject(database, projectId);
  if (!current) throw new Error('The project is not present in recent projects.');
  const updated = ProjectSchema.parse({ ...current, missing });
  database
    .prepare('UPDATE recent_projects SET value_json = ? WHERE id = ?')
    .run(JSON.stringify(updated), projectId);
  return updated;
}

export function relocateProject(database: DatabaseSync, project: Project): Project {
  const parsed = sanitizeProject(ProjectSchema.parse(project));
  return transaction(database, () => {
    const current = getProject(database, parsed.id);
    if (!current) throw new Error('The project is not present in recent projects.');
    if (current.path !== parsed.path) {
      database
        .prepare(
          `INSERT INTO project_path_history(
             project_id, previous_path, replacement_path, relocated_at
           ) VALUES(?, ?, ?, ?)`,
        )
        .run(parsed.id, current.path, parsed.path, parsed.openedAt);
    }
    database
      .prepare(
        `UPDATE recent_projects
         SET path = ?, value_json = ?, opened_at = ?
         WHERE id = ?`,
      )
      .run(parsed.path, JSON.stringify(parsed), parsed.openedAt, parsed.id);
    return parsed;
  });
}

export function saveCanvas(database: DatabaseSync, document: CanvasDocument): CanvasDocument {
  const parsed = CanvasDocumentSchema.parse(document);
  return transaction(database, () => writeCanvas(database, parsed, true, 'autosave'));
}

export function createCanvasSnapshot(
  database: DatabaseSync,
  projectId: string,
  reason: 'manual' | 'import' = 'manual',
): CanvasSnapshot {
  return createSnapshotTransaction(database, projectId, reason);
}

export function createCanvasSnapshotWithAudit(
  database: DatabaseSync,
  projectId: string,
  reason: 'manual' | 'import',
  audit: TransactionalAuditEvent,
): CanvasSnapshot {
  return createSnapshotTransaction(database, projectId, reason, audit);
}

function createSnapshotTransaction(
  database: DatabaseSync,
  projectId: string,
  reason: 'manual' | 'import',
  audit?: TransactionalAuditEvent,
): CanvasSnapshot {
  return transaction(database, () => {
    const document = loadCanvas(database, projectId);
    if (!document) throw new Error('No canvas exists for this project.');
    const snapshot = insertCanvasSnapshot(database, document, reason);
    if (audit !== undefined) {
      writeAudit(
        database,
        (audit.occurredAt ?? new Date()).toISOString(),
        audit.category,
        audit.action,
        audit.outcome,
        audit.metadata,
      );
    }
    return snapshot;
  });
}

export function listCanvasSnapshots(
  database: DatabaseSync,
  projectId: string,
  limit = 100,
): CanvasSnapshot[] {
  const boundedLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
  const rows = database
    .prepare(
      `SELECT value_json FROM canvas_snapshots
       WHERE project_id = ? ORDER BY rowid DESC LIMIT ?`,
    )
    .all(projectId, boundedLimit) as unknown as JsonRow[];
  return rows.map((row) => {
    const parsed = CanvasSnapshotSchema.parse(parseJson(row.value_json));
    const sanitized = sanitizeReadableCanvasSnapshot(parsed);
    if (!isDeepStrictEqual(parsed, sanitized)) writeSnapshot(database, sanitized);
    return sanitized;
  });
}

export function restoreCanvasSnapshot(
  database: DatabaseSync,
  snapshotId: string,
  restoredAt = new Date(),
): CanvasDocument {
  return restoreSnapshotTransaction(database, { snapshotId, restoredAt });
}

export interface AuditedCanvasSnapshotRestore {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly expectedSnapshotContentHash: string;
  readonly expectedCurrentCanvasContentHash: string;
  readonly restoredAt?: Date;
}

export function restoreCanvasSnapshotWithAudit(
  database: DatabaseSync,
  request: AuditedCanvasSnapshotRestore,
  audit: TransactionalAuditEvent,
): CanvasDocument {
  return restoreSnapshotTransaction(
    database,
    { ...request, restoredAt: request.restoredAt ?? new Date() },
    audit,
  );
}

interface SnapshotRestoreTransaction {
  readonly snapshotId: string;
  readonly restoredAt: Date;
  readonly projectId?: string;
  readonly expectedSnapshotContentHash?: string;
  readonly expectedCurrentCanvasContentHash?: string;
}

interface SnapshotRestoreRow extends JsonRow {
  readonly project_id: string;
  readonly canvas_id: string;
  readonly content_hash: string;
}

function restoreSnapshotTransaction(
  database: DatabaseSync,
  request: SnapshotRestoreTransaction,
  audit?: TransactionalAuditEvent,
): CanvasDocument {
  return transaction(database, () => {
    const row = database
      .prepare(
        `SELECT project_id, canvas_id, content_hash, value_json
         FROM canvas_snapshots WHERE id = ?`,
      )
      .get(request.snapshotId) as SnapshotRestoreRow | undefined;
    if (!row) throw new Error('The requested canvas snapshot does not exist.');
    const parsedSnapshot = CanvasSnapshotSchema.parse(parseJson(row.value_json));
    const snapshot = sanitizeReadableCanvasSnapshot(parsedSnapshot);
    if (
      row.project_id !== snapshot.projectId ||
      row.canvas_id !== snapshot.canvasId ||
      row.content_hash !== snapshot.contentHash
    ) {
      throw new Error('The selected snapshot storage record failed content verification.');
    }
    if (!isDeepStrictEqual(parsedSnapshot, snapshot)) writeSnapshot(database, snapshot);
    if (request.projectId !== undefined && snapshot.projectId !== request.projectId) {
      throw new Error('The selected snapshot no longer belongs to the approved project.');
    }
    if (
      request.expectedSnapshotContentHash !== undefined &&
      (snapshot.contentHash !== request.expectedSnapshotContentHash ||
        canvasContentHash(snapshot.document) !== request.expectedSnapshotContentHash)
    ) {
      throw new Error('The selected snapshot changed. Prepare a new restore plan.');
    }
    const current = loadCanvas(database, snapshot.projectId);
    if (
      request.expectedCurrentCanvasContentHash !== undefined &&
      (current === undefined ||
        canvasContentHash(current) !== request.expectedCurrentCanvasContentHash)
    ) {
      throw new Error('The current canvas changed. Prepare a new restore plan.');
    }
    const restored = sanitizeCanvasDocument({
      ...snapshot.document,
      updatedAt: request.restoredAt.toISOString(),
    });
    if (current && canvasContentHash(current) !== canvasContentHash(restored)) {
      insertCanvasSnapshot(database, current, 'restore');
    }
    clearCanvasHistory(database, restored.projectId);
    writeCanvas(database, restored, false, 'restore');
    if (audit !== undefined) {
      writeAudit(
        database,
        (audit.occurredAt ?? new Date()).toISOString(),
        audit.category,
        audit.action,
        audit.outcome,
        audit.metadata,
      );
    }
    return restored;
  });
}

export { loadCanvas };
