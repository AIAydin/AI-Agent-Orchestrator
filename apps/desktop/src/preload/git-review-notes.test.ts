import { describe, expect, it, vi } from 'vitest';

import { GIT_REVIEW_NOTE_IPC_CHANNELS } from '../shared/git/reviews/contracts.js';
import { createGitReviewNotesApi } from './git-review-notes.js';

const PROJECT_ID = '70000000-0000-4000-8000-000000000001';
const NOW = '2026-07-15T14:00:00.000Z';

describe('createGitReviewNotesApi', () => {
  it('validates canonical anchors before invoking main', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: emptyContext() });
    const api = createGitReviewNotesApi(invoke);

    await expect(
      api.create({
        target: primaryTarget(),
        kind: 'comment',
        anchor: {
          area: 'unstaged',
          revisionId: 'a'.repeat(64),
          path: '../outside.ts',
          hunkId: 'b'.repeat(20),
          side: 'new',
          line: 1,
        },
        body: 'Do not invoke this request.',
      }),
    ).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();

    await expect(api.list({ target: primaryTarget() })).resolves.toEqual({
      ok: true,
      value: emptyContext(),
    });
    expect(invoke).toHaveBeenCalledWith(GIT_REVIEW_NOTE_IPC_CHANNELS.list, {
      target: primaryTarget(),
    });
  });

  it('rejects a response that could smuggle an unvalidated path', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ...emptyContext(),
        notes: [
          {
            id: '70000000-0000-4000-8000-000000000002',
            projectId: PROJECT_ID,
            target: primaryTarget(),
            kind: 'comment',
            anchor: {
              area: 'unstaged',
              revisionId: 'a'.repeat(64),
              path: '/tmp/private.ts',
              hunkId: 'b'.repeat(20),
              side: 'new',
              line: 1,
              lineContentSha256: 'c'.repeat(64),
            },
            body: 'Invalid response.',
            status: 'open',
            createdAt: NOW,
            updatedAt: NOW,
            resolvedAt: null,
            anchorState: 'current',
          },
        ],
      },
    });

    await expect(
      createGitReviewNotesApi(invoke).list({ target: primaryTarget() }),
    ).rejects.toBeTruthy();
  });
});

function primaryTarget() {
  return { kind: 'primary' as const, projectId: PROJECT_ID };
}

function emptyContext() {
  return {
    target: primaryTarget(),
    revisions: [],
    notes: [],
    truncated: false,
  };
}
