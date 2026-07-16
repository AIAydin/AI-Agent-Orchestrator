import { describe, expect, it, vi } from 'vitest';

import type {
  GitReviewNoteDeleteInput,
  GitReviewNoteUpdateInput,
  StoredGitReviewNote,
} from '../../../shared/git/reviews/contracts.js';
import type { GitReviewView } from '../../../shared/git/contracts.js';
import { GitReviewNotesService, currentRevisions } from './review-notes-service.js';

const PROJECT_ID = '70000000-0000-4000-8000-000000000001';
const NOTE_ID = '70000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-07-15T14:00:00.000Z');

describe('GitReviewNotesService', () => {
  it('binds comments and revision requests to exact old/new lines without mutating Git', () => {
    const store = inMemoryStore();
    const service = new GitReviewNotesService(store, { now: () => NOW, uuid: () => NOTE_ID });
    const review = primaryReview();
    const unstaged = requiredRevision(review, 'unstaged');

    const context = service.create(
      {
        target: primaryTarget(),
        kind: 'revision-request',
        anchor: {
          area: 'unstaged',
          revisionId: unstaged.revisionId,
          path: 'src/example.ts',
          hunkId: 'b'.repeat(20),
          side: 'old',
          line: 1,
        },
        body: 'Restore the null guard before this can be accepted.',
      },
      review,
    );

    expect(context.notes).toMatchObject([
      {
        id: NOTE_ID,
        kind: 'revision-request',
        anchor: { side: 'old', line: 1 },
        anchorState: 'current',
        status: 'open',
      },
    ]);
    expect(store.createReviewNote).toHaveBeenCalledTimes(1);
    expect(store.updateReviewNote).not.toHaveBeenCalled();
    expect(store.deleteReviewNote).not.toHaveBeenCalled();
  });

  it('refuses stale revisions, missing paths, and the wrong side of a deleted line', () => {
    const service = new GitReviewNotesService(inMemoryStore(), {
      now: () => NOW,
      uuid: () => NOTE_ID,
    });
    const review = primaryReview();
    const anchor = {
      area: 'unstaged' as const,
      revisionId: requiredRevision(review, 'unstaged').revisionId,
      path: 'src/example.ts',
      hunkId: 'b'.repeat(20),
      side: 'new' as const,
      line: 1,
    };

    expect(() =>
      service.create(
        {
          target: primaryTarget(),
          kind: 'comment',
          anchor: { ...anchor, revisionId: 'f'.repeat(64) },
          body: 'Stale feedback',
        },
        review,
      ),
    ).toThrow(/diff changed/iu);
    expect(() =>
      service.create(
        {
          target: primaryTarget(),
          kind: 'comment',
          anchor: { ...anchor, path: 'src/missing.ts' },
          body: 'Missing file feedback',
        },
        review,
      ),
    ).toThrow(/line is no longer present/iu);
    expect(() =>
      service.create(
        {
          target: primaryTarget(),
          kind: 'comment',
          anchor,
          body: 'A deletion has no new-side line.',
        },
        review,
      ),
    ).toThrow(/line is no longer present/iu);
  });

  it('keeps notes durable but marks them stale when the reviewed diff changes', () => {
    const note = storedNote(primaryReview());
    const store = inMemoryStore([note]);
    const service = new GitReviewNotesService(store, { now: () => NOW, uuid: () => NOTE_ID });
    expect(service.list(primaryTarget(), primaryReview()).notes[0]?.anchorState).toBe('current');

    const changed = primaryReview();
    changed.unstaged.files[0]!.hunks[0]!.lines[0]!.content = 'different old line';
    expect(service.list(primaryTarget(), changed).notes[0]).toMatchObject({
      id: NOTE_ID,
      anchorState: 'stale-review',
      body: note.body,
    });
  });

  it('allows optimistic edit, resolve, and delete even after an anchor becomes stale', () => {
    const note = storedNote(primaryReview());
    const store = inMemoryStore([note]);
    const service = new GitReviewNotesService(store, {
      now: () => new Date(note.updatedAt),
      uuid: () => NOTE_ID,
    });
    const changed = primaryReview();
    changed.unstaged.files[0]!.hunks[0]!.lines[0]!.content = 'different old line';

    service.update(
      {
        target: primaryTarget(),
        noteId: NOTE_ID,
        expectedUpdatedAt: note.updatedAt,
        body: 'Updated local feedback.',
        status: 'resolved',
      },
      changed,
    );
    expect(store.updateReviewNote).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Updated local feedback.', status: 'resolved' }),
      new Date(Date.parse(note.updatedAt) + 1),
    );

    const current = store.notes[0]!;
    service.delete(
      { target: primaryTarget(), noteId: NOTE_ID, expectedUpdatedAt: current.updatedAt },
      changed,
    );
    expect(store.deleteReviewNote).toHaveBeenCalledTimes(1);
  });
});

function requiredRevision(review: GitReviewView, area: 'staged' | 'unstaged') {
  const revision = currentRevisions(review).find((candidate) => candidate.area === area);
  if (revision === undefined) throw new Error(`Missing ${area} revision.`);
  return revision;
}

function storedNote(review: GitReviewView): StoredGitReviewNote {
  return {
    id: NOTE_ID,
    projectId: PROJECT_ID,
    target: primaryTarget(),
    kind: 'comment',
    anchor: {
      area: 'unstaged',
      revisionId: requiredRevision(review, 'unstaged').revisionId,
      path: 'src/example.ts',
      hunkId: 'b'.repeat(20),
      side: 'old',
      line: 1,
      lineContentSha256: '56a7da1da6f4cd675b80903fbb2097efa4b33642ad152ff6716e48d0da35d336',
    },
    body: 'Preserve the original behavior.',
    status: 'open',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    resolvedAt: null,
  };
}

function inMemoryStore(initial: StoredGitReviewNote[] = []) {
  const notes = [...initial];
  return {
    notes,
    createReviewNote: vi.fn((note: StoredGitReviewNote) => {
      notes.unshift(note);
      return note;
    }),
    listReviewNotes: vi.fn(() => ({ notes: [...notes], truncated: false })),
    updateReviewNote: vi.fn((input: GitReviewNoteUpdateInput, updatedAt: Date) => {
      const index = notes.findIndex((note) => note.id === input.noteId);
      const existing = notes[index];
      if (existing === undefined) throw new Error('missing');
      const status = input.status ?? existing.status;
      const next: StoredGitReviewNote = {
        ...existing,
        ...(input.body === undefined ? {} : { body: input.body }),
        status,
        updatedAt: updatedAt.toISOString(),
        resolvedAt: status === 'resolved' ? updatedAt.toISOString() : null,
      };
      notes[index] = next;
      return next;
    }),
    deleteReviewNote: vi.fn((input: GitReviewNoteDeleteInput) => {
      const index = notes.findIndex((note) => note.id === input.noteId);
      const [deleted] = notes.splice(index, 1);
      if (deleted === undefined) throw new Error('missing');
      return deleted;
    }),
  };
}

function primaryTarget() {
  return { kind: 'primary' as const, projectId: PROJECT_ID };
}

function primaryReview(): GitReviewView {
  return {
    target: primaryTarget(),
    branch: 'main',
    detached: false,
    headOid: 'a'.repeat(40),
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: true,
    conflicted: false,
    entries: [],
    staged: { files: [], additions: 0, deletions: 0 },
    unstaged: {
      additions: 0,
      deletions: 1,
      files: [
        {
          oldPath: 'src/example.ts',
          newPath: 'src/example.ts',
          status: 'modified',
          binary: false,
          hunks: [
            {
              id: 'b'.repeat(20),
              header: '@@ -1 +0 @@',
              oldStart: 1,
              oldLines: 1,
              newStart: 0,
              newLines: 0,
              lines: [{ kind: 'deletion', content: 'old line', oldLine: 1, newLine: null }],
            },
          ],
        },
      ],
    },
    identity: {
      name: '',
      email: '',
      nameSource: 'missing',
      emailSource: 'missing',
      ready: false,
    },
    refreshedAt: NOW.toISOString(),
  };
}
