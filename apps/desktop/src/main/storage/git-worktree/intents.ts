import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import {
  StoredRunRecordSchema,
  effectiveRunWorktreeState,
  type StoredRunRecord,
} from '../../storage-schemas.js';
import { transaction } from '../database.js';
import { getRun } from '../runs-audit.js';
import { type JsonRow } from '../values.js';
import {
  writeAudit,
  writeRunForWorktreeBranchRename,
  writeRunForWorktreeTransition,
} from '../writes.js';

const LifecycleStateSchema = z.enum(['active', 'archived']);

const IntentIdentitySchema = z.object({
  intentId: z.string().uuid(),
  runId: z.string().uuid(),
  worktreeId: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export const GitWorktreeMetadataIntentSchema = z
  .discriminatedUnion('kind', [
    IntentIdentitySchema.extend({
      kind: z.literal('rename-worktree-branch'),
      beforeBranch: z.string().min(1),
      afterBranch: z.string().min(1),
      beforeState: z.literal('active'),
      afterState: z.literal('active'),
    }).strict(),
    IntentIdentitySchema.extend({
      kind: z.literal('archive-worktree'),
      beforeBranch: z.string().min(1),
      afterBranch: z.string().min(1),
      beforeState: z.literal('active'),
      afterState: z.literal('archived'),
    }).strict(),
    IntentIdentitySchema.extend({
      kind: z.literal('restore-worktree'),
      beforeBranch: z.string().min(1),
      afterBranch: z.string().min(1),
      beforeState: z.literal('archived'),
      afterState: z.literal('active'),
    }).strict(),
  ])
  .superRefine((intent, context) => {
    const branchMustChange = intent.kind === 'rename-worktree-branch';
    if ((intent.beforeBranch !== intent.afterBranch) !== branchMustChange) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['afterBranch'],
        message: branchMustChange
          ? 'A branch rename intent must change the branch name.'
          : 'Archive and restore intents cannot change the branch name.',
      });
    }
  });
export type GitWorktreeMetadataIntent = z.infer<typeof GitWorktreeMetadataIntentSchema>;

interface IntentRow {
  readonly intent_id: string;
  readonly run_id: string;
  readonly worktree_id: string;
  readonly kind: string;
  readonly before_branch: string;
  readonly after_branch: string;
  readonly before_state: string;
  readonly after_state: string;
  readonly created_at: string;
}

export function beginGitWorktreeMetadataIntent(
  database: DatabaseSync,
  rawIntent: GitWorktreeMetadataIntent,
): GitWorktreeMetadataIntent {
  const intent = GitWorktreeMetadataIntentSchema.parse(rawIntent);
  return transaction(database, () => {
    const run = getRun(database, intent.runId);
    const lineage = readRunLineage(database, intent.worktreeId);
    if (
      run === undefined ||
      run.worktreeId !== intent.worktreeId ||
      run.branch !== intent.beforeBranch ||
      effectiveRunWorktreeState(run) !== intent.beforeState
    ) {
      throw new Error('The persisted run changed before the lifecycle intent was recorded.');
    }
    if (
      lineage.length === 0 ||
      lineage.some(
        (candidate) =>
          candidate.branch !== intent.beforeBranch ||
          effectiveRunWorktreeState(candidate) !== intent.beforeState,
      )
    ) {
      throw new Error(
        'The persisted worktree lineage changed before the lifecycle intent was recorded.',
      );
    }
    database
      .prepare(
        `INSERT INTO git_worktree_metadata_intents(
          intent_id, run_id, worktree_id, kind, before_branch, after_branch,
          before_state, after_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        intent.intentId,
        intent.runId,
        intent.worktreeId,
        intent.kind,
        intent.beforeBranch,
        intent.afterBranch,
        intent.beforeState,
        intent.afterState,
        intent.createdAt,
      );
    return intent;
  });
}

export function getGitWorktreeMetadataIntent(
  database: DatabaseSync,
  runId: string,
): GitWorktreeMetadataIntent | undefined {
  const parsedRunId = z.string().uuid().parse(runId);
  const row = database
    .prepare('SELECT * FROM git_worktree_metadata_intents WHERE run_id = ?')
    .get(parsedRunId) as unknown as IntentRow | undefined;
  return row === undefined ? undefined : parseRow(row);
}

export function reconcileGitWorktreeMetadataIntent(
  database: DatabaseSync,
  input: {
    readonly intentId: string;
    readonly worktreeId: string;
    readonly branch: string;
    readonly state: 'active' | 'archived';
    readonly reconciledAt: string;
    readonly auditStage: string;
    readonly auditMetadata: Record<string, unknown>;
  },
): 'applied' | 'rolled-back' {
  const intentId = z.string().uuid().parse(input.intentId);
  const worktreeId = z.string().uuid().parse(input.worktreeId);
  const branch = z.string().min(1).parse(input.branch);
  const state = LifecycleStateSchema.parse(input.state);
  const reconciledAt = z.string().datetime().parse(input.reconciledAt);
  return transaction(database, () => {
    const row = database
      .prepare('SELECT * FROM git_worktree_metadata_intents WHERE intent_id = ?')
      .get(intentId) as unknown as IntentRow | undefined;
    if (row === undefined) throw new Error('The managed-worktree lifecycle intent is missing.');
    const intent = parseRow(row);
    if (intent.worktreeId !== worktreeId) {
      throw new Error('The managed-worktree lifecycle intent changed before reconciliation.');
    }
    const before = branch === intent.beforeBranch && state === intent.beforeState;
    const after = branch === intent.afterBranch && state === intent.afterState;
    if (!before && !after) {
      throw new Error('Managed-worktree ownership matches neither side of its durable intent.');
    }
    if (after) applyIntentToRunLineage(database, intent, reconciledAt);
    const disposition = after ? 'applied' : 'rolled-back';
    writeAudit(database, reconciledAt, 'git', intent.kind, after ? 'allowed' : 'failed', {
      ...input.auditMetadata,
      stage: input.auditStage,
      disposition,
    });
    database
      .prepare('DELETE FROM git_worktree_metadata_intents WHERE intent_id = ?')
      .run(intent.intentId);
    return disposition;
  });
}

function applyIntentToRunLineage(
  database: DatabaseSync,
  intent: GitWorktreeMetadataIntent,
  reconciledAt: string,
): void {
  const siblings = readRunLineage(database, intent.worktreeId);
  if (
    siblings.length === 0 ||
    siblings.some(
      (run) =>
        run.branch !== intent.beforeBranch || effectiveRunWorktreeState(run) !== intent.beforeState,
    )
  ) {
    throw new Error('The managed-worktree run lineage changed before reconciliation.');
  }
  for (const run of siblings) {
    const updatedAt =
      Date.parse(reconciledAt) > Date.parse(run.updatedAt) ? reconciledAt : run.updatedAt;
    const next: StoredRunRecord = StoredRunRecordSchema.parse({
      ...run,
      branch: intent.afterBranch,
      worktreeState: intent.afterState,
      updatedAt,
    });
    if (intent.kind === 'rename-worktree-branch') {
      writeRunForWorktreeBranchRename(database, next);
    } else {
      writeRunForWorktreeTransition(database, next);
    }
  }
}

function readRunLineage(database: DatabaseSync, worktreeId: string): StoredRunRecord[] {
  const rows = database
    .prepare(`SELECT value_json FROM agent_runs WHERE json_extract(value_json, '$.worktreeId') = ?`)
    .all(worktreeId) as unknown as JsonRow[];
  return rows.map((row) => StoredRunRecordSchema.parse(JSON.parse(row.value_json)));
}

function parseRow(row: IntentRow): GitWorktreeMetadataIntent {
  return GitWorktreeMetadataIntentSchema.parse({
    intentId: row.intent_id,
    runId: row.run_id,
    worktreeId: row.worktree_id,
    kind: row.kind,
    beforeBranch: row.before_branch,
    afterBranch: row.after_branch,
    beforeState: row.before_state,
    afterState: row.after_state,
    createdAt: row.created_at,
  });
}
