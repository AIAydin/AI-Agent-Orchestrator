// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitReviewNoteView } from '../../../../../shared/git/reviews/contracts.js';
import { GitDiffViewer } from '../diff/GitDiffViewer.js';
import type { GitDiffDisplayFile } from '../git-review-model.js';
import { GitStaleReviewNotes } from './GitStaleReviewNotes.js';
import { useGitReviewNotes, type GitReviewNotesController } from './useGitReviewNotes.js';

const PROJECT_ID = '70000000-0000-4000-8000-000000000001';
const SECOND_PROJECT_ID = '70000000-0000-4000-8000-000000000003';
const NOTE_ID = '70000000-0000-4000-8000-000000000002';
const REVISION_ID = 'a'.repeat(64);
const HUNK_ID = 'b'.repeat(20);
const NOW = '2026-07-15T14:00:00.000Z';

afterEach(cleanup);

describe('Git diff review feedback', () => {
  it('records a revision request against the exact deleted old-side line', () => {
    const controller = notesController();
    renderViewer(controller);

    fireEvent.click(screen.getByRole('button', { name: 'Comment on old line 1' }));
    expect(
      screen.getByText(/does not approve the AI's work, start an agent, or change your code/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Your feedback on old line 1'), {
      target: { value: 'Restore the deleted null guard.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(controller.create).toHaveBeenCalledWith(
      {
        area: 'unstaged',
        revisionId: REVISION_ID,
        path: 'src/example.ts',
        hunkId: HUNK_ID,
        side: 'old',
        line: 1,
      },
      'revision-request',
      'Restore the deleted null guard.',
    );
  });

  it('renders current line comments with optimistic edit, resolve, and two-step delete controls', async () => {
    const note = reviewNote();
    const controller = notesController([note]);
    renderViewer(controller);

    expect(screen.getByText('Preserve the original behavior.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Comment on old line 1, 1 existing/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit feedback'), {
      target: { value: 'Preserve both null guards.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(controller.update).toHaveBeenCalledWith(note, { body: 'Preserve both null guards.' });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(controller.update).toHaveBeenCalledWith(note, { status: 'resolved' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(controller.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete it' }));
    expect(controller.remove).toHaveBeenCalledWith(note);
  });

  it('keeps stale anchors visible when their file disappears without remapping them', () => {
    const controller = notesController();
    const stale = {
      ...reviewNote(),
      anchor: { ...reviewNote().anchor, path: 'src/deleted.ts' },
      anchorState: 'stale-review' as const,
    };
    render(
      <GitStaleReviewNotes
        notes={[stale]}
        actions={{
          busy: false,
          onUpdate: controller.update,
          onDelete: controller.remove,
        }}
      />,
    );

    fireEvent.click(screen.getByText('1 note from an earlier version of these changes'));
    expect(
      screen.getByText(/kept them here instead of moving them to different lines/),
    ).toBeTruthy();
    expect(screen.getByText(/src\/deleted.ts · old line 1 · review/)).toBeTruthy();
    expect(screen.getByText('Preserve the original behavior.')).toBeTruthy();
  });

  it('does not let a mutation response from one project replace another project review', async () => {
    let resolveFirstCreate: ((value: ReturnType<typeof reviewNotesResult>) => void) | undefined;
    const firstCreate = new Promise<ReturnType<typeof reviewNotesResult>>((resolve) => {
      resolveFirstCreate = resolve;
    });
    const list = vi
      .fn()
      .mockResolvedValueOnce(reviewNotesResult(PROJECT_ID))
      .mockResolvedValueOnce(reviewNotesResult(SECOND_PROJECT_ID));
    const create = vi.fn(() => firstCreate);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        git: {
          reviewNotes: {
            list,
            create,
            update: vi.fn(),
            delete: vi.fn(),
          },
        },
      },
    });
    const hook = renderHook(
      ({ projectId }: { projectId: string }) =>
        useGitReviewNotes({ kind: 'primary', projectId }, 'revision'),
      { initialProps: { projectId: PROJECT_ID } },
    );
    await waitFor(() => expect(hook.result.current.context?.target.projectId).toBe(PROJECT_ID));

    let createResult: Promise<boolean> | undefined;
    act(() => {
      createResult = hook.result.current.create(
        {
          area: 'unstaged',
          revisionId: REVISION_ID,
          path: 'src/example.ts',
          hunkId: HUNK_ID,
          side: 'old',
          line: 1,
        },
        'comment',
        'Project one feedback',
      );
    });
    hook.rerender({ projectId: SECOND_PROJECT_ID });
    await waitFor(() =>
      expect(hook.result.current.context?.target.projectId).toBe(SECOND_PROJECT_ID),
    );
    await act(async () => {
      resolveFirstCreate?.(reviewNotesResult(PROJECT_ID));
      await createResult;
    });

    expect(hook.result.current.context?.target.projectId).toBe(SECOND_PROJECT_ID);
  });
});

function renderViewer(reviewNotes: GitReviewNotesController) {
  return render(
    <GitDiffViewer
      file={file}
      busy={false}
      reviewNotes={reviewNotes}
      onStageHunk={() => undefined}
      onUnstageHunk={() => undefined}
      onPrepareDiscard={() => undefined}
    />,
  );
}

function notesController(notes: GitReviewNoteView[] = []): GitReviewNotesController {
  return {
    context: {
      target: { kind: 'primary', projectId: PROJECT_ID },
      revisions: [
        {
          area: 'unstaged',
          revisionId: REVISION_ID,
          baseCommit: 'c'.repeat(40),
          headCommit: 'c'.repeat(40),
        },
      ],
      notes,
      truncated: false,
    },
    busy: false,
    error: null,
    create: vi.fn().mockResolvedValue(true),
    update: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
  };
}

function reviewNote(): GitReviewNoteView {
  return {
    id: NOTE_ID,
    projectId: PROJECT_ID,
    target: { kind: 'primary', projectId: PROJECT_ID },
    kind: 'comment',
    anchor: {
      area: 'unstaged',
      revisionId: REVISION_ID,
      path: 'src/example.ts',
      hunkId: HUNK_ID,
      side: 'old',
      line: 1,
      lineContentSha256: 'd'.repeat(64),
    },
    body: 'Preserve the original behavior.',
    status: 'open',
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
    anchorState: 'current',
  };
}

function reviewNotesResult(projectId: string) {
  return {
    ok: true as const,
    value: {
      target: { kind: 'primary' as const, projectId },
      revisions: [],
      notes: [],
      truncated: false,
    },
  };
}

const file: GitDiffDisplayFile = {
  area: 'unstaged',
  path: 'src/example.ts',
  diff: {
    oldPath: 'src/example.ts',
    newPath: 'src/example.ts',
    status: 'modified',
    binary: false,
    hunks: [
      {
        id: HUNK_ID,
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: 'deletion', content: 'old line', oldLine: 1, newLine: null },
          { kind: 'addition', content: 'new line', oldLine: null, newLine: 1 },
        ],
      },
    ],
  },
};
