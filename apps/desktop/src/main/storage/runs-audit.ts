import type { DatabaseSync } from 'node:sqlite';

import { AuditEventSchema, type AuditEvent } from '../../shared/application/contracts.js';
import {
  effectiveRunWorktreeState,
  effectiveRunWorktreeAuthority,
  StoredRunRecordSchema,
  StoredRunWorktreeStateSchema,
  type InterruptedRunRecoveryReport,
  type StoredRunRecord,
  type StoredRunWorktreeState,
} from '../storage-schemas.js';
import { transaction } from './database.js';
import { type AuditRow, type JsonRow } from './values.js';
import {
  writeAudit,
  writeRun,
  writeRunForWorktreeBranchRename,
  writeRunForWorktreeTransition,
} from './writes.js';

export function appendAudit(
  database: DatabaseSync,
  category: string,
  action: string,
  outcome: 'allowed' | 'denied' | 'failed',
  metadata: Record<string, unknown>,
): void {
  writeAudit(database, new Date().toISOString(), category, action, outcome, metadata);
}

export function listAuditEvents(database: DatabaseSync, limit: number): AuditEvent[] {
  const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = database
    .prepare(
      `SELECT sequence, occurred_at, category, action, outcome
       FROM audit_events ORDER BY sequence DESC LIMIT ?`,
    )
    .all(boundedLimit) as unknown as AuditRow[];
  return rows.map((row) =>
    AuditEventSchema.parse({
      sequence: row.sequence,
      occurredAt: row.occurred_at,
      category: row.category,
      action: row.action,
      outcome: row.outcome,
    }),
  );
}

export function saveRun(database: DatabaseSync, record: StoredRunRecord): StoredRunRecord {
  const parsed = StoredRunRecordSchema.parse(record);
  writeRun(database, parsed);
  return parsed;
}

export interface RunWorktreeAuthorityTransfer {
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly transferredAt: string;
}

/** Atomically makes a prepared resume attempt the only continuation authority for its target. */
export function transferRunWorktreeAuthority(
  database: DatabaseSync,
  input: RunWorktreeAuthorityTransfer,
): StoredRunRecord {
  const parentRunId = parseUuid(input.parentRunId);
  const childRunId = parseUuid(input.childRunId);
  const transferredAt = StoredRunRecordSchema.shape.updatedAt.parse(input.transferredAt);
  if (parentRunId === childRunId) throw new Error('A run cannot transfer authority to itself.');
  return transaction(database, () => {
    const parent = getRun(database, parentRunId);
    const child = getRun(database, childRunId);
    if (parent === undefined || child === undefined) {
      throw new Error('Both persisted attempts are required for a worktree authority transfer.');
    }
    if (
      child.action !== 'resume' ||
      child.parentRunId !== parent.id ||
      parent.supersededByRunId != null ||
      parent.status !== 'interrupted' ||
      parent.providerSessionId == null ||
      parent.resumeSupported !== true ||
      effectiveRunWorktreeAuthority(parent) !== 'owned' ||
      child.projectId !== parent.projectId ||
      child.nodeId !== parent.nodeId ||
      child.adapterId !== parent.adapterId ||
      (child.model ?? null) !== (parent.model ?? null) ||
      child.permissionProfile !== parent.permissionProfile ||
      child.worktreeId !== parent.worktreeId ||
      child.cwd !== parent.cwd ||
      child.branch !== parent.branch ||
      child.repositoryRoot !== parent.repositoryRoot ||
      child.managedRoot !== parent.managedRoot ||
      child.baseRef !== parent.baseRef ||
      child.baseCommit !== parent.baseCommit ||
      child.status !== 'prepared' ||
      effectiveRunWorktreeAuthority(child) !== 'pending-transfer' ||
      (parent.worktreeId === null &&
        (parent.permissionProfile !== 'plan-read-only' ||
          parent.managedRoot !== null ||
          parent.repositoryRoot !== parent.cwd ||
          parent.branch === null ||
          parent.baseCommit === null)) ||
      (parent.worktreeId !== null && effectiveRunWorktreeState(parent) !== 'active') ||
      effectiveRunWorktreeState(child) !== 'active'
    ) {
      throw new Error('The persisted resume lineage or exact worktree authority changed.');
    }
    const next = StoredRunRecordSchema.parse({
      ...parent,
      supersededByRunId: child.id,
      updatedAt:
        Date.parse(transferredAt) > Date.parse(parent.updatedAt) ? transferredAt : parent.updatedAt,
    });
    const authoritativeChild = StoredRunRecordSchema.parse({
      ...child,
      worktreeAuthority: 'owned',
      updatedAt:
        Date.parse(transferredAt) > Date.parse(child.updatedAt) ? transferredAt : child.updatedAt,
    });
    writeRun(database, next);
    writeRun(database, authoritativeChild);
    return authoritativeChild;
  });
}

export interface RunWorktreeStateTransition {
  readonly runId: string;
  readonly expectedWorktreeId: string;
  readonly expectedState: StoredRunWorktreeState;
  readonly nextState: StoredRunWorktreeState;
  readonly transitionedAt: string;
}

export interface RunWorktreeBranchRename {
  readonly runId: string;
  readonly expectedWorktreeId: string;
  readonly expectedBranch: string;
  readonly nextBranch: string;
  readonly renamedAt: string;
}

/** Atomically updates every persisted attempt sharing one exactly-bound managed worktree. */
export function renameRunWorktreeBranch(
  database: DatabaseSync,
  input: RunWorktreeBranchRename,
): StoredRunRecord {
  const runId = StoredRunRecordSchema.shape.id.parse(input.runId);
  const worktreeId = parseUuid(input.expectedWorktreeId);
  const expectedBranch = StoredRunRecordSchema.shape.branch.unwrap().parse(input.expectedBranch);
  const nextBranch = StoredRunRecordSchema.shape.branch.unwrap().parse(input.nextBranch);
  const renamedAt = StoredRunRecordSchema.shape.updatedAt.parse(input.renamedAt);
  if (expectedBranch === nextBranch) throw new Error('The managed branch name did not change.');
  return transaction(database, () => {
    const selected = getRun(database, runId);
    if (
      selected === undefined ||
      selected.worktreeId !== worktreeId ||
      selected.branch !== expectedBranch ||
      effectiveRunWorktreeState(selected) !== 'active'
    ) {
      throw new Error('The persisted run branch binding changed before rename.');
    }
    const rows = database
      .prepare(
        `SELECT value_json FROM agent_runs WHERE json_extract(value_json, '$.worktreeId') = ?`,
      )
      .all(worktreeId) as unknown as JsonRow[];
    const siblings = rows.map((row) => StoredRunRecordSchema.parse(JSON.parse(row.value_json)));
    if (siblings.length === 0 || siblings.some((record) => record.branch !== expectedBranch)) {
      throw new Error('The managed worktree run lineage has inconsistent branch bindings.');
    }
    let renamedSelected: StoredRunRecord | undefined;
    for (const sibling of siblings) {
      const renamed = StoredRunRecordSchema.parse({
        ...sibling,
        branch: nextBranch,
        updatedAt:
          Date.parse(renamedAt) > Date.parse(sibling.updatedAt) ? renamedAt : sibling.updatedAt,
      });
      writeRunForWorktreeBranchRename(database, renamed);
      if (renamed.id === runId) renamedSelected = renamed;
    }
    if (renamedSelected === undefined) throw new Error('The selected run branch was not renamed.');
    return renamedSelected;
  });
}

export function transitionRunWorktreeState(
  database: DatabaseSync,
  input: RunWorktreeStateTransition,
): StoredRunRecord {
  const runId = StoredRunRecordSchema.shape.id.parse(input.runId);
  const expectedWorktreeId = parseUuid(input.expectedWorktreeId);
  const expectedState = StoredRunWorktreeStateSchema.parse(input.expectedState);
  const nextState = StoredRunWorktreeStateSchema.parse(input.nextState);
  const transitionedAt = StoredRunRecordSchema.shape.updatedAt.parse(input.transitionedAt);
  if (!isAllowedWorktreeStateTransition(expectedState, nextState)) {
    throw new Error(`Invalid run worktree lifecycle transition: ${expectedState} -> ${nextState}.`);
  }
  return transaction(database, () => {
    const row = database.prepare('SELECT value_json FROM agent_runs WHERE id = ?').get(runId) as
      | JsonRow
      | undefined;
    if (row === undefined) throw new Error('The selected agent run no longer exists.');
    const current = StoredRunRecordSchema.parse(JSON.parse(row.value_json));
    if (current.worktreeId !== expectedWorktreeId || current.worktreeState !== expectedState) {
      throw new Error('The agent run worktree lifecycle changed before the exact transition.');
    }
    const next = StoredRunRecordSchema.parse({
      ...current,
      worktreeState: nextState,
      updatedAt:
        Date.parse(transitionedAt) > Date.parse(current.updatedAt)
          ? transitionedAt
          : current.updatedAt,
    });
    writeRunForWorktreeTransition(database, next);
    if (
      nextState === 'cleaned' ||
      nextState === 'archived' ||
      (expectedState === 'archived' && nextState === 'active')
    ) {
      const related = database
        .prepare(
          `SELECT value_json FROM agent_runs
           WHERE id <> ? AND json_extract(value_json, '$.worktreeId') = ?`,
        )
        .all(runId, expectedWorktreeId) as unknown as JsonRow[];
      for (const siblingRow of related) {
        const sibling = StoredRunRecordSchema.parse(JSON.parse(siblingRow.value_json));
        writeRunForWorktreeTransition(database, {
          ...sibling,
          worktreeState: nextState,
          updatedAt:
            Date.parse(transitionedAt) > Date.parse(sibling.updatedAt)
              ? transitionedAt
              : sibling.updatedAt,
        });
      }
    }
    return next;
  });
}

export function getRun(database: DatabaseSync, runId: string): StoredRunRecord | undefined {
  const row = database.prepare('SELECT value_json FROM agent_runs WHERE id = ?').get(runId) as
    | JsonRow
    | undefined;
  return row === undefined ? undefined : StoredRunRecordSchema.parse(JSON.parse(row.value_json));
}

export function listProjectRuns(
  database: DatabaseSync,
  projectId: string,
  limit = 200,
  nodeId?: string,
): StoredRunRecord[] {
  const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
  const rows = (nodeId === undefined
    ? database
        .prepare(
          `SELECT value_json FROM agent_runs
             WHERE project_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(projectId, boundedLimit)
    : database
        .prepare(
          `SELECT value_json FROM agent_runs
             WHERE project_id = ? AND node_id = ?
             ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(projectId, nodeId, boundedLimit)) as unknown as JsonRow[];
  return rows.map((row) => StoredRunRecordSchema.parse(JSON.parse(row.value_json)));
}

export function recoverInterruptedRuns(
  database: DatabaseSync,
  now = new Date(),
): InterruptedRunRecoveryReport {
  const recoveredAt = now.toISOString();
  const rows = database
    .prepare(
      `SELECT value_json FROM agent_runs WHERE status IN ('prepared', 'running')
       ORDER BY updated_at`,
    )
    .all() as unknown as JsonRow[];
  const records = rows.map((row) => StoredRunRecordSchema.parse(JSON.parse(row.value_json)));
  const lostRunIds = records.map((record) => record.id);
  if (records.length > 0) {
    transaction(database, () => {
      for (const record of records) {
        writeRun(database, {
          ...record,
          status: 'lost',
          endedAt: recoveredAt,
          updatedAt: recoveredAt,
        });
      }
      writeAudit(database, recoveredAt, 'recovery', 'interrupted-runs', 'allowed', {
        lostRunIds,
      });
    });
  }
  return { lostRunIds, recoveredAt };
}

function isAllowedWorktreeStateTransition(
  current: StoredRunWorktreeState,
  next: StoredRunWorktreeState,
): boolean {
  return (
    (current === 'active' && next === 'cleanup-pending') ||
    (current === 'active' && next === 'archived') ||
    (current === 'archived' && next === 'active') ||
    (current === 'cleanup-pending' && (next === 'active' || next === 'cleaned'))
  );
}

function parseUuid(value: string): string {
  return StoredRunRecordSchema.shape.id.parse(value);
}
