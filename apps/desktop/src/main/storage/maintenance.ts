import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import {
  CanvasDocumentSchema,
  ProjectSchema,
  type AppSettings,
} from '../../shared/application/contracts.js';
import { CanvasSnapshotSchema, type RetentionResult } from '../storage-schemas.js';
import { transaction } from './database.js';
import {
  canvasContentHash,
  type JsonRow,
  parseJson,
  safeParseJson,
  sanitizeCanvasDocument,
  sanitizeCanvasSnapshot,
  sanitizeProject,
  scrubCanvasTranscripts,
  subtractDays,
  validateSettings,
} from './values.js';
import { writeCanvas, writeSnapshot } from './writes.js';
import { pruneAuditPrefix } from './security/audit-integrity.js';

export function redactStoredSecrets(database: DatabaseSync): void {
  transaction(database, () => {
    const projects = database
      .prepare('SELECT id, value_json FROM recent_projects')
      .all() as unknown as { id: string; value_json: string }[];
    for (const row of projects) {
      const parsed = ProjectSchema.safeParse(safeParseJson(row.value_json));
      if (!parsed.success) continue;
      const sanitized = sanitizeProject(parsed.data);
      const value = JSON.stringify(sanitized);
      if (value !== row.value_json) {
        database
          .prepare('UPDATE recent_projects SET value_json = ? WHERE id = ?')
          .run(value, row.id);
      }
    }
  });
}

export function sanitizeStoredExtensionData(database: DatabaseSync): void {
  transaction(database, () => {
    const canvases = database
      .prepare('SELECT project_id, value_json FROM canvas_documents')
      .all() as unknown as { project_id: string; value_json: string }[];
    for (const row of canvases) {
      const parsed = CanvasDocumentSchema.parse(parseJson(row.value_json));
      const sanitized = sanitizeCanvasDocument(parsed);
      if (!isDeepStrictEqual(parsed, sanitized)) {
        database
          .prepare('UPDATE canvas_documents SET value_json = ? WHERE project_id = ?')
          .run(JSON.stringify(sanitized), row.project_id);
      }
    }

    const snapshots = database
      .prepare('SELECT value_json FROM canvas_snapshots')
      .all() as unknown as JsonRow[];
    for (const row of snapshots) {
      const parsed = CanvasSnapshotSchema.parse(parseJson(row.value_json));
      const sanitized = sanitizeCanvasSnapshot(parsed);
      if (!isDeepStrictEqual(parsed, sanitized)) writeSnapshot(database, sanitized);
    }
  });
}

export function applyRetention(
  database: DatabaseSync,
  settings: AppSettings,
  now = new Date(),
): RetentionResult {
  const parsed = validateSettings(settings);
  const runCutoff = subtractDays(now, parsed.transcriptRetentionDays);
  const auditCutoff = subtractDays(now, parsed.auditRetentionDays);
  return transaction(database, () => {
    const deletedRuns = Number(
      database
        .prepare(
          `DELETE FROM agent_runs
           WHERE updated_at < ? AND status NOT IN ('prepared', 'running')`,
        )
        .run(runCutoff).changes,
    );
    const deletedCheckExecutions = Number(
      database
        .prepare(
          `DELETE FROM check_executions
           WHERE updated_at < ? AND status NOT IN ('queued', 'running')`,
        )
        .run(runCutoff).changes,
    );
    const deletedAuditEvents = pruneAuditPrefix(database, auditCutoff, now);
    const deletedSnapshots = Number(
      database
        .prepare(
          `DELETE FROM canvas_snapshots WHERE id IN (
             SELECT id FROM (
               SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY canvas_id ORDER BY rowid DESC
                 ) AS retention_rank
               FROM canvas_snapshots
             ) WHERE retention_rank > ?
           )`,
        )
        .run(parsed.snapshotRetentionCount).changes,
    );
    const transcriptResult = scrubExpiredTranscripts(database, runCutoff);
    return {
      deletedRuns,
      deletedCheckExecutions,
      deletedAuditEvents,
      deletedSnapshots,
      ...transcriptResult,
    };
  });
}

function scrubExpiredTranscripts(
  database: DatabaseSync,
  cutoff: string,
): { scrubbedCanvasTranscripts: number; scrubbedSnapshotTranscripts: number } {
  let scrubbedCanvasTranscripts = 0;
  let scrubbedSnapshotTranscripts = 0;
  const canvases = database
    .prepare('SELECT value_json FROM canvas_documents')
    .all() as unknown as JsonRow[];
  for (const row of canvases) {
    const document = CanvasDocumentSchema.parse(parseJson(row.value_json));
    const scrubbed = scrubCanvasTranscripts(document, cutoff);
    if (scrubbed.count > 0) {
      writeCanvas(database, scrubbed.document, false, 'import');
      scrubbedCanvasTranscripts += scrubbed.count;
    }
  }

  const snapshots = database
    .prepare('SELECT value_json FROM canvas_snapshots')
    .all() as unknown as JsonRow[];
  for (const row of snapshots) {
    const snapshot = CanvasSnapshotSchema.parse(parseJson(row.value_json));
    const scrubbed = scrubCanvasTranscripts(snapshot.document, cutoff);
    if (scrubbed.count > 0) {
      writeSnapshot(database, {
        ...snapshot,
        document: scrubbed.document,
        contentHash: canvasContentHash(scrubbed.document),
      });
      scrubbedSnapshotTranscripts += scrubbed.count;
    }
  }
  return { scrubbedCanvasTranscripts, scrubbedSnapshotTranscripts };
}
