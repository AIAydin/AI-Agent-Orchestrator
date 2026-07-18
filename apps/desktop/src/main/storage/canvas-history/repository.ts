import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import type { CanvasDocument } from '../../../shared/application/contracts.js';
import {
  CanvasHistorySaveInputSchema,
  CanvasHistoryStateSchema,
  emptyCanvasHistory,
  fitCanvasHistory,
  type CanvasHistorySaveInput,
  type CanvasHistoryState,
} from '../../../shared/canvas/history/contracts.js';
import { transaction } from '../database.js';
import { canvasContentHash, parseJson, sanitizeCanvasDocument } from '../values.js';
import { loadCanvas, writeCanvas } from '../writes.js';

interface HistoryRow {
  canvas_id: string;
  current_hash: string;
  value_json: string;
}

export function loadCanvasHistory(
  database: DatabaseSync,
  projectId: string,
): CanvasHistoryState | undefined {
  const current = loadCanvas(database, projectId);
  if (!current) return undefined;
  const empty = emptyCanvasHistory(projectId, current.id);
  const row = database
    .prepare(`SELECT canvas_id, current_hash, value_json FROM canvas_history WHERE project_id = ?`)
    .get(projectId) as HistoryRow | undefined;
  if (!row) return empty;
  if (row.canvas_id !== current.id || row.current_hash !== canvasContentHash(current)) {
    clearCanvasHistory(database, projectId);
    return empty;
  }
  let raw: unknown;
  try {
    raw = parseJson(row.value_json);
  } catch {
    clearCanvasHistory(database, projectId);
    return empty;
  }
  const parsed = CanvasHistoryStateSchema.safeParse(raw);
  if (!parsed.success) {
    clearCanvasHistory(database, projectId);
    return empty;
  }
  try {
    const sanitized = sanitizeHistory(current, parsed.data);
    if (!isDeepStrictEqual(parsed.data, sanitized)) writeHistory(database, current, sanitized);
    return sanitized;
  } catch {
    clearCanvasHistory(database, projectId);
    return empty;
  }
}

export function saveCanvasWithHistory(
  database: DatabaseSync,
  input: CanvasHistorySaveInput,
): CanvasDocument {
  const parsed = CanvasHistorySaveInputSchema.parse(input);
  return transaction(database, () => {
    clearCanvasHistory(database, parsed.document.projectId);
    const saved = writeCanvas(database, parsed.document, true, 'autosave');
    writeHistory(database, saved, sanitizeHistory(saved, parsed.history));
    return saved;
  });
}

export function clearCanvasHistory(database: DatabaseSync, projectId: string): void {
  database.prepare('DELETE FROM canvas_history WHERE project_id = ?').run(projectId);
}

export function sanitizeHistory(
  document: CanvasDocument,
  state: CanvasHistoryState,
): CanvasHistoryState {
  return CanvasHistoryStateSchema.parse({
    projectId: document.projectId,
    canvasId: document.id,
    past: state.past.map((graph) =>
      graphFromDocument(sanitizeCanvasDocument({ ...document, ...graph })),
    ),
    future: state.future.map((graph) =>
      graphFromDocument(sanitizeCanvasDocument({ ...document, ...graph })),
    ),
  });
}

export function writeHistory(
  database: DatabaseSync,
  document: CanvasDocument,
  state: CanvasHistoryState,
): void {
  const parsed = fitCanvasHistory(CanvasHistoryStateSchema.parse(state));
  database
    .prepare(
      `INSERT INTO canvas_history(project_id, canvas_id, current_hash, value_json, updated_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET canvas_id = excluded.canvas_id,
         current_hash = excluded.current_hash, value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      document.projectId,
      document.id,
      canvasContentHash(document),
      JSON.stringify(parsed),
      document.updatedAt,
    );
}

function graphFromDocument(document: CanvasDocument): CanvasHistoryState['past'][number] {
  return { nodes: document.nodes, edges: document.edges };
}
