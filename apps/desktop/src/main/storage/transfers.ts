import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { ProjectSchema, type CanvasDocument, type Project } from '../../shared/contracts.js';
import {
  LocalDataExportSchema,
  type ImportResult,
  type LocalDataExport,
} from '../storage-schemas.js';
import { clearAllTables, transaction } from './database.js';
import {
  canvasContentHash,
  type AuditRow,
  type JsonRow,
  parseJson,
  sanitizeCanvasDocument,
  sanitizeProject,
  sanitizeReadableCanvasSnapshot,
  validateSettings,
} from './values.js';
import {
  writeAudit,
  writeCanvas,
  writeProject,
  writeRun,
  writeSettings,
  writeSnapshot,
} from './writes.js';

export function exportData(database: DatabaseSync, exportedAt = new Date()): LocalDataExport {
  const settingsRow = database
    .prepare('SELECT value_json FROM app_settings WHERE singleton = 1')
    .get() as JsonRow | undefined;
  const projectRows = database
    .prepare('SELECT value_json FROM recent_projects ORDER BY opened_at DESC')
    .all() as unknown as JsonRow[];
  const canvasRows = database
    .prepare('SELECT value_json FROM canvas_documents ORDER BY updated_at')
    .all() as unknown as JsonRow[];
  const runRows = database
    .prepare('SELECT value_json FROM agent_runs ORDER BY updated_at')
    .all() as unknown as JsonRow[];
  const snapshotRows = database
    .prepare('SELECT value_json FROM canvas_snapshots ORDER BY created_at, id')
    .all() as unknown as JsonRow[];
  const auditRows = database
    .prepare(
      `SELECT sequence, occurred_at, category, action, outcome, metadata_json
       FROM audit_events ORDER BY sequence`,
    )
    .all() as unknown as AuditRow[];

  return LocalDataExportSchema.parse({
    format: 'forgeboard-local-export',
    version: 2,
    exportedAt: exportedAt.toISOString(),
    settings: settingsRow ? parseJson(settingsRow.value_json) : null,
    projects: projectRows.map((row) =>
      sanitizeProject(ProjectSchema.parse(parseJson(row.value_json))),
    ),
    canvases: canvasRows.map((row) => sanitizeCanvasDocument(parseJson(row.value_json))),
    runs: runRows.map((row) => parseJson(row.value_json)),
    snapshots: snapshotRows.map((row) => sanitizeReadableCanvasSnapshot(parseJson(row.value_json))),
    audit: auditRows.map((row) => ({
      sequence: row.sequence,
      occurredAt: row.occurred_at,
      category: row.category,
      action: row.action,
      outcome: row.outcome,
      metadata: parseJson(row.metadata_json),
    })),
  });
}

export function importData(
  database: DatabaseSync,
  document: unknown,
  options: { replaceExisting?: boolean } = {},
): ImportResult {
  const parsed = LocalDataExportSchema.parse(document);
  assertCanonicalImportedExtensionData(parsed);
  validateImportReferences(database, parsed, Boolean(options.replaceExisting));
  transaction(database, () => {
    if (options.replaceExisting) clearAllTables(database);
    if (parsed.settings) writeSettings(database, validateSettings(parsed.settings));
    for (const project of parsed.projects) writeProject(database, project);
    for (const canvas of parsed.canvases) writeCanvas(database, canvas, false, 'import');
    for (const run of parsed.runs) writeRun(database, run);
    for (const snapshot of parsed.snapshots) writeSnapshot(database, snapshot);
    for (const event of parsed.audit) {
      writeAudit(
        database,
        event.occurredAt,
        event.category,
        event.action,
        event.outcome,
        event.metadata,
      );
    }
  });
  return {
    projects: parsed.projects.length,
    canvases: parsed.canvases.length,
    runs: parsed.runs.length,
    snapshots: parsed.snapshots.length,
    auditEvents: parsed.audit.length,
  };
}

function listAllProjects(database: DatabaseSync): Project[] {
  const rows = database
    .prepare('SELECT value_json FROM recent_projects ORDER BY opened_at DESC LIMIT 10000')
    .all() as unknown as JsonRow[];
  return rows.map((row) => sanitizeProject(ProjectSchema.parse(parseJson(row.value_json))));
}

function validateImportReferences(
  database: DatabaseSync,
  document: LocalDataExport,
  replacing: boolean,
): void {
  const existingProjects = replacing ? [] : listAllProjects(database);
  const existingById = new Map(existingProjects.map((project) => [project.id, project]));
  const existingByPath = new Map(existingProjects.map((project) => [project.path, project]));
  const importedProjectIds = new Set<string>();
  const importedProjectPaths = new Set<string>();
  const projectIds = new Set(existingProjects.map((project) => project.id));
  for (const project of document.projects) {
    if (importedProjectIds.has(project.id)) {
      throw new Error(`The import contains duplicate project id ${project.id}.`);
    }
    if (importedProjectPaths.has(project.path)) {
      throw new Error(`The import contains a conflicting project path: ${project.path}`);
    }
    const sameId = existingById.get(project.id);
    if (sameId && sameId.path !== project.path) {
      throw new Error(`Project ${project.id} already exists at a different path.`);
    }
    const samePath = existingByPath.get(project.path);
    if (samePath && samePath.id !== project.id) {
      throw new Error(`The import contains a conflicting project path: ${project.path}`);
    }
    importedProjectIds.add(project.id);
    importedProjectPaths.add(project.path);
    projectIds.add(project.id);
  }
  const canvasProjectIds = new Set<string>();
  const canvasIds = new Set<string>();
  for (const canvas of document.canvases) {
    if (!projectIds.has(canvas.projectId)) {
      throw new Error(`Canvas ${canvas.id} references an unknown project.`);
    }
    if (canvasIds.has(canvas.id)) {
      throw new Error(`The import contains duplicate canvas id ${canvas.id}.`);
    }
    if (canvasProjectIds.has(canvas.projectId)) {
      throw new Error(`The import contains more than one canvas for project ${canvas.projectId}.`);
    }
    canvasIds.add(canvas.id);
    canvasProjectIds.add(canvas.projectId);
  }
  const runIds = new Set<string>();
  const existingRun = replacing
    ? undefined
    : database.prepare('SELECT 1 FROM agent_runs WHERE id = ?');
  for (const run of document.runs) {
    if (!projectIds.has(run.projectId)) {
      throw new Error(`Run ${run.id} references an unknown project.`);
    }
    if (runIds.has(run.id)) throw new Error(`The import contains duplicate run id ${run.id}.`);
    if (existingRun?.get(run.id) !== undefined) {
      throw new Error(`Run ${run.id} already exists; merge imports cannot replace run history.`);
    }
    runIds.add(run.id);
  }
  const snapshotIds = new Set<string>();
  for (const snapshot of document.snapshots) {
    if (!projectIds.has(snapshot.projectId)) {
      throw new Error(`Snapshot ${snapshot.id} references an unknown project.`);
    }
    if (canvasContentHash(snapshot.document) !== snapshot.contentHash) {
      throw new Error(`Snapshot ${snapshot.id} has an invalid content hash.`);
    }
    if (snapshotIds.has(snapshot.id)) {
      throw new Error(`The import contains duplicate snapshot id ${snapshot.id}.`);
    }
    snapshotIds.add(snapshot.id);
  }
  const auditSequences = new Set<number>();
  for (const event of document.audit) {
    if (auditSequences.has(event.sequence)) {
      throw new Error(`The import contains duplicate audit sequence ${event.sequence}.`);
    }
    auditSequences.add(event.sequence);
  }
}

function assertCanonicalImportedExtensionData(document: LocalDataExport): void {
  for (const canvas of document.canvases) {
    let sanitized: CanvasDocument;
    try {
      sanitized = sanitizeCanvasDocument(canvas);
    } catch (error) {
      throw new Error(`Canvas ${canvas.id} contains invalid extension data.`, { cause: error });
    }
    if (!isDeepStrictEqual(canvas, sanitized)) {
      throw new Error(
        `Canvas ${canvas.id} contains non-canonical extension data that would be rewritten.`,
      );
    }
  }
  for (const snapshot of document.snapshots) {
    let sanitized: CanvasDocument;
    try {
      sanitized = sanitizeCanvasDocument(snapshot.document);
    } catch (error) {
      throw new Error(`Snapshot ${snapshot.id} contains invalid extension data.`, {
        cause: error,
      });
    }
    if (!isDeepStrictEqual(snapshot.document, sanitized)) {
      throw new Error(
        `Snapshot ${snapshot.id} contains non-canonical extension data that would be rewritten.`,
      );
    }
  }
}
