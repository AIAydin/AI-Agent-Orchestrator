import { describe, expect, it } from 'vitest';

import type { StoredGitReviewNote } from '../../../shared/git/reviews/contracts.js';
import { reviewNoteDeleteConfirmation } from './native-confirmation.js';

describe('reviewNoteDeleteConfirmation', () => {
  it('is cancel-default, exact, path-free, and excludes note content', () => {
    const note = {
      id: '00000000-0000-4000-8000-000000000090',
      projectId: '00000000-0000-4000-8000-000000000001',
      target: { kind: 'primary', projectId: '00000000-0000-4000-8000-000000000001' },
      kind: 'comment',
      anchor: {
        area: 'unstaged',
        revisionId: 'a'.repeat(64),
        path: '/private/repository/secret.ts',
        hunkId: 'hunk-1',
        side: 'new',
        line: 7,
        lineContentSha256: 'b'.repeat(64),
      },
      body: 'private review content',
      status: 'open',
      createdAt: '2026-07-18T12:00:00.000Z',
      updatedAt: '2026-07-18T12:00:00.000Z',
      resolvedAt: null,
    } as StoredGitReviewNote;

    const options = reviewNoteDeleteConfirmation(note);

    expect(options).toMatchObject({
      buttons: ['Keep note', 'Delete note'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(options.detail).toContain(note.id);
    expect(options.detail).not.toContain(note.body);
    expect(options.detail).not.toContain(note.anchor.path);
  });
});
