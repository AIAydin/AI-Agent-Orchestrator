// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcResult } from '../../../../shared/application/contracts.js';
import type {
  GitCommitPlanView,
  GitDiscardPlanView,
  GitReviewView,
  GitTargetInput,
} from '../../../../shared/git/contracts.js';
import type {
  GitWorktreeCleanupPlanView,
  GitWorktreeCleanupPrepareOutcome,
  GitWorktreeCleanupResultView,
} from '../../../../shared/git/lifecycle/contracts.js';
import type {
  GitShippingPlanView,
  GitShippingResultView,
} from '../../../../shared/git/shipping-contracts.js';
import type { GitReviewNotesView } from '../../../../shared/git/reviews/contracts.js';
import { GitReviewDialog } from './GitReviewDialog.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const runId = '44444444-4444-4444-8444-444444444444';
const worktreeId = '55555555-5555-4555-8555-555555555555';
const commitPlanId = '22222222-2222-4222-8222-222222222222';
const discardPlanId = '33333333-3333-4333-8333-333333333333';
const shippingPlanId = '66666666-6666-4666-8666-666666666666';
const cleanupPlanId = '88888888-8888-4888-8888-888888888888';
const stagedHunkId = 'b'.repeat(20);
const unstagedHunkId = 'a'.repeat(20);
const headOid = 'c'.repeat(40);
const nextHeadOid = 'd'.repeat(40);
const baseOid = 'e'.repeat(40);
const agentHeadOid = 'f'.repeat(40);
const committedHunkId = '9'.repeat(20);
const reviewNoteId = '77777777-7777-4777-8777-777777777777';
const stagedRevisionId = '6'.repeat(64);
const unstagedRevisionId = '7'.repeat(64);
const baseRevisionId = '8'.repeat(64);
const staleRevisionId = '5'.repeat(64);
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

const agentReview: GitReviewView = {
  ...review,
  target: {
    ...worktreeTarget,
    nodeId: 'agent-node-1',
    worktreeId,
    agentId: 'test-agent',
    baseRef: 'refs/heads/main',
    baseCommit: baseOid,
  },
  branch: 'forgeboard/agent-node-1',
  headOid: agentHeadOid,
  upstream: null,
  ahead: 0,
  behind: 0,
  baseComparison: {
    baseCommit: baseOid,
    headCommit: agentHeadOid,
    ahead: 1,
    behind: 0,
    commitCount: 1,
    commits: [{ oid: agentHeadOid, relation: 'ahead' }],
    commitIdsTruncated: false,
    diff: {
      additions: 1,
      deletions: 1,
      files: [diffFile('src/committed.ts', committedHunkId, 'committed line')],
    },
  },
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

const shippingPlan: GitShippingPlanView = {
  kind: 'ship-agent-commits',
  planId: shippingPlanId,
  expiresAt: '2026-07-14T18:05:00.000Z',
  strategy: 'fast-forward-only',
  projectId,
  runId,
  worktreeId,
  projectName: 'Workshop',
  sourceBranch: 'forgeboard/agent-node-1',
  targetBranch: 'main',
  baseRef: 'refs/heads/main',
  baseCommit: baseOid,
  sourceHead: agentHeadOid,
  targetHead: headOid,
  commits: [agentHeadOid],
  affectedPaths: ['src/committed.ts'],
  identity: review.identity,
};

const shippingResult: GitShippingResultView = {
  state: 'completed',
  strategy: 'fast-forward-only',
  headBefore: headOid,
  headAfter: agentHeadOid,
  conflictedPaths: [],
  review,
};

const cleanupPlan: GitWorktreeCleanupPlanView = {
  kind: 'cleanup-worktree',
  recovery: false,
  planId: cleanupPlanId,
  expiresAt: '2026-07-14T18:05:00.000Z',
  branch: 'forgeboard/agent-node-1',
  baseRef: 'refs/heads/main',
  clean: true,
  mergedIntoBase: true,
  dirtyPaths: [],
  dirtyPathCount: 0,
  dirtyPathsTruncated: false,
  force: false,
  deleteBranch: true,
  allowDirty: false,
  allowUnmergedBranch: false,
};

const cleanupResult: GitWorktreeCleanupResultView = {
  worktreeRemoved: true,
  branchDeleted: true,
  metadataRemoved: true,
};

const reviewMock = vi.fn<(target: GitTargetInput) => Promise<IpcResult<GitReviewView>>>(() =>
  Promise.resolve(success(review)),
);
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
const prepareShippingMock = vi.fn(() => Promise.resolve(success(shippingPlan)));
const confirmShippingMock = vi.fn(() => Promise.resolve(success(shippingResult)));
const prepareCleanupMock = vi.fn<() => Promise<IpcResult<GitWorktreeCleanupPrepareOutcome>>>(() =>
  Promise.resolve(success(cleanupPlan)),
);
const confirmCleanupMock = vi.fn(() =>
  Promise.resolve(success<GitWorktreeCleanupResultView | null>(null)),
);
const reviewNotesListMock = vi.fn((input: { readonly target: GitTargetInput }) =>
  Promise.resolve(success(reviewNotesFor(input.target))),
);
const reviewNoteCreateMock = vi.fn((input: { readonly target: GitTargetInput }) =>
  Promise.resolve(success(reviewNotesFor(input.target))),
);
const reviewNoteUpdateMock = vi.fn((input: { readonly target: GitTargetInput }) =>
  Promise.resolve(success(reviewNotesFor(input.target))),
);
const reviewNoteDeleteMock = vi.fn((input: { readonly target: GitTargetInput }) =>
  Promise.resolve(success(reviewNotesFor(input.target))),
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
    prepareShippingMock,
    confirmShippingMock,
    prepareCleanupMock,
    confirmCleanupMock,
    reviewNotesListMock,
    reviewNoteCreateMock,
    reviewNoteUpdateMock,
    reviewNoteDeleteMock,
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
        prepareShipping: prepareShippingMock,
        confirmShipping: confirmShippingMock,
        lifecycle: {
          prepareCleanup: prepareCleanupMock,
          confirmCleanup: confirmCleanupMock,
        },
        reviewNotes: {
          list: reviewNotesListMock,
          create: reviewNoteCreateMock,
          update: reviewNoteUpdateMock,
          delete: reviewNoteDeleteMock,
        },
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
    expect(screen.getByText('3 paths · +2 −1')).toBeTruthy();
    expect(await screen.findByText('File 1 of 3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous changed file' })).toHaveProperty(
      'disabled',
      true,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next changed file' }));
    expect(screen.getByText('File 2 of 3')).toBeTruthy();
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

  it('applies and reports display preferences supplied by a canvas review node', async () => {
    const onDisplayPreferencesChange = vi.fn();
    render(
      <GitReviewDialog
        target={primaryTarget}
        projectName="Workshop"
        displayPreferences={{ viewMode: 'split', showWhitespace: true }}
        onDisplayPreferencesChange={onDisplayPreferencesChange}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole('table', { name: 'Split diff for src/staged.ts' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Show whitespace characters' })).toHaveProperty(
      'checked',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unified' }));
    expect(onDisplayPreferencesChange).toHaveBeenCalledWith({
      viewMode: 'unified',
      showWhitespace: true,
    });
  });

  it('keeps feedback for disappeared files reachable at the dialog level', async () => {
    reviewNotesListMock.mockResolvedValueOnce(
      success({
        ...reviewNotesFor(primaryTarget),
        notes: [
          {
            id: reviewNoteId,
            projectId,
            target: primaryTarget,
            kind: 'revision-request',
            anchor: {
              area: 'unstaged',
              revisionId: staleRevisionId,
              path: 'src/deleted.ts',
              hunkId: unstagedHunkId,
              side: 'old',
              line: 1,
              lineContentSha256: '4'.repeat(64),
            },
            body: 'Restore the deleted guard.',
            status: 'open',
            createdAt: '2026-07-14T18:00:00.000Z',
            updatedAt: '2026-07-14T18:00:00.000Z',
            resolvedAt: null,
            anchorState: 'stale-review',
          },
        ],
      }),
    );

    render(<GitReviewDialog target={primaryTarget} projectName="Workshop" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText('1 note from an earlier diff'));
    expect(screen.getByText(/src\/deleted\.ts · old line 1 · review/)).toBeTruthy();
    expect(screen.getByText('Restore the deleted guard.')).toBeTruthy();
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
    reviewMock.mockResolvedValueOnce(success(agentReview));

    render(<GitReviewDialog target={worktreeTarget} projectName="Workshop" onClose={vi.fn()} />);

    expect(await screen.findByText('Authoritative agent worktree')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Agent worktree target' }).textContent).toContain(
      'The primary checkout remains untouched.',
    );
    const repositoryStatus = screen.getByRole('region', { name: 'Repository status' });
    expect(repositoryStatus.textContent).toContain('forgeboard/agent-node-1');
    expect(repositoryStatus.textContent).toContain('0 ahead · 0 behind');
    expect(repositoryStatus.textContent).toContain('Changed');
    expect(reviewMock).toHaveBeenCalledWith(worktreeTarget);
    expect(screen.getByRole('tab', { name: 'Changes vs base' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getAllByText(baseOid.slice(0, 12))).toHaveLength(2);
    expect(screen.getByText(agentHeadOid.slice(0, 12))).toBeTruthy();
    expect(screen.getByText('1 ahead · 0 behind')).toBeTruthy();
    expect(screen.getAllByText('src/committed.ts')).toHaveLength(2);
    expect(screen.getByText('committed line')).toBeTruthy();
    expect(screen.getByText('Committed comparison')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review delivery…' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('button', { name: 'Stage hunk' })).toBeNull();
    expect(screen.getByRole('button', { name: /Prepare safe cleanup/u })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Staged & unstaged' }));
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts Modified/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Stage src/app.ts' }));
    await waitFor(() => expect(stagePathsMock).toHaveBeenCalledTimes(1));
    expect(stagePathsMock).toHaveBeenCalledWith({
      target: worktreeTarget,
      paths: ['src/app.ts'],
    });
  });

  it('discloses the exact safe cleanup policy before native confirmation and preserves on cancel', async () => {
    reviewMock.mockResolvedValueOnce(
      success({
        ...agentReview,
        dirty: false,
        entries: [],
        staged: { files: [], additions: 0, deletions: 0 },
        unstaged: { files: [], additions: 0, deletions: 0 },
      }),
    );
    const onClose = vi.fn();
    const onCleanupSuccess = vi.fn();

    render(
      <GitReviewDialog
        target={worktreeTarget}
        projectName="Workshop"
        onClose={onClose}
        onCleanupSuccess={onCleanupSuccess}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Prepare safe cleanup/u }));
    const disclosure = await screen.findByRole('alertdialog', {
      name: 'Review safe agent-worktree cleanup',
    });
    expect(prepareCleanupMock).toHaveBeenCalledWith({ projectId, runId });
    expect(confirmCleanupMock).not.toHaveBeenCalled();
    expect(disclosure.textContent).toContain('forgeboard/agent-node-1');
    expect(disclosure.textContent).toContain('refs/heads/main');
    expect(disclosure.textContent).toContain('Clean — verified');
    expect(disclosure.textContent).toContain('Yes — verified');
    expect(disclosure.textContent).toContain('Relative dirty paths0');
    expect(disclosure.textContent).toContain('Managed branch deletionRequired');
    expect(disclosure.textContent).toContain('no force option exists');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Go back' }));

    fireEvent.click(
      screen.getByRole('button', {
        name: /Continue to .*Clean up.* system confirmation/u,
      }),
    );
    await waitFor(() =>
      expect(confirmCleanupMock).toHaveBeenCalledWith({
        planId: cleanupPlanId,
      }),
    );
    expect(await screen.findByText(/Cleanup cancelled in the system confirmation/u)).toBeTruthy();
    expect(onCleanupSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows bounded relative dirty evidence and blocks an ineligible cleanup plan', async () => {
    prepareCleanupMock.mockResolvedValueOnce(
      success({
        ...cleanupPlan,
        clean: false,
        mergedIntoBase: false,
        dirtyPaths: ['src/private-change.ts'],
        dirtyPathCount: 4,
        dirtyPathsTruncated: true,
      }),
    );
    reviewMock.mockResolvedValueOnce(success(agentReview));

    render(<GitReviewDialog target={worktreeTarget} projectName="Workshop" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /Prepare safe cleanup/u }));
    const disclosure = await screen.findByRole('alertdialog', {
      name: 'Review safe agent-worktree cleanup',
    });
    expect(disclosure.textContent).toContain('src/private-change.ts');
    expect(disclosure.textContent).toContain('Relative dirty paths (4)');
    expect(disclosure.textContent).toContain('3 additional relative dirty paths are not shown');
    expect(disclosure.textContent).toContain('This plan is not eligible for safe cleanup');
    expect(
      screen.getByRole('button', {
        name: /Continue to .*Clean up.* system confirmation/u,
      }),
    ).toHaveProperty('disabled', true);
    expect(confirmCleanupMock).not.toHaveBeenCalled();
  });

  it('closes and emits a path-free refresh notice only after complete cleanup', async () => {
    confirmCleanupMock.mockResolvedValueOnce(success(cleanupResult));
    reviewMock.mockResolvedValueOnce(success(agentReview));
    const onClose = vi.fn();
    const onCleanupSuccess = vi.fn();

    render(
      <GitReviewDialog
        target={worktreeTarget}
        projectName="Workshop"
        onClose={onClose}
        onCleanupSuccess={onCleanupSuccess}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Prepare safe cleanup/u }));
    await screen.findByRole('alertdialog', {
      name: 'Review safe agent-worktree cleanup',
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Continue to .*Clean up.* system confirmation/u,
      }),
    );

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onCleanupSuccess).toHaveBeenCalledWith(
      'Cleaned up the exact merged agent worktree and deleted its managed branch.',
    );
  });

  it('refreshes uncertain cleanup state and keeps the review open without claiming success', async () => {
    confirmCleanupMock.mockResolvedValueOnce(success({ ...cleanupResult, branchDeleted: false }));
    reviewMock.mockResolvedValueOnce(success(agentReview));
    const onClose = vi.fn();
    const onCleanupSuccess = vi.fn();
    const onCleanupStateUncertain = vi.fn();
    const onError = vi.fn();

    render(
      <GitReviewDialog
        target={worktreeTarget}
        projectName="Workshop"
        onClose={onClose}
        onCleanupSuccess={onCleanupSuccess}
        onCleanupStateUncertain={onCleanupStateUncertain}
        onError={onError}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Prepare safe cleanup/u }));
    await screen.findByRole('alertdialog', { name: 'Review safe agent-worktree cleanup' });
    fireEvent.click(
      screen.getByRole('button', { name: /Continue to .*Clean up.* system confirmation/u }),
    );

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Cleanup did not report complete worktree, branch, and metadata removal. Refresh run history before continuing.',
      ),
    );
    await waitFor(() => expect(onCleanupStateUncertain).toHaveBeenCalledTimes(1));
    expect(onCleanupSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the review open and reports lifecycle preparation errors', async () => {
    prepareCleanupMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'The managed branch is not merged into its base.',
      },
    });
    reviewMock.mockResolvedValueOnce(success(agentReview));
    const onClose = vi.fn();
    const onCleanupStateUncertain = vi.fn();
    const onError = vi.fn();

    render(
      <GitReviewDialog
        target={worktreeTarget}
        projectName="Workshop"
        onClose={onClose}
        onCleanupStateUncertain={onCleanupStateUncertain}
        onError={onError}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Prepare safe cleanup/u }));
    expect(await screen.findByText('The managed branch is not merged into its base.')).toBeTruthy();
    expect(onError).toHaveBeenCalledWith('The managed branch is not merged into its base.');
    await waitFor(() => expect(onCleanupStateUncertain).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reviews an exact opaque agent delivery before invoking native confirmation', async () => {
    reviewMock.mockResolvedValueOnce(
      success({
        ...agentReview,
        dirty: false,
        entries: [],
        staged: { files: [], additions: 0, deletions: 0 },
        unstaged: { files: [], additions: 0, deletions: 0 },
      }),
    );

    render(<GitReviewDialog target={worktreeTarget} projectName="Workshop" onClose={vi.fn()} />);

    await screen.findByText('Deliver reviewed commits to primary');
    fireEvent.click(screen.getByRole('button', { name: 'Review delivery…' }));
    const disclosure = await screen.findByRole('alertdialog', {
      name: 'Review exact primary delivery',
    });
    expect(prepareShippingMock).toHaveBeenCalledWith({
      target: worktreeTarget,
      strategy: 'fast-forward-only',
    });
    expect(disclosure.textContent).toContain('forgeboard/agent-node-1');
    expect(disclosure.textContent).toContain(`${baseOid}..${agentHeadOid}`);
    expect(disclosure.textContent).toContain('src/committed.ts');
    expect(disclosure.textContent).toContain('Ada Developer <ada@example.test>');
    expect(disclosure.textContent).toContain('name from Forgeboard Settings');
    expect(confirmShippingMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Go back' }));
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Continue to system confirmation' }),
    );
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Go back' }));

    fireEvent.click(screen.getByRole('button', { name: 'Continue to system confirmation' }));
    await waitFor(() =>
      expect(confirmShippingMock).toHaveBeenCalledWith({ planId: shippingPlanId }),
    );
    expect(await screen.findByText(/Delivered reviewed commits to primary/)).toBeTruthy();
  });

  it('shows an honest empty committed comparison while preserving working-tree changes', async () => {
    reviewMock.mockResolvedValueOnce(
      success({
        ...agentReview,
        headOid: baseOid,
        baseComparison: {
          baseCommit: baseOid,
          headCommit: baseOid,
          ahead: 0,
          behind: 0,
          commitCount: 0,
          commits: [],
          commitIdsTruncated: false,
          diff: { files: [], additions: 0, deletions: 0 },
        },
      }),
    );

    render(<GitReviewDialog target={worktreeTarget} projectName="Workshop" onClose={vi.fn()} />);

    expect(await screen.findByText('No committed changes vs base')).toBeTruthy();
    expect(screen.getByText(/Staged or unstaged edits remain available/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Staged & unstaged' }));
    expect(screen.getByRole('button', { name: /src\/app\.ts Modified/ })).toBeTruthy();
  });

  it('surfaces authoritative comparison errors while allowing exact cleanup recovery', async () => {
    const onError = vi.fn();
    reviewMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message: 'Owned worktree comparison failed safely.',
      },
    });
    prepareCleanupMock.mockResolvedValueOnce(success({ ...cleanupPlan, recovery: true }));

    render(
      <GitReviewDialog
        target={worktreeTarget}
        projectName="Workshop"
        cleanupRecovery
        onClose={vi.fn()}
        onError={onError}
      />,
    );

    expect(
      await screen.findByText('Git review is unavailable during cleanup recovery'),
    ).toBeTruthy();
    expect(screen.getByText('Recovery-only agent target')).toBeTruthy();
    expect(screen.getByText('Recover interrupted cleanup in Workshop')).toBeTruthy();
    expect(screen.getByText('Owned worktree comparison failed safely.')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Changes vs base' })).toBeNull();
    expect(reviewMock).toHaveBeenCalledWith(worktreeTarget);
    expect(onError).toHaveBeenCalledWith('Owned worktree comparison failed safely.');

    fireEvent.click(screen.getByRole('button', { name: /Prepare cleanup recovery/u }));
    const disclosure = await screen.findByRole('alertdialog', {
      name: 'Review interrupted cleanup recovery',
    });
    expect(disclosure.textContent).toContain('Interrupted cleanup recovery');
    expect(prepareCleanupMock).toHaveBeenCalledWith({ projectId, runId });
  });

  it('refreshes and closes when interrupted cleanup is already reconciled', async () => {
    reviewMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message: 'This cleanup-pending run has no Git review authority.',
      },
    });
    prepareCleanupMock.mockResolvedValueOnce(
      success({
        kind: 'cleanup-reconciled',
        worktreeRemoved: true,
        branchDeleted: true,
        metadataRemoved: true,
      }),
    );
    const onCleanupSuccess = vi.fn();
    const onClose = vi.fn();

    render(
      <GitReviewDialog
        target={worktreeTarget}
        projectName="Workshop"
        cleanupRecovery
        onClose={onClose}
        onCleanupSuccess={onCleanupSuccess}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Prepare cleanup recovery/u }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onCleanupSuccess).toHaveBeenCalledWith(
      'Reconciled the interrupted cleanup and marked the exact agent worktree as cleaned.',
    );
    expect(confirmCleanupMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('reports an exact active-intact reactivation only from an explicit recovery session', async () => {
    reviewMock
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'OPERATION_FAILED',
          message: 'This cleanup-pending run has no Git review authority.',
        },
      })
      .mockResolvedValueOnce(success(agentReview));
    prepareCleanupMock.mockResolvedValueOnce(success(cleanupPlan));
    const onCleanupTargetReactivated = vi.fn();

    render(
      <GitReviewDialog
        target={worktreeTarget}
        projectName="Workshop"
        cleanupRecovery
        onClose={vi.fn()}
        onCleanupTargetReactivated={onCleanupTargetReactivated}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Prepare cleanup recovery/u }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Review safe agent-worktree cleanup' }),
    ).toBeTruthy();
    expect(onCleanupTargetReactivated).toHaveBeenCalledWith(
      worktreeTarget,
      'Verified the agent worktree is intact and restored its active lifecycle state.',
    );
    await waitFor(() => expect(reviewMock).toHaveBeenCalledTimes(2));
  });

  it('shows cleanup recovery progress and preparation errors in the unavailable review', async () => {
    reviewMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message: 'This cleanup-pending run has no Git review authority.',
      },
    });
    let resolvePrepare!: (result: IpcResult<GitWorktreeCleanupPrepareOutcome>) => void;
    prepareCleanupMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePrepare = resolve;
      }),
    );

    render(
      <GitReviewDialog
        target={worktreeTarget}
        projectName="Workshop"
        cleanupRecovery
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Prepare cleanup recovery/u }));
    expect(await screen.findByText('Preparing cleanup recovery')).toBeTruthy();
    resolvePrepare({
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message: 'Cleanup recovery could not revalidate the exact managed worktree.',
      },
    });
    expect(
      await screen.findByText('Cleanup recovery could not revalidate the exact managed worktree.'),
    ).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps an ordinary unavailable agent review neutral without explicit recovery intent', async () => {
    reviewMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message: 'Owned worktree comparison failed safely.',
      },
    });

    const onCleanupTargetReactivated = vi.fn();
    render(
      <GitReviewDialog
        target={worktreeTarget}
        projectName="Workshop"
        onClose={vi.fn()}
        onCleanupTargetReactivated={onCleanupTargetReactivated}
      />,
    );

    expect(await screen.findByText('Git review is unavailable')).toBeTruthy();
    expect(screen.getByText('Authoritative agent worktree')).toBeTruthy();
    expect(screen.getByText('Review changes in Workshop')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Prepare safe cleanup/u })).toBeTruthy();
    expect(screen.queryByText('Recovery-only agent target')).toBeNull();
    expect(screen.queryByText(/interrupted cleanup/iu)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Prepare safe cleanup/u }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Review safe agent-worktree cleanup' }),
    ).toBeTruthy();
    expect(onCleanupTargetReactivated).not.toHaveBeenCalled();
  });

  it('reveals recovery for a neutral unavailable target only after main returns a recovery plan', async () => {
    reviewMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message: 'The exact pinned run is outside recent history and unavailable for Git review.',
      },
    });
    prepareCleanupMock.mockResolvedValueOnce(success({ ...cleanupPlan, recovery: true }));

    render(<GitReviewDialog target={worktreeTarget} projectName="Workshop" onClose={vi.fn()} />);

    expect(await screen.findByText('Authoritative agent worktree')).toBeTruthy();
    expect(screen.queryByText('Recovery-only agent target')).toBeNull();
    expect(screen.queryByText(/interrupted cleanup/iu)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Prepare safe cleanup/u }));
    const disclosure = await screen.findByRole('alertdialog', {
      name: 'Review interrupted cleanup recovery',
    });
    expect(disclosure.textContent).toContain('Interrupted cleanup recovery');
    expect(prepareCleanupMock).toHaveBeenCalledWith({ projectId, runId });
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

function reviewNotesFor(target: GitTargetInput): GitReviewNotesView {
  return {
    target,
    revisions: [
      ...(target.kind === 'agent-worktree'
        ? [
            {
              area: 'base' as const,
              revisionId: baseRevisionId,
              baseCommit: baseOid,
              headCommit: agentHeadOid,
            },
          ]
        : []),
      {
        area: 'staged',
        revisionId: stagedRevisionId,
        baseCommit: target.kind === 'agent-worktree' ? baseOid : headOid,
        headCommit: target.kind === 'agent-worktree' ? agentHeadOid : headOid,
      },
      {
        area: 'unstaged',
        revisionId: unstagedRevisionId,
        baseCommit: target.kind === 'agent-worktree' ? baseOid : headOid,
        headCommit: target.kind === 'agent-worktree' ? agentHeadOid : headOid,
      },
    ],
    notes: [],
    truncated: false,
  };
}

function success<T>(value: T) {
  return { ok: true as const, value };
}
