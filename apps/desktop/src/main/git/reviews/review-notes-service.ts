import { createHash, randomUUID } from 'node:crypto';

import {
  GitReviewNoteCreateInputSchema,
  GitReviewNoteDeleteInputSchema,
  GitReviewNotesViewSchema,
  GitReviewNoteUpdateInputSchema,
  StoredGitReviewNoteSchema,
  type GitReviewAnchorInput,
  type GitReviewAnchorState,
  type GitReviewNoteCreateInput,
  type GitReviewNoteDeleteInput,
  type GitReviewNotesView,
  type GitReviewNoteUpdateInput,
  type GitReviewRevisionView,
  type StoredGitReviewNote,
} from '../../../shared/git/reviews/contracts.js';
import type {
  GitDiffLineView,
  GitDiffView,
  GitReviewTargetView,
  GitReviewView,
  GitTargetInput,
} from '../../../shared/git/contracts.js';
import type { LocalStore } from '../../storage.js';

type ReviewNoteStore = Pick<
  LocalStore,
  'createReviewNote' | 'deleteReviewNote' | 'listReviewNotes' | 'updateReviewNote'
>;

interface ReviewClock {
  readonly now: () => Date;
  readonly uuid: () => string;
}

const DEFAULT_CLOCK: ReviewClock = { now: () => new Date(), uuid: randomUUID };

/** Owns durable local review feedback without executing an agent or mutating Git. */
export class GitReviewNotesService {
  public constructor(
    private readonly store: ReviewNoteStore,
    private readonly clock: ReviewClock = DEFAULT_CLOCK,
  ) {}

  public list(target: GitTargetInput, review: GitReviewView): GitReviewNotesView {
    assertReviewTarget(target, review.target);
    return this.#context(target, review);
  }

  public create(input: GitReviewNoteCreateInput, review: GitReviewView): GitReviewNotesView {
    const parsed = GitReviewNoteCreateInputSchema.parse(input);
    assertReviewTarget(parsed.target, review.target);
    const revisions = currentRevisions(review);
    const revision = revisions.find((candidate) => candidate.area === parsed.anchor.area);
    if (revision === undefined || revision.revisionId !== parsed.anchor.revisionId) {
      throw new Error('The selected diff changed. Refresh before adding review feedback.');
    }
    const line = findAnchorLine(review, parsed.anchor);
    if (line === undefined) {
      throw new Error('The selected diff line is no longer present. Refresh before commenting.');
    }
    const now = this.clock.now().toISOString();
    this.store.createReviewNote(
      StoredGitReviewNoteSchema.parse({
        id: this.clock.uuid(),
        projectId: parsed.target.projectId,
        target: parsed.target,
        kind: parsed.kind,
        anchor: {
          ...parsed.anchor,
          lineContentSha256: lineContentSha256(line),
        },
        body: parsed.body,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      }),
    );
    return this.#context(parsed.target, review, revisions);
  }

  public update(input: GitReviewNoteUpdateInput, review: GitReviewView): GitReviewNotesView {
    const parsed = GitReviewNoteUpdateInputSchema.parse(input);
    assertReviewTarget(parsed.target, review.target);
    const updatedAt = monotonicUpdateTime(parsed.expectedUpdatedAt, this.clock.now());
    this.store.updateReviewNote(parsed, updatedAt);
    return this.#context(parsed.target, review);
  }

  public delete(input: GitReviewNoteDeleteInput, review: GitReviewView): GitReviewNotesView {
    const parsed = GitReviewNoteDeleteInputSchema.parse(input);
    assertReviewTarget(parsed.target, review.target);
    this.store.deleteReviewNote(parsed);
    return this.#context(parsed.target, review);
  }

  #context(
    target: GitTargetInput,
    review: GitReviewView,
    revisions = currentRevisions(review),
  ): GitReviewNotesView {
    const page = this.store.listReviewNotes(target, 500);
    return GitReviewNotesViewSchema.parse({
      target,
      revisions,
      notes: page.notes.map((note) => ({
        ...note,
        anchorState: anchorState(note, revisions, review),
      })),
      truncated: page.truncated,
    });
  }
}

export function currentRevisions(review: GitReviewView): GitReviewRevisionView[] {
  const target = targetInput(review.target);
  const workingBase =
    review.target.kind === 'agent-worktree' ? review.target.baseCommit : review.headOid;
  const revisions: GitReviewRevisionView[] = [
    revision(target, 'staged', workingBase, review.headOid, review.staged),
    revision(target, 'unstaged', workingBase, review.headOid, review.unstaged),
  ];
  if (review.target.kind === 'agent-worktree' && review.baseComparison !== undefined) {
    revisions.unshift(
      revision(
        target,
        'base',
        review.baseComparison.baseCommit,
        review.baseComparison.headCommit,
        review.baseComparison.diff,
      ),
    );
  }
  return revisions;
}

function revision(
  target: GitTargetInput,
  area: GitReviewRevisionView['area'],
  baseCommit: string | null,
  headCommit: string | null,
  diff: GitDiffView,
): GitReviewRevisionView {
  const revisionId = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        target,
        area,
        baseCommit,
        headCommit,
        diff,
      }),
    )
    .digest('hex');
  return { area, revisionId, baseCommit, headCommit };
}

function anchorState(
  note: StoredGitReviewNote,
  revisions: readonly GitReviewRevisionView[],
  review: GitReviewView,
): GitReviewAnchorState {
  const revision = revisions.find((candidate) => candidate.area === note.anchor.area);
  if (revision?.revisionId !== note.anchor.revisionId) return 'stale-review';
  const line = findAnchorLine(review, note.anchor);
  return line !== undefined && lineContentSha256(line) === note.anchor.lineContentSha256
    ? 'current'
    : 'line-missing';
}

function findAnchorLine(
  review: GitReviewView,
  anchor: GitReviewAnchorInput,
): GitDiffLineView | undefined {
  const diff = diffForArea(review, anchor.area);
  const file = diff?.files.find(
    (candidate) => (candidate.newPath ?? candidate.oldPath) === anchor.path,
  );
  const hunk = file?.hunks.find((candidate) => candidate.id === anchor.hunkId);
  return hunk?.lines.find((line) =>
    anchor.side === 'old' ? line.oldLine === anchor.line : line.newLine === anchor.line,
  );
}

function diffForArea(
  review: GitReviewView,
  area: GitReviewAnchorInput['area'],
): GitDiffView | undefined {
  if (area === 'staged') return review.staged;
  if (area === 'unstaged') return review.unstaged;
  return review.baseComparison?.diff;
}

function lineContentSha256(line: GitDiffLineView): string {
  return createHash('sha256').update(`${line.kind}\0${line.content}`).digest('hex');
}

function targetInput(target: GitReviewTargetView): GitTargetInput {
  return target.kind === 'primary'
    ? { kind: 'primary', projectId: target.projectId }
    : { kind: 'agent-worktree', projectId: target.projectId, runId: target.runId };
}

function assertReviewTarget(input: GitTargetInput, target: GitReviewTargetView): void {
  const resolved = targetInput(target);
  if (
    input.kind !== resolved.kind ||
    input.projectId !== resolved.projectId ||
    (input.kind === 'agent-worktree' &&
      (resolved.kind !== 'agent-worktree' || input.runId !== resolved.runId))
  ) {
    throw new Error('The review feedback target does not match the authoritative Git review.');
  }
}

function monotonicUpdateTime(expectedUpdatedAt: string, now: Date): Date {
  const expectedMs = Date.parse(expectedUpdatedAt);
  return now.getTime() > expectedMs ? now : new Date(expectedMs + 1);
}
