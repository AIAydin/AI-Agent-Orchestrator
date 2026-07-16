import { describe, expect, it } from 'vitest';

import {
  GitReviewNoteCreateInputSchema,
  GitReviewNoteUpdateInputSchema,
  GitReviewNotesViewSchema,
  GitReviewRelativePathSchema,
} from './contracts.js';

const PROJECT_ID = '70000000-0000-4000-8000-000000000001';
const NOTE_ID = '70000000-0000-4000-8000-000000000002';
const NOW = '2026-07-15T14:00:00.000Z';

describe('Git review-note contracts', () => {
  it('accepts only canonical project-relative Git paths', () => {
    expect(GitReviewRelativePathSchema.parse('src/review notes/example.ts')).toBe(
      'src/review notes/example.ts',
    );
    for (const path of [
      '/tmp/secret',
      '../secret',
      'src/../secret',
      'src//file.ts',
      'src\\file.ts',
      'C:/secret',
      './file.ts',
      'file\nname.ts',
    ]) {
      expect(GitReviewRelativePathSchema.safeParse(path).success).toBe(false);
    }
  });

  it('bounds exact line anchors and trims local feedback', () => {
    const parsed = GitReviewNoteCreateInputSchema.parse({
      target: { kind: 'primary', projectId: PROJECT_ID },
      kind: 'revision-request',
      anchor: {
        area: 'unstaged',
        revisionId: 'a'.repeat(64),
        path: 'src/example.ts',
        hunkId: 'b'.repeat(20),
        side: 'old',
        line: 12,
      },
      body: '  Please preserve the existing behavior.  ',
    });

    expect(parsed.body).toBe('Please preserve the existing behavior.');
    expect(
      GitReviewNoteCreateInputSchema.safeParse({
        ...parsed,
        anchor: { ...parsed.anchor, line: 0 },
      }).success,
    ).toBe(false);
    expect(
      GitReviewNoteCreateInputSchema.safeParse({ ...parsed, body: 'contains\0nul' }).success,
    ).toBe(false);
  });

  it('requires optimistic update evidence and keeps target ownership consistent', () => {
    expect(
      GitReviewNoteUpdateInputSchema.safeParse({
        target: { kind: 'primary', projectId: PROJECT_ID },
        noteId: NOTE_ID,
        expectedUpdatedAt: NOW,
      }).success,
    ).toBe(false);

    const note = {
      id: NOTE_ID,
      projectId: PROJECT_ID,
      target: { kind: 'primary' as const, projectId: PROJECT_ID },
      kind: 'comment' as const,
      anchor: {
        area: 'staged' as const,
        revisionId: 'a'.repeat(64),
        path: 'src/example.ts',
        hunkId: 'b'.repeat(20),
        side: 'new' as const,
        line: 4,
        lineContentSha256: 'c'.repeat(64),
      },
      body: 'Keep this null-safe.',
      status: 'open' as const,
      createdAt: NOW,
      updatedAt: NOW,
      resolvedAt: null,
      anchorState: 'current' as const,
    };
    expect(
      GitReviewNotesViewSchema.safeParse({
        target: { kind: 'primary', projectId: '80000000-0000-4000-8000-000000000001' },
        revisions: [],
        notes: [note],
        truncated: false,
      }).success,
    ).toBe(false);
  });
});
