import type { DatabaseSync } from 'node:sqlite';

import {
  StoredGitReviewNoteSchema,
  type GitReviewNoteDeleteInput,
  type GitReviewNoteStatus,
  type GitReviewNoteUpdateInput,
  type StoredGitReviewNote,
} from '../../../shared/git/reviews/contracts.js';
import type { GitTargetInput } from '../../../shared/git/contracts.js';

interface ReviewNoteRow {
  readonly id: string;
  readonly project_id: string;
  readonly target_kind: string;
  readonly run_id: string | null;
  readonly kind: string;
  readonly status: string;
  readonly revision_id: string;
  readonly relative_path: string;
  readonly side: string;
  readonly line_number: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly value_json: string;
}

export interface StoredReviewNotePage {
  readonly notes: StoredGitReviewNote[];
  readonly truncated: boolean;
}

export interface ReviewNoteUpdateMutation extends GitReviewNoteUpdateInput {
  readonly updatedAt: Date;
}

export type ReviewNoteDeleteMutation = GitReviewNoteDeleteInput;

const REVIEW_NOTE_COLUMNS = `
  id, project_id, target_kind, run_id, kind, status, revision_id, relative_path, side,
  line_number, created_at, updated_at, value_json
`;

export function createReviewNote(
  database: DatabaseSync,
  note: StoredGitReviewNote,
): StoredGitReviewNote {
  const parsed = StoredGitReviewNoteSchema.parse(note);
  database
    .prepare(
      `INSERT INTO git_review_notes(
         id, project_id, target_kind, run_id, kind, status, revision_id, relative_path, side,
         line_number, created_at, updated_at, value_json
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      parsed.id,
      parsed.projectId,
      parsed.target.kind,
      parsed.target.kind === 'agent-worktree' ? parsed.target.runId : null,
      parsed.kind,
      parsed.status,
      parsed.anchor.revisionId,
      parsed.anchor.path,
      parsed.anchor.side,
      parsed.anchor.line,
      parsed.createdAt,
      parsed.updatedAt,
      JSON.stringify(parsed),
    );
  return parsed;
}

export function listReviewNotes(
  database: DatabaseSync,
  target: GitTargetInput,
  limit = 500,
): StoredReviewNotePage {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Review-note limit must be an integer from 1 through 500.');
  }
  const rows = selectTargetRows(database, target, limit + 1);
  return {
    notes: rows.slice(0, limit).map(parseReviewNoteRow),
    truncated: rows.length > limit,
  };
}

export function updateReviewNote(
  database: DatabaseSync,
  mutation: ReviewNoteUpdateMutation,
): StoredGitReviewNote {
  const existing = getOwnedReviewNote(database, mutation.target, mutation.noteId);
  if (existing === undefined) throw new Error('The selected review note no longer exists.');
  if (existing.updatedAt !== mutation.expectedUpdatedAt) {
    throw new Error('The review note changed in another window. Refresh before editing it.');
  }
  const status: GitReviewNoteStatus = mutation.status ?? existing.status;
  const updatedAt = mutation.updatedAt.toISOString();
  const next = StoredGitReviewNoteSchema.parse({
    ...existing,
    ...(mutation.body === undefined ? {} : { body: mutation.body }),
    status,
    updatedAt,
    resolvedAt:
      status === 'resolved'
        ? existing.status === 'resolved'
          ? existing.resolvedAt
          : updatedAt
        : null,
  });
  const result = database
    .prepare(
      `UPDATE git_review_notes
       SET kind = ?, status = ?, revision_id = ?, relative_path = ?, side = ?, line_number = ?,
           updated_at = ?, value_json = ?
       WHERE id = ? AND project_id = ? AND target_kind = ?
         AND ((? IS NULL AND run_id IS NULL) OR run_id = ?)
         AND updated_at = ?`,
    )
    .run(
      next.kind,
      next.status,
      next.anchor.revisionId,
      next.anchor.path,
      next.anchor.side,
      next.anchor.line,
      next.updatedAt,
      JSON.stringify(next),
      next.id,
      next.projectId,
      next.target.kind,
      targetRunId(next.target),
      targetRunId(next.target),
      mutation.expectedUpdatedAt,
    );
  if (Number(result.changes) !== 1) {
    throw new Error('The review note changed in another window. Refresh before editing it.');
  }
  return next;
}

export function deleteReviewNote(
  database: DatabaseSync,
  mutation: ReviewNoteDeleteMutation,
): StoredGitReviewNote {
  const existing = getOwnedReviewNote(database, mutation.target, mutation.noteId);
  if (existing === undefined) throw new Error('The selected review note no longer exists.');
  if (existing.updatedAt !== mutation.expectedUpdatedAt) {
    throw new Error('The review note changed in another window. Refresh before deleting it.');
  }
  const result = database
    .prepare(
      `DELETE FROM git_review_notes
       WHERE id = ? AND project_id = ? AND target_kind = ?
         AND ((? IS NULL AND run_id IS NULL) OR run_id = ?)
         AND updated_at = ?`,
    )
    .run(
      existing.id,
      existing.projectId,
      existing.target.kind,
      targetRunId(existing.target),
      targetRunId(existing.target),
      mutation.expectedUpdatedAt,
    );
  if (Number(result.changes) !== 1) {
    throw new Error('The review note changed in another window. Refresh before deleting it.');
  }
  return existing;
}

export function reviewNoteIntegrityMessages(database: DatabaseSync): string[] {
  const rows = database
    .prepare(`SELECT ${REVIEW_NOTE_COLUMNS} FROM git_review_notes ORDER BY id`)
    .all() as unknown as ReviewNoteRow[];
  const messages: string[] = [];
  rows.forEach((row, index) => {
    try {
      parseReviewNoteRow(row);
    } catch (error) {
      messages.push(
        `git_review_notes row ${String(index + 1)}: ${error instanceof Error ? error.message : 'invalid review note'}`,
      );
    }
  });
  return messages;
}

function getOwnedReviewNote(
  database: DatabaseSync,
  target: GitTargetInput,
  noteId: string,
): StoredGitReviewNote | undefined {
  const runId = targetRunId(target);
  const row = database
    .prepare(
      `SELECT ${REVIEW_NOTE_COLUMNS}
       FROM git_review_notes
       WHERE id = ? AND project_id = ? AND target_kind = ?
         AND ((? IS NULL AND run_id IS NULL) OR run_id = ?)`,
    )
    .get(noteId, target.projectId, target.kind, runId, runId) as ReviewNoteRow | undefined;
  return row === undefined ? undefined : parseReviewNoteRow(row);
}

function selectTargetRows(
  database: DatabaseSync,
  target: GitTargetInput,
  limit: number,
): ReviewNoteRow[] {
  const runId = targetRunId(target);
  return database
    .prepare(
      `SELECT ${REVIEW_NOTE_COLUMNS}
       FROM git_review_notes
       WHERE project_id = ? AND target_kind = ?
         AND ((? IS NULL AND run_id IS NULL) OR run_id = ?)
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(target.projectId, target.kind, runId, runId, limit) as unknown as ReviewNoteRow[];
}

function parseReviewNoteRow(row: ReviewNoteRow): StoredGitReviewNote {
  const parsed = StoredGitReviewNoteSchema.parse(JSON.parse(row.value_json) as unknown);
  if (
    parsed.id !== row.id ||
    parsed.projectId !== row.project_id ||
    parsed.target.kind !== row.target_kind ||
    targetRunId(parsed.target) !== row.run_id ||
    parsed.kind !== row.kind ||
    parsed.status !== row.status ||
    parsed.anchor.revisionId !== row.revision_id ||
    parsed.anchor.path !== row.relative_path ||
    parsed.anchor.side !== row.side ||
    parsed.anchor.line !== row.line_number ||
    parsed.createdAt !== row.created_at ||
    parsed.updatedAt !== row.updated_at
  ) {
    throw new Error('indexed columns do not match the stored review note');
  }
  return parsed;
}

function targetRunId(target: GitTargetInput): string | null {
  return target.kind === 'agent-worktree' ? target.runId : null;
}
