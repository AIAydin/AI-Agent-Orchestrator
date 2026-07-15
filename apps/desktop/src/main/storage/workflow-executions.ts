import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  WORKFLOW_NODE_BINDINGS_MAX_COUNT,
  WorkflowExecutionEventSchema,
  WorkflowExecutionMutationSchema,
  WorkflowExecutionRecordSchema,
  WorkflowEventPageRequestSchema,
  WorkflowIdentifierSchema,
  WorkflowNodeBindingSchema,
  type WorkflowExecutionEvent,
  type WorkflowExecutionMutationInput,
  type WorkflowExecutionMutationResult,
  type WorkflowExecutionRecord,
  type WorkflowExecutionRecordInput,
  type WorkflowEventPageRequest,
  type WorkflowNodeBinding,
} from './workflow-contracts.js';
import { transaction } from './database.js';

interface WorkflowExecutionRow {
  readonly id: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly canvas_id: string;
  readonly status: string;
  readonly revision: number;
  readonly runtime_json: string;
  readonly snapshot_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface WorkflowEventRow {
  readonly execution_id: string;
  readonly event_id: string;
  readonly schema_version: number;
  readonly execution_sequence: number;
  readonly execution_revision: number;
  readonly type: string;
  readonly occurred_at: string;
  readonly payload_json: string;
  readonly mutation_digest: string;
}

interface WorkflowBindingRow {
  readonly execution_id: string;
  readonly node_id: string;
  readonly schema_version: number;
  readonly binding_json: string;
  readonly execution_revision: number;
  readonly updated_at: string;
}

const EXECUTION_COLUMNS = `
  id, schema_version, project_id, canvas_id, status, revision, runtime_json, snapshot_json,
  created_at, updated_at
`;
const EVENT_COLUMNS = `
  execution_id, event_id, schema_version, execution_sequence, execution_revision, type,
  occurred_at, payload_json, mutation_digest
`;
const BINDING_COLUMNS = `
  execution_id, node_id, schema_version, binding_json, execution_revision, updated_at
`;
const RECOVERABLE_STATUSES = [
  'queued',
  'running',
  'waiting-for-approval',
  'paused',
  'cancelling',
] as const;

export class WorkflowExecutionRevisionConflictError extends Error {
  public readonly actualRevision: number;
  public readonly expectedRevision: number;

  public constructor(expectedRevision: number, actualRevision: number) {
    super(
      `Workflow execution revision conflict: expected ${expectedRevision}, found ${actualRevision}.`,
    );
    this.name = 'WorkflowExecutionRevisionConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class WorkflowExecutionEventReplayConflictError extends Error {
  public constructor(eventId: string) {
    super(`Workflow event ${eventId} was already used for a different runtime mutation.`);
    this.name = 'WorkflowExecutionEventReplayConflictError';
  }
}

export function createWorkflowExecution(
  database: DatabaseSync,
  record: WorkflowExecutionRecordInput,
): WorkflowExecutionRecord {
  const parsed = WorkflowExecutionRecordSchema.parse(record);
  if (parsed.revision !== 0) {
    throw new Error('A new workflow execution must start at revision zero.');
  }
  return transaction(database, () => {
    assertExecutionReferences(database, parsed);
    if (getWorkflowExecution(database, parsed.id) !== undefined) {
      throw new Error(`Workflow execution ${parsed.id} already exists.`);
    }
    database
      .prepare(
        `INSERT INTO workflow_executions(
           id, schema_version, project_id, canvas_id, status, revision, runtime_json, snapshot_json,
           created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.schemaVersion,
        parsed.projectId,
        parsed.canvasId,
        parsed.status,
        parsed.revision,
        JSON.stringify(parsed.runtime),
        JSON.stringify(parsed.snapshot),
        parsed.createdAt,
        parsed.updatedAt,
      );
    return parsed;
  });
}

export function getWorkflowExecution(
  database: DatabaseSync,
  executionId: string,
): WorkflowExecutionRecord | undefined {
  const id = WorkflowIdentifierSchema.parse(executionId);
  const row = database
    .prepare(`SELECT ${EXECUTION_COLUMNS} FROM workflow_executions WHERE id = ?`)
    .get(id) as WorkflowExecutionRow | undefined;
  return row === undefined ? undefined : executionFromRow(row);
}

export function listRecoverableWorkflowExecutions(
  database: DatabaseSync,
  limit = 200,
): WorkflowExecutionRecord[] {
  const boundedLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
  const placeholders = RECOVERABLE_STATUSES.map(() => '?').join(', ');
  const rows = database
    .prepare(
      `SELECT ${EXECUTION_COLUMNS} FROM workflow_executions
       WHERE status IN (${placeholders}) ORDER BY updated_at, id LIMIT ?`,
    )
    .all(...RECOVERABLE_STATUSES, boundedLimit) as unknown as WorkflowExecutionRow[];
  return rows.map(executionFromRow);
}

export function listProjectWorkflowExecutions(
  database: DatabaseSync,
  projectId: string,
  options: { readonly canvasId?: string; readonly limit?: number } = {},
): WorkflowExecutionRecord[] {
  const project = WorkflowIdentifierSchema.parse(projectId);
  const canvas =
    options.canvasId === undefined ? undefined : WorkflowIdentifierSchema.parse(options.canvasId);
  const boundedLimit = Math.max(1, Math.min(10_000, Math.trunc(options.limit ?? 200)));
  const rows = database
    .prepare(
      canvas === undefined
        ? `SELECT ${EXECUTION_COLUMNS} FROM workflow_executions
           WHERE project_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`
        : `SELECT ${EXECUTION_COLUMNS} FROM workflow_executions
           WHERE project_id = ? AND canvas_id = ?
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(
      ...(canvas === undefined ? [project, boundedLimit] : [project, canvas, boundedLimit]),
    ) as unknown as WorkflowExecutionRow[];
  return rows.map(executionFromRow);
}

export function listWorkflowExecutionEvents(
  database: DatabaseSync,
  executionId: string,
  request: WorkflowEventPageRequest = {},
): WorkflowExecutionEvent[] {
  const id = WorkflowIdentifierSchema.parse(executionId);
  const parsedRequest = WorkflowEventPageRequestSchema.parse(request);
  const afterSequence = parsedRequest.afterSequence ?? -1;
  const limit = parsedRequest.limit ?? 1_000;
  const rows = database
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM workflow_execution_events
       WHERE execution_id = ? AND execution_sequence > ?
       ORDER BY execution_sequence LIMIT ?`,
    )
    .all(id, afterSequence, limit) as unknown as WorkflowEventRow[];
  return rows.map(eventFromRow);
}

export function listWorkflowNodeBindings(
  database: DatabaseSync,
  executionId: string,
): WorkflowNodeBinding[] {
  const id = WorkflowIdentifierSchema.parse(executionId);
  const rows = database
    .prepare(
      `SELECT ${BINDING_COLUMNS} FROM workflow_node_bindings
       WHERE execution_id = ? ORDER BY node_id`,
    )
    .all(id) as unknown as WorkflowBindingRow[];
  return rows.map(bindingFromRow);
}

export function mutateWorkflowExecution(
  database: DatabaseSync,
  mutation: WorkflowExecutionMutationInput,
): WorkflowExecutionMutationResult {
  const parsedInput = WorkflowExecutionMutationSchema.parse(mutation);
  const parsed = {
    ...parsedInput,
    bindingUpdates: [...parsedInput.bindingUpdates].sort((left, right) =>
      left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0,
    ),
  };
  const mutationDigest = digestMutation(parsed);
  return transaction(database, () => {
    const replay = findEvent(database, parsed.executionId, parsed.event.id);
    if (replay !== undefined) {
      if (replay.mutation_digest !== mutationDigest) {
        throw new WorkflowExecutionEventReplayConflictError(parsed.event.id);
      }
      return {
        execution: requireWorkflowExecution(database, parsed.executionId),
        event: eventFromRow(replay),
        bindings: listWorkflowNodeBindings(database, parsed.executionId),
        replayed: true,
      };
    }

    const current = requireWorkflowExecution(database, parsed.executionId);
    if (current.revision !== parsed.expectedRevision) {
      throw new WorkflowExecutionRevisionConflictError(parsed.expectedRevision, current.revision);
    }
    if (Date.parse(parsed.updatedAt) < Date.parse(current.updatedAt)) {
      throw new Error('A workflow runtime mutation cannot predate the current revision.');
    }
    const nextRevision = current.revision + 1;
    const execution = WorkflowExecutionRecordSchema.parse({
      ...current,
      status: parsed.status,
      revision: nextRevision,
      runtime: parsed.runtime,
      snapshot: parsed.snapshot,
      updatedAt: parsed.updatedAt,
    });
    const update = database
      .prepare(
        `UPDATE workflow_executions SET
           status = ?, revision = ?, runtime_json = ?, snapshot_json = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        execution.status,
        execution.revision,
        JSON.stringify(execution.runtime),
        JSON.stringify(execution.snapshot),
        execution.updatedAt,
        execution.id,
        current.revision,
      );
    if (Number(update.changes) !== 1) {
      const actual = requireWorkflowExecution(database, parsed.executionId).revision;
      throw new WorkflowExecutionRevisionConflictError(parsed.expectedRevision, actual);
    }

    const event = appendEvent(database, parsed, nextRevision, mutationDigest);
    applyBindingUpdates(database, parsed, nextRevision);
    assertBindingCount(database, parsed.executionId);
    return {
      execution,
      event,
      bindings: listWorkflowNodeBindings(database, parsed.executionId),
      replayed: false,
    };
  });
}

export function workflowStorageIntegrityMessages(database: DatabaseSync): string[] {
  const messages: string[] = [];
  const executionRows = database
    .prepare(`SELECT ${EXECUTION_COLUMNS} FROM workflow_executions ORDER BY id`)
    .all() as unknown as WorkflowExecutionRow[];
  const revisions = new Map<string, number>();
  const executions = new Map<string, WorkflowExecutionRecord>();
  for (const [index, row] of executionRows.entries()) {
    try {
      const execution = executionFromRow(row);
      assertExecutionReferences(database, execution);
      revisions.set(execution.id, execution.revision);
      executions.set(execution.id, execution);
    } catch (error) {
      messages.push(`workflow_executions row ${index + 1}: ${errorMessage(error)}`);
    }
  }

  const eventRows = database
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM workflow_execution_events
       ORDER BY execution_id, execution_sequence`,
    )
    .all() as unknown as WorkflowEventRow[];
  const nextSequence = new Map<string, number>();
  for (const [index, row] of eventRows.entries()) {
    try {
      const event = eventFromRow(row);
      if (!/^[a-f0-9]{64}$/u.test(row.mutation_digest)) {
        throw new Error('mutation digest is invalid');
      }
      const expectedSequence = nextSequence.get(event.executionId) ?? 0;
      if (event.sequence !== expectedSequence || event.executionRevision !== event.sequence + 1) {
        throw new Error('event sequence or execution revision is not contiguous');
      }
      const currentRevision = revisions.get(event.executionId);
      if (currentRevision === undefined || event.executionRevision > currentRevision) {
        throw new Error('event references an unavailable execution revision');
      }
      const execution = executions.get(event.executionId);
      if (
        execution === undefined ||
        Date.parse(event.occurredAt) > Date.parse(execution.updatedAt)
      ) {
        throw new Error('event timestamp is newer than its execution runtime');
      }
      nextSequence.set(event.executionId, expectedSequence + 1);
    } catch (error) {
      messages.push(`workflow_execution_events row ${index + 1}: ${errorMessage(error)}`);
    }
  }
  for (const [executionId, revision] of revisions) {
    if ((nextSequence.get(executionId) ?? 0) !== revision) {
      messages.push(`workflow_executions ${executionId}: revision does not match its event ledger`);
    }
  }

  const bindingRows = database
    .prepare(`SELECT ${BINDING_COLUMNS} FROM workflow_node_bindings ORDER BY execution_id, node_id`)
    .all() as unknown as WorkflowBindingRow[];
  for (const [index, row] of bindingRows.entries()) {
    try {
      const binding = bindingFromRow(row);
      const currentRevision = revisions.get(binding.executionId);
      if (currentRevision === undefined || binding.executionRevision > currentRevision) {
        throw new Error('binding references an unavailable execution revision');
      }
      const execution = executions.get(binding.executionId);
      if (
        execution === undefined ||
        Date.parse(binding.updatedAt) > Date.parse(execution.updatedAt)
      ) {
        throw new Error('binding timestamp is newer than its execution runtime');
      }
    } catch (error) {
      messages.push(`workflow_node_bindings row ${index + 1}: ${errorMessage(error)}`);
    }
  }
  return messages;
}

function requireWorkflowExecution(
  database: DatabaseSync,
  executionId: string,
): WorkflowExecutionRecord {
  const execution = getWorkflowExecution(database, executionId);
  if (execution === undefined) throw new Error(`Workflow execution ${executionId} does not exist.`);
  return execution;
}

function assertExecutionReferences(
  database: DatabaseSync,
  execution: WorkflowExecutionRecord,
): void {
  const project = database
    .prepare('SELECT 1 FROM recent_projects WHERE id = ?')
    .get(execution.projectId);
  if (project === undefined) {
    throw new Error(`Workflow execution ${execution.id} references an unknown project.`);
  }
  const canvas = database
    .prepare('SELECT project_id FROM canvas_documents WHERE id = ?')
    .get(execution.canvasId) as { project_id: string } | undefined;
  if (canvas === undefined || canvas.project_id !== execution.projectId) {
    throw new Error(`Workflow execution ${execution.id} references an unavailable project canvas.`);
  }
}

function appendEvent(
  database: DatabaseSync,
  mutation: ParsedWorkflowExecutionMutation,
  executionRevision: number,
  mutationDigest: string,
): WorkflowExecutionEvent {
  const sequenceRow = database
    .prepare(
      `SELECT COALESCE(MAX(execution_sequence), -1) + 1 AS next_sequence
       FROM workflow_execution_events WHERE execution_id = ?`,
    )
    .get(mutation.executionId) as { next_sequence: number };
  const event = WorkflowExecutionEventSchema.parse({
    schemaVersion: 1,
    executionId: mutation.executionId,
    sequence: sequenceRow.next_sequence,
    executionRevision,
    ...mutation.event,
  });
  database
    .prepare(
      `INSERT INTO workflow_execution_events(
         execution_id, event_id, schema_version, execution_sequence, execution_revision, type,
         occurred_at, payload_json, mutation_digest
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.executionId,
      event.id,
      event.schemaVersion,
      event.sequence,
      event.executionRevision,
      event.type,
      event.occurredAt,
      JSON.stringify(event.payload),
      mutationDigest,
    );
  return event;
}

function applyBindingUpdates(
  database: DatabaseSync,
  mutation: ParsedWorkflowExecutionMutation,
  executionRevision: number,
): void {
  const remove = database.prepare(
    'DELETE FROM workflow_node_bindings WHERE execution_id = ? AND node_id = ?',
  );
  const upsert = database.prepare(
    `INSERT INTO workflow_node_bindings(
       execution_id, node_id, schema_version, binding_json, execution_revision, updated_at
     ) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(execution_id, node_id) DO UPDATE SET
       schema_version = excluded.schema_version,
       binding_json = excluded.binding_json,
       execution_revision = excluded.execution_revision,
       updated_at = excluded.updated_at`,
  );
  for (const update of mutation.bindingUpdates) {
    if (update.binding === null) {
      remove.run(mutation.executionId, update.nodeId);
      continue;
    }
    const binding = WorkflowNodeBindingSchema.parse({
      schemaVersion: 1,
      executionId: mutation.executionId,
      nodeId: update.nodeId,
      binding: update.binding,
      executionRevision,
      updatedAt: mutation.updatedAt,
    });
    upsert.run(
      binding.executionId,
      binding.nodeId,
      binding.schemaVersion,
      JSON.stringify(binding.binding),
      binding.executionRevision,
      binding.updatedAt,
    );
  }
}

function assertBindingCount(database: DatabaseSync, executionId: string): void {
  const row = database
    .prepare('SELECT COUNT(*) AS count FROM workflow_node_bindings WHERE execution_id = ?')
    .get(executionId) as { count: number };
  if (row.count > WORKFLOW_NODE_BINDINGS_MAX_COUNT) {
    throw new Error(
      `Workflow execution exceeds the ${WORKFLOW_NODE_BINDINGS_MAX_COUNT}-binding storage limit.`,
    );
  }
}

function findEvent(
  database: DatabaseSync,
  executionId: string,
  eventId: string,
): WorkflowEventRow | undefined {
  return database
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM workflow_execution_events
       WHERE execution_id = ? AND event_id = ?`,
    )
    .get(executionId, eventId) as WorkflowEventRow | undefined;
}

function executionFromRow(row: WorkflowExecutionRow): WorkflowExecutionRecord {
  return WorkflowExecutionRecordSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    projectId: row.project_id,
    canvasId: row.canvas_id,
    status: row.status,
    revision: row.revision,
    runtime: parseStoredJson(row.runtime_json, 'workflow runtime'),
    snapshot: parseStoredJson(row.snapshot_json, 'workflow snapshot'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function eventFromRow(row: WorkflowEventRow): WorkflowExecutionEvent {
  return WorkflowExecutionEventSchema.parse({
    schemaVersion: row.schema_version,
    id: row.event_id,
    executionId: row.execution_id,
    sequence: row.execution_sequence,
    executionRevision: row.execution_revision,
    type: row.type,
    occurredAt: row.occurred_at,
    payload: parseStoredJson(row.payload_json, 'workflow event payload'),
  });
}

function bindingFromRow(row: WorkflowBindingRow): WorkflowNodeBinding {
  return WorkflowNodeBindingSchema.parse({
    schemaVersion: row.schema_version,
    executionId: row.execution_id,
    nodeId: row.node_id,
    binding: parseStoredJson(row.binding_json, 'workflow node binding'),
    executionRevision: row.execution_revision,
    updatedAt: row.updated_at,
  });
}

function digestMutation(mutation: unknown): string {
  return createHash('sha256').update(canonicalJson(mutation)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Workflow mutations must contain only JSON data.');
}

function parseStoredJson(serialized: string, label: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`Stored ${label} is not valid JSON.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown validation failure';
}

type ParsedWorkflowExecutionMutation = ReturnType<typeof WorkflowExecutionMutationSchema.parse>;
