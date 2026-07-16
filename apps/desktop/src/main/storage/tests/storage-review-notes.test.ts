import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../../shared/application/contracts.js';
import type { StoredGitReviewNote } from '../../../shared/git/reviews/contracts.js';
import { LocalStore } from '../../storage.js';

const PROJECT_ID = '70000000-0000-4000-8000-000000000001';
const NOTE_ID = '70000000-0000-4000-8000-000000000002';
const CREATED_AT = '2026-07-15T14:00:00.000Z';
const UPDATED_AT = '2026-07-15T14:01:00.000Z';
const temporaryDirectories: string[] = [];
const openStores = new Set<LocalStore>();

afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('local Git review-note storage', () => {
  it('persists, bounds, edits, resolves, reopens, and deletes target-owned notes', () => {
    const databasePath = createDatabasePath();
    const store = openStore(databasePath);
    store.saveProject(project());
    expect(store.createReviewNote(reviewNote())).toEqual(reviewNote());
    expect(store.listReviewNotes(primaryTarget())).toMatchObject({
      notes: [reviewNote()],
      truncated: false,
    });

    const resolved = store.updateReviewNote(
      {
        target: primaryTarget(),
        noteId: NOTE_ID,
        expectedUpdatedAt: CREATED_AT,
        body: 'Addressed by preserving the null guard.',
        status: 'resolved',
      },
      new Date(UPDATED_AT),
    );
    expect(resolved).toMatchObject({
      body: 'Addressed by preserving the null guard.',
      status: 'resolved',
      updatedAt: UPDATED_AT,
      resolvedAt: UPDATED_AT,
    });
    expect(() =>
      store.updateReviewNote(
        {
          target: primaryTarget(),
          noteId: NOTE_ID,
          expectedUpdatedAt: CREATED_AT,
          status: 'open',
        },
        new Date('2026-07-15T14:02:00.000Z'),
      ),
    ).toThrow(/changed in another window/iu);

    closeStore(store);
    const reopened = openStore(databasePath);
    expect(reopened.listReviewNotes(primaryTarget()).notes).toEqual([resolved]);
    expect(
      reopened.deleteReviewNote({
        target: primaryTarget(),
        noteId: NOTE_ID,
        expectedUpdatedAt: UPDATED_AT,
      }),
    ).toEqual(resolved);
    expect(reopened.listReviewNotes(primaryTarget()).notes).toEqual([]);
  });

  it('includes review notes in integrity checks and one-click local deletion', async () => {
    const store = openStore();
    store.saveProject(project());
    store.createReviewNote(reviewNote());
    expect(store.checkIntegrity('full')).toMatchObject({ ok: true, messages: [] });

    const inspector = new DatabaseSync(store.databasePath);
    try {
      inspector
        .prepare("UPDATE git_review_notes SET relative_path = 'different.ts' WHERE id = ?")
        .run(NOTE_ID);
    } finally {
      inspector.close();
    }
    expect(store.checkIntegrity('full')).toMatchObject({ ok: false });
    expect(store.checkIntegrity('full').messages.join(' ')).toContain('indexed columns');

    await store.deleteAllLocalData();
    expect(store.listReviewNotes(primaryTarget()).notes).toEqual([]);
    expect(store.checkIntegrity('full')).toMatchObject({ ok: true, messages: [] });
  });
});

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-review-note-storage-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state', 'forgeboard.sqlite3');
}

function openStore(databasePath = createDatabasePath()): LocalStore {
  const store = new LocalStore(databasePath);
  openStores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  openStores.delete(store);
}

function primaryTarget() {
  return { kind: 'primary' as const, projectId: PROJECT_ID };
}

function reviewNote(): StoredGitReviewNote {
  return {
    id: NOTE_ID,
    projectId: PROJECT_ID,
    target: primaryTarget(),
    kind: 'comment',
    anchor: {
      area: 'unstaged',
      revisionId: 'a'.repeat(64),
      path: 'src/example.ts',
      hunkId: 'b'.repeat(20),
      side: 'old',
      line: 12,
      lineContentSha256: 'c'.repeat(64),
    },
    body: 'Preserve the null guard.',
    status: 'open',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    resolvedAt: null,
  };
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Review note fixture',
    path: '/tmp/review-note-fixture',
    openedAt: CREATED_AT,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}
