import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import {
  ProjectSchema,
  type CanvasDocument,
  type Project,
} from '../../shared/application/contracts.js';
import {
  LocalDataExportSchema,
  type ImportResult,
  type LocalDataExport,
} from '../storage-schemas.js';
import { saveCheckExecution } from './checks.js';
import { clearPortableTables, transaction, type TransactionalAuditEvent } from './database.js';
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
  const checkExecutionRows = database
    .prepare('SELECT value_json FROM check_executions ORDER BY updated_at, id')
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
    version: 3,
    exportedAt: exportedAt.toISOString(),
    settings: settingsRow ? parseJson(settingsRow.value_json) : null,
    projects: projectRows.map((row) =>
      sanitizeProject(ProjectSchema.parse(parseJson(row.value_json))),
    ),
    canvases: canvasRows.map((row) => sanitizeCanvasDocument(parseJson(row.value_json))),
    runs: runRows.map((row) => parseJson(row.value_json)),
    checkExecutions: checkExecutionRows.map((row) => parseJson(row.value_json)),
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
  options: PortableImportOptions = {},
): ImportResult {
  return importValidatedData(database, document, options);
}

export function importDataWithAudit(
  database: DatabaseSync,
  document: unknown,
  options: PortableImportOptions,
  audit: TransactionalAuditEvent,
): ImportResult {
  return importValidatedData(database, document, options, audit);
}

export function preflightImportData(
  database: DatabaseSync,
  document: unknown,
  options: PortableImportOptions = {},
): ImportResult {
  const parsed = parseImportDocument(document);
  validateImportReferences(database, parsed, Boolean(options.replaceExisting));
  return importResult(parsed);
}

function importValidatedData(
  database: DatabaseSync,
  document: unknown,
  options: PortableImportOptions,
  audit?: TransactionalAuditEvent,
): ImportResult {
  const parsed = parseImportDocument(document);
  const replacing = Boolean(options.replaceExisting);
  return transaction(database, () => {
    // Repeat the same collision validation used by preflight while holding the write transaction.
    // This keeps the final decision and all writes atomic even if another database connection exists.
    validateImportReferences(database, parsed, replacing);
    const normalized = normalizeInterruptedRecords(parsed, options.importedAt ?? new Date());
    const shouldWriteSettings = replacing;
    if (replacing) clearPortableTables(database);
    if (normalized.document.settings && shouldWriteSettings) {
      writeSettings(database, validateSettings(normalized.document.settings));
    }
    for (const project of normalized.document.projects) writeProject(database, project);
    for (const canvas of normalized.document.canvases) {
      writeCanvas(database, canvas, false, 'import');
    }
    for (const run of normalized.document.runs) writeRun(database, run);
    for (const execution of normalized.document.checkExecutions) {
      saveCheckExecution(database, execution);
    }
    for (const snapshot of normalized.document.snapshots) writeSnapshot(database, snapshot);
    for (const event of normalized.document.audit) {
      writeAudit(
        database,
        event.occurredAt,
        event.category,
        event.action,
        event.outcome,
        event.metadata,
      );
    }
    if (audit !== undefined) {
      writeAudit(
        database,
        (audit.occurredAt ?? new Date()).toISOString(),
        audit.category,
        audit.action,
        audit.outcome,
        {
          ...audit.metadata,
          normalizedInterruptedRecords: {
            runs: normalized.normalizedRuns,
            checkExecutions: normalized.normalizedCheckExecutions,
          },
        },
      );
    }
    return importResult(parsed);
  });
}

export interface PortableImportOptions {
  readonly replaceExisting?: boolean;
  readonly importedAt?: Date;
}

interface NormalizedImport {
  readonly document: LocalDataExport;
  readonly normalizedRuns: number;
  readonly normalizedCheckExecutions: number;
}

function normalizeInterruptedRecords(
  document: LocalDataExport,
  importedAt: Date,
): NormalizedImport {
  if (!Number.isFinite(importedAt.getTime())) throw new Error('Import time must be valid.');
  let normalizedRuns = 0;
  let normalizedCheckExecutions = 0;
  const runs = document.runs.map((run) => {
    if (run.status !== 'prepared' && run.status !== 'running') return run;
    normalizedRuns += 1;
    const recoveredAt = boundedImportTimestamp(importedAt, run.updatedAt, run.startedAt);
    return {
      ...run,
      status: 'lost' as const,
      endedAt: recoveredAt,
      exitCode: null,
      updatedAt: recoveredAt,
    };
  });
  const checkExecutions = document.checkExecutions.map((execution) => {
    if (execution.status !== 'queued' && execution.status !== 'running') return execution;
    normalizedCheckExecutions += 1;
    const recoveredAt = boundedImportTimestamp(
      importedAt,
      execution.updatedAt,
      execution.startedAt,
    );
    return {
      ...execution,
      status: 'lost' as const,
      exitCode: null,
      endedAt: recoveredAt,
      updatedAt: recoveredAt,
    };
  });
  return {
    document: { ...document, runs, checkExecutions },
    normalizedRuns,
    normalizedCheckExecutions,
  };
}

function boundedImportTimestamp(importedAt: Date, ...timestamps: Array<string | null>): string {
  const latest = timestamps.reduce(
    (current, timestamp) =>
      timestamp === null ? current : Math.max(current, Date.parse(timestamp)),
    importedAt.getTime(),
  );
  return new Date(latest).toISOString();
}

function parseImportDocument(document: unknown): LocalDataExport {
  const parsed = LocalDataExportSchema.parse(document);
  if (parsed.settings !== null) validateSettings(parsed.settings);
  assertCanonicalImportedData(parsed);
  return parsed;
}

function importResult(parsed: LocalDataExport): ImportResult {
  return {
    projects: parsed.projects.length,
    canvases: parsed.canvases.length,
    runs: parsed.runs.length,
    checkExecutions: parsed.checkExecutions.length,
    snapshots: parsed.snapshots.length,
    auditEvents: parsed.audit.length,
  };
}

function listAllProjects(database: DatabaseSync): Project[] {
  const rows = database
    .prepare('SELECT value_json FROM recent_projects ORDER BY opened_at DESC')
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
    if (existingById.has(project.id)) {
      throw new Error(`Project ${project.id} already exists; merge imports cannot replace it.`);
    }
    const samePath = existingByPath.get(project.path);
    if (samePath) {
      throw new Error(
        `Project path ${project.path} already exists; merge imports cannot reuse it.`,
      );
    }
    importedProjectIds.add(project.id);
    importedProjectPaths.add(project.path);
    projectIds.add(project.id);
  }
  const canvasProjectIds = new Set<string>();
  const canvasIds = new Set<string>();
  const existingCanvasById = replacing
    ? undefined
    : database.prepare('SELECT project_id FROM canvas_documents WHERE id = ?');
  const existingCanvasByProject = replacing
    ? undefined
    : database.prepare('SELECT id FROM canvas_documents WHERE project_id = ?');
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
    if (existingCanvasById?.get(canvas.id) !== undefined) {
      throw new Error(`Canvas ${canvas.id} already exists; merge imports cannot replace it.`);
    }
    if (existingCanvasByProject?.get(canvas.projectId) !== undefined) {
      throw new Error(
        `Project ${canvas.projectId} already has a canvas; merge imports cannot replace it.`,
      );
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
  const existingSnapshot = replacing
    ? undefined
    : database.prepare('SELECT 1 FROM canvas_snapshots WHERE id = ?');

  const checkExecutionIds = new Set<string>();
  const existingCheckExecution = replacing
    ? undefined
    : database.prepare('SELECT 1 FROM check_executions WHERE id = ?');
  for (const execution of document.checkExecutions) {
    if (!projectIds.has(execution.projectId)) {
      throw new Error(`Check execution ${execution.id} references an unknown project.`);
    }
    if (checkExecutionIds.has(execution.id)) {
      throw new Error(`The import contains duplicate check execution id ${execution.id}.`);
    }
    if (existingCheckExecution?.get(execution.id) !== undefined) {
      throw new Error(
        `Check execution ${execution.id} already exists; merge imports cannot replace check history.`,
      );
    }
    checkExecutionIds.add(execution.id);
  }

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
    if (existingSnapshot?.get(snapshot.id) !== undefined) {
      throw new Error(
        `Snapshot ${snapshot.id} already exists; merge imports cannot replace recovery history.`,
      );
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

function assertCanonicalImportedData(document: LocalDataExport): void {
  for (const project of document.projects) {
    const sanitized = sanitizeProject(project);
    if (!isDeepStrictEqual(project, sanitized)) {
      throw new Error(`Project ${project.id} contains non-canonical data that would be rewritten.`);
    }
  }
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
