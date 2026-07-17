import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import {
  CheckCancelInputSchema,
  CheckListInputSchema,
  type CheckExecutionView,
} from '../../shared/checks/contracts.js';
import { WorkflowGetInputSchema } from '../../shared/workflow/contracts.js';
import {
  StoredCheckExecutionRecordSchema,
  type InterruptedCheckRecoveryReport,
  type StoredCheckExecutionRecord,
} from '../storage-schemas.js';
import { transaction } from './database.js';
import { parseJson } from './values.js';
import { writeAudit } from './writes.js';

export const CHECK_EXECUTION_COLUMNS = `
  id, project_id, check_id, status, value_json, updated_at
`;

export interface CheckExecutionRow {
  id: string;
  project_id: string;
  check_id: string;
  status: string;
  value_json: string;
  updated_at: string;
}

const MAX_LISTED_CHECK_EXECUTIONS = 200;
const MAX_LISTED_WORKFLOW_CHECK_EXECUTIONS = 2_000;

export function saveCheckExecution(
  database: DatabaseSync,
  execution: CheckExecutionView,
): StoredCheckExecutionRecord {
  const parsed = StoredCheckExecutionRecordSchema.parse(execution);
  const current = database
    .prepare(`SELECT ${CHECK_EXECUTION_COLUMNS} FROM check_executions WHERE id = ?`)
    .get(parsed.id) as CheckExecutionRow | undefined;
  if (current) {
    const existing = parseCheckExecutionRow(current);
    if (!isDeepStrictEqual(executionIdentity(existing), executionIdentity(parsed))) {
      throw new Error('A check execution cannot change its persisted identity.');
    }
    if (isDeepStrictEqual(existing, parsed)) return existing;
    const existingUpdatedAt = Date.parse(existing.updatedAt);
    const nextUpdatedAt = Date.parse(parsed.updatedAt);
    if (nextUpdatedAt < existingUpdatedAt) {
      throw new Error('A stale check execution cannot replace a newer result.');
    }
    if (nextUpdatedAt === existingUpdatedAt) {
      throw new Error('A changed check execution must advance its update time.');
    }
    assertCheckExecutionTransition(existing, parsed);
  }
  writeCheckExecution(database, parsed);
  return parsed;
}

export function getCheckExecution(
  database: DatabaseSync,
  executionId: string,
): StoredCheckExecutionRecord | undefined {
  const parsedInput = CheckCancelInputSchema.parse({ executionId });
  const row = database
    .prepare(`SELECT ${CHECK_EXECUTION_COLUMNS} FROM check_executions WHERE id = ?`)
    .get(parsedInput.executionId) as CheckExecutionRow | undefined;
  return row ? parseCheckExecutionRow(row) : undefined;
}

export function listCheckExecutions(
  database: DatabaseSync,
  projectId: string,
  limit = MAX_LISTED_CHECK_EXECUTIONS,
): StoredCheckExecutionRecord[] {
  const parsedInput = CheckListInputSchema.parse({ projectId });
  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : MAX_LISTED_CHECK_EXECUTIONS;
  const boundedLimit = Math.max(1, Math.min(MAX_LISTED_CHECK_EXECUTIONS, requestedLimit));
  const rows = database
    .prepare(
      `SELECT ${CHECK_EXECUTION_COLUMNS}
       FROM check_executions
       WHERE project_id = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(parsedInput.projectId, boundedLimit) as unknown as CheckExecutionRow[];
  return rows.map(parseCheckExecutionRow);
}

export function listWorkflowCheckExecutions(
  database: DatabaseSync,
  projectId: string,
  workflowExecutionId: string,
  limit = MAX_LISTED_WORKFLOW_CHECK_EXECUTIONS,
): StoredCheckExecutionRecord[] {
  const parsedProject = CheckListInputSchema.parse({ projectId });
  const parsedWorkflow = WorkflowGetInputSchema.parse({ executionId: workflowExecutionId });
  const requestedLimit = Number.isFinite(limit)
    ? Math.trunc(limit)
    : MAX_LISTED_WORKFLOW_CHECK_EXECUTIONS;
  const boundedLimit = Math.max(1, Math.min(MAX_LISTED_WORKFLOW_CHECK_EXECUTIONS, requestedLimit));
  const rows = database
    .prepare(
      `SELECT ${CHECK_EXECUTION_COLUMNS}
       FROM check_executions
       WHERE project_id = ?
         AND json_extract(value_json, '$.workflowBinding.executionId') = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(
      parsedProject.projectId,
      parsedWorkflow.executionId,
      boundedLimit,
    ) as unknown as CheckExecutionRow[];
  return rows.map(parseCheckExecutionRow);
}

export function recoverInterruptedCheckExecutions(
  database: DatabaseSync,
  now = new Date(),
): InterruptedCheckRecoveryReport {
  const rows = database
    .prepare(
      `SELECT ${CHECK_EXECUTION_COLUMNS}
       FROM check_executions
       WHERE status IN ('queued', 'running')
       ORDER BY updated_at, id`,
    )
    .all() as unknown as CheckExecutionRow[];
  const executions = rows.map(parseCheckExecutionRow);
  const newestExecutionTime = executions.reduce(
    (newest, execution) => Math.max(newest, Date.parse(execution.updatedAt)),
    Number.NEGATIVE_INFINITY,
  );
  const recoveredAt = new Date(Math.max(now.getTime(), newestExecutionTime + 1)).toISOString();
  const lostCheckExecutionIds = executions.map((execution) => execution.id);
  if (executions.length > 0) {
    transaction(database, () => {
      for (const execution of executions) {
        writeCheckExecution(database, {
          ...execution,
          status: 'lost',
          endedAt: recoveredAt,
          updatedAt: recoveredAt,
        });
      }
      writeAudit(database, recoveredAt, 'recovery', 'interrupted-checks', 'allowed', {
        lostCheckExecutionIds,
      });
    });
  }
  return { lostCheckExecutionIds, recoveredAt };
}

export function parseCheckExecutionRow(row: CheckExecutionRow): StoredCheckExecutionRecord {
  const execution = StoredCheckExecutionRecordSchema.parse(parseJson(row.value_json));
  if (!checkExecutionMirrorsMatch(execution, row)) {
    throw new Error('Check execution columns do not match their authoritative record.');
  }
  return execution;
}

export function checkExecutionMirrorsMatch(
  execution: StoredCheckExecutionRecord,
  row: CheckExecutionRow,
): boolean {
  return (
    execution.id === row.id &&
    execution.projectId === row.project_id &&
    execution.checkId === row.check_id &&
    execution.status === row.status &&
    execution.updatedAt === row.updated_at
  );
}

function writeCheckExecution(database: DatabaseSync, execution: StoredCheckExecutionRecord): void {
  database
    .prepare(
      `INSERT INTO check_executions(
         id, project_id, check_id, status, value_json, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status,
         value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(
      execution.id,
      execution.projectId,
      execution.checkId,
      execution.status,
      JSON.stringify(execution),
      execution.updatedAt,
    );
}

function executionIdentity(execution: StoredCheckExecutionRecord): Record<string, unknown> {
  return {
    id: execution.id,
    projectId: execution.projectId,
    checkId: execution.checkId,
    label: execution.label,
    kind: execution.kind,
    executable: execution.executable,
    arguments: execution.arguments,
    cwd: execution.cwd,
    environmentVariableNames: execution.environmentVariableNames,
    target: execution.target,
    workflowBinding: execution.workflowBinding,
  };
}

function assertCheckExecutionTransition(
  existing: StoredCheckExecutionRecord,
  next: StoredCheckExecutionRecord,
): void {
  if (isTerminalStatus(existing.status)) {
    throw new Error('A terminal check execution cannot change.');
  }
  if (existing.status === 'running' && next.status === 'queued') {
    throw new Error('A running check execution cannot return to queued.');
  }
  if (existing.startedAt !== null && next.startedAt !== existing.startedAt) {
    throw new Error('A check execution cannot change its persisted start time.');
  }
}

function isTerminalStatus(status: StoredCheckExecutionRecord['status']): boolean {
  return status === 'passed' || status === 'failed' || status === 'cancelled' || status === 'lost';
}
