// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GitCommitPlanView,
  GitDiscardPlanView,
  GitReviewView,
} from '../../../../shared/git-contracts.js';
import { GitReviewDialog } from './GitReviewDialog.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const runId = '44444444-4444-4444-8444-444444444444';
const worktreeId = '55555555-5555-4555-8555-555555555555';
const commitPlanId = '22222222-2222-4222-8222-222222222222';
const discardPlanId = '33333333-3333-4333-8333-333333333333';
const stagedHunkId = 'b'.repeat(20);
const unstagedHunkId = 'a'.repeat(20);
const headOid = 'c'.repeat(40);
const nextHeadOid = 'd'.repeat(40);
const primaryTarget = { kind: 'primary' as const, projectId };
const worktreeTarget = { kind: 'agent-worktree' as const, projectId, runId };

const review: GitReviewView = {
  target: primaryTarget,
  branch: 'feature/review',
  detached: false,
  headOid,
  upstream: 'origin/feature/review',
  ahead: 2,
  behind: 1,
  dirty: true,
  conflicted: false,
  entries: [
    { kind: 'ordinary', path: 'src/staged.ts', index: 'M', worktree: '.' },
    { kind: 'ordinary', path: 'src/app.ts', index: '.', worktree: 'M' },
    { kind: 'untracked', path: 'notes.txt', index: '?', worktree: '?' },
  ],
  staged: {
    additions: 1,
    deletions: 0,
    files: [diffFile('src/staged.ts', stagedHunkId, 'staged line')],
  },
  unstaged: {
    additions: 1,
    deletions: 1,
    files: [diffFile('src/app.ts', unstagedHunkId, 'updated line')],
  },
  identity: {
    name: 'Ada Developer',
    email: 'ada@example.test',
    nameSource: 'settings',
    emailSource: 'settings',
    ready: true,
  },
  refreshedAt: '2026-07-14T18:00:00.000Z',
};

const discardPlan: GitDiscardPlanView = {
  kind: 'discard-hunks',
  planId: discardPlanId,
  expiresAt: '2026-07-14T18:05:00.000Z',
  target: primaryTarget,
  branch: review.branch,
  headOid,
  hunkIds: [unstagedHunkId],
  paths: ['src/app.ts'],
  additions: 1,
  deletions: 1,
};

const commitPlan: GitCommitPlanView = {
  kind: 'commit',
  planId: commitPlanId,
  expiresAt: '2026-07-14T18:05:00.000Z',
  target: primaryTarget,
  message: 'Describe the reviewed change',
  branch: review.branch,
  headOid,
  stagedPaths: ['src/staged.ts'],
  additions: 1,
  deletions: 0,
  identity: review.identity,
};

const reviewMock = vi.fn(() => Promise.resolve(success(review)));
const stagePathsMock = vi.fn(() => Promise.resolve(success(review)));
const stageHunksMock = vi.fn(() => Promise.resolve(success(review)));
const unstagePathsMock = vi.fn(() => Promise.resolve(success(review)));
const unstageHunksMock = vi.fn(() => Promise.resolve(success(review)));
const prepareDiscardMock = vi.fn(() => Promise.resolve(success(discardPlan)));
const confirmDiscardMock = vi.fn(() => Promise.resolve(success<GitReviewView | null>(null)));
const prepareCommitMock = vi.fn(() => Promise.resolve(success(commitPlan)));
const confirmCommitMock = vi.fn(() =>
  Promise.resolve(
    success({
      headBefore: headOid,
      headAfter: nextHeadOid,
      review: { ...review, headOid: nextHeadOid },
    }),
  ),
);

beforeEach(() => {
  for (const mock of [
    reviewMock,
    stagePathsMock,
    stageHunksMock,
    unstagePathsMock,
    unstageHunksMock,
    prepareDiscardMock,
    confirmDiscardMock,
    prepareCommitMock,
    confirmCommitMock,
  ]) {
    mock.mockClear();
  }
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      git: {
        review: reviewMock,
        stagePaths: stagePathsMock,
        stageHunks: stageHunksMock,
        unstagePaths: unstagePathsMock,
        unstageHunks: unstageHunksMock,
        prepareDiscard: prepareDiscardMock,
        confirmDiscard: confirmDiscardMock,
        prepareCommit: prepareCommitMock,
        confirmCommit: confirmCommitMock,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('GitReviewDialog', () => {
  it('loads authoritative status, focuses close, and sends only bounded stage selections', async () => {
    const origin = document.createElement('button');
    document.body.append(origin);
    origin.focus();
    const onClose = vi.fn();
    const rendered = render(
      <GitReviewDialog target={primaryTarget} projectName="Workshop" onClose={onClose} />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Review changes in Workshop' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close Git review' }));
    await screen.findByText('origin/feature/review');
    expect(screen.getByText('2 ahead · 1 behind')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts Modified/ }));
    expect(await screen.findByText('updated line')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stage src/app.ts' }));
    await waitFor(() => expect(stagePathsMock).toHaveBeenCalledTimes(1));
    expect(stagePathsMock).toHaveBeenCalledWith({ target: primaryTarget, paths: ['src/app.ts'] });

    fireEvent.click(screen.getByRole('button', { name: 'Stage hunk' }));
    await waitFor(() => expect(stageHunksMock).toHaveBeenCalledTimes(1));
    expect(stageHunksMock).toHaveBeenCalledWith({
      target: primaryTarget,
      hunkIds: [unstagedHunkId],
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    rendered.unmount();
    expect(document.activeElement).toBe(origin);
  });

  it('requires renderer disclosure before invoking native discard confirmation', async () => {
    render(<GitReviewDialog target={primaryTarget} projectName="Workshop" onClose={vi.fn()} />);
    await screen.findByText('origin/feature/review');
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts Modified/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review discard for hunk in src/app.ts' }));

    let disclosure = await screen.findByRole('alertdialog', {
      name: 'Review permanent hunk discard',
    });
    expect(prepareDiscardMock).toHaveBeenCalledWith({
      target: primaryTarget,
      hunkIds: [unstagedHunkId],
    });
    expect(confirmDiscardMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Go back' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Review changes in Workshop' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Review discard for hunk in src/app.ts' }));
    disclosure = await screen.findByRole('alertdialog', {
      name: 'Review permanent hunk discard',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to system confirmation' }));
    await waitFor(() => expect(confirmDiscardMock).toHaveBeenCalledWith({ planId: discardPlanId }));
    expect(disclosure).toBeTruthy();
    expect(await screen.findByText(/Discard cancelled in the system confirmation/)).toBeTruthy();
  });

  it('reviews the exact message, identity, and staged plan before commit confirmation', async () => {
    render(<GitReviewDialog target={primaryTarget} projectName="Workshop" onClose={vi.fn()} />);
    await screen.findByText('origin/feature/review');
    fireEvent.change(screen.getByLabelText('Commit message'), {
      target: { value: commitPlan.message },
    });
    fireEvent.click(screen.getByRole('button', { name: /Review commit/ }));

    const disclosure = await screen.findByRole('alertdialog', {
      name: 'Review the exact local commit',
    });
    expect(prepareCommitMock).toHaveBeenCalledWith({
      target: primaryTarget,
      message: commitPlan.message,
    });
    expect(disclosure.textContent).toContain('Ada Developer <ada@example.test>');
    expect(disclosure.textContent).toContain(commitPlan.message);
    expect(confirmCommitMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue to system confirmation' }));
    await waitFor(() => expect(confirmCommitMock).toHaveBeenCalledWith({ planId: commitPlanId }));
    expect(
      await screen.findByText(`Created local commit ${nextHeadOid.slice(0, 12)}.`),
    ).toBeTruthy();
  });

  it('labels an agent run as an isolated authoritative worktree and preserves opaque targeting', async () => {
    reviewMock.mockResolvedValueOnce(
      success({
        ...review,
        target: {
          ...worktreeTarget,
          nodeId: 'agent-node-1',
          worktreeId,
          agentId: 'test-agent',
          baseRef: 'refs/heads/main',
          baseCommit: 'e'.repeat(40),
        },
        branch: 'forgeboard/agent-node-1',
        upstream: null,
        ahead: 1,
        behind: 0,
      }),
    );

    render(<GitReviewDialog target={worktreeTarget} projectName="Workshop" onClose={vi.fn()} />);

    expect(await screen.findByText('Authoritative agent worktree')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Agent worktree target' }).textContent).toContain(
      'The primary checkout remains untouched.',
    );
    expect(reviewMock).toHaveBeenCalledWith(worktreeTarget);

    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts Modified/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Stage src/app.ts' }));
    await waitFor(() => expect(stagePathsMock).toHaveBeenCalledTimes(1));
    expect(stagePathsMock).toHaveBeenCalledWith({
      target: worktreeTarget,
      paths: ['src/app.ts'],
    });
  });
});

function diffFile(path: string, id: string, addition: string) {
  return {
    oldPath: path,
    newPath: path,
    status: 'modified' as const,
    binary: false,
    hunks: [
      {
        id,
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: 'deletion' as const, content: 'old line', oldLine: 1, newLine: null },
          { kind: 'addition' as const, content: addition, oldLine: null, newLine: 1 },
        ],
      },
    ],
  };
}

function success<T>(value: T) {
  return { ok: true as const, value };
}
