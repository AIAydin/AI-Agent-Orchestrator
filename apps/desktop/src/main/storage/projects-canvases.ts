import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { ProjectSchema, type CanvasDocument, type Project } from '../../shared/contracts.js';
import { CanvasSnapshotSchema, type CanvasSnapshot } from '../storage-schemas.js';
import { transaction } from './database.js';
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
  const parsedDocument = sanitizeCanvasDocument(document);
  if (parsedDocument.projectId !== parsedProject.id) {
    throw new Error('Canvas project does not match the project being saved.');
  }
  return transaction(database, () => {
    writeProject(database, parsedProject);
    writeCanvas(database, parsedDocument, true, 'autosave');
    return parsedDocument;
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
  const parsed = sanitizeCanvasDocument(document);
  return transaction(database, () => {
    writeCanvas(database, parsed, true, 'autosave');
    return parsed;
  });
}

export function createCanvasSnapshot(
  database: DatabaseSync,
  projectId: string,
  reason: 'manual' | 'import' = 'manual',
): CanvasSnapshot {
  const document = loadCanvas(database, projectId);
  if (!document) throw new Error('No canvas exists for this project.');
  return transaction(database, () => insertCanvasSnapshot(database, document, reason));
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
       WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
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
  const row = database
    .prepare('SELECT value_json FROM canvas_snapshots WHERE id = ?')
    .get(snapshotId) as JsonRow | undefined;
  if (!row) throw new Error('The requested canvas snapshot does not exist.');
  const parsedSnapshot = CanvasSnapshotSchema.parse(parseJson(row.value_json));
  const snapshot = sanitizeReadableCanvasSnapshot(parsedSnapshot);
  if (!isDeepStrictEqual(parsedSnapshot, snapshot)) writeSnapshot(database, snapshot);
  const restored = sanitizeCanvasDocument({
    ...snapshot.document,
    updatedAt: restoredAt.toISOString(),
  });
  return transaction(database, () => {
    const current = loadCanvas(database, snapshot.projectId);
    if (current && canvasContentHash(current) !== canvasContentHash(restored)) {
      insertCanvasSnapshot(database, current, 'restore');
    }
    writeCanvas(database, restored, false, 'restore');
    return restored;
  });
}

export { loadCanvas };
