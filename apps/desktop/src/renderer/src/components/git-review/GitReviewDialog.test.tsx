// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import type {
  GitDeliveryReadinessGetView,
  GitDeliveryRequiredCheckState,
} from '../../../../shared/git/readiness/index.js';
import {
  readinessApproval,
  readinessCheck,
  readinessFingerprint,
  readinessGetView,
  readinessView,
} from '../../../../shared/git/readiness/test-fixtures.js';
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

const deliverySourceFingerprint = readinessFingerprint({
  sourceHead: agentHeadOid,
  sourceTree: '4'.repeat(40),
  worktreeId,
  runId,
  digest: '3'.repeat(64),
});
const deliveryEvidenceFingerprint = '2'.repeat(64);
const deliveryReadiness = readinessView({
  target: worktreeTarget,
  sourceFingerprint: deliverySourceFingerprint,
  requiredChecks: [readinessCheck('passed', { sourceFingerprint: deliverySourceFingerprint })],
  approvals: [readinessApproval('human', deliverySourceFingerprint, deliveryEvidenceFingerprint)],
  evidenceFingerprint: deliveryEvidenceFingerprint,
});
const deliveryReadinessGetView: GitDeliveryReadinessGetView = {
  ...readinessGetView(),
  target: worktreeTarget,
  source: {
    sourceHead: deliverySourceFingerprint.sourceHead,
    sourceTree: deliverySourceFingerprint.sourceTree,
    worktreeId,
    runId,
  },
  availableChecks: deliveryReadiness.availableChecks,
  readiness: deliveryReadiness,
  staleReason: null,
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
  readinessApprovalId: deliveryReadiness.approvals[0]!.approvalId,
  readiness: deliveryReadiness,
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
const readinessGetMock = vi.fn(() => Promise.resolve(success(deliveryReadinessGetView)));
const readinessPrepareMock = vi.fn(() => Promise.resolve(success(deliveryReadiness)));
const readinessRunMock = vi.fn(() =>
  Promise.resolve(success<typeof deliveryReadiness | null>(null)),
);
const readinessApproveMock = vi.fn(() =>
  Promise.resolve(success<typeof deliveryReadiness | null>(null)),
);
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
    readinessGetMock,
    readinessPrepareMock,
    readinessRunMock,
    readinessApproveMock,
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
        readiness: {
          get: readinessGetMock,
          prepare: readinessPrepareMock,
          run: readinessRunMock,
          approve: readinessApproveMock,
        },
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
    expect(screen.getByText('2 commits ahead · 1 commit behind')).toBeTruthy();
    expect(screen.getByText('3 files · +2 −1')).toBeTruthy();
    expect(await screen.findByText('File 1 of 3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous changed file' })).toHaveProperty(
      'disabled',
      true,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next changed file' }));
    expect(screen.getByText('File 2 of 3')).toBeTruthy();
    expect(await screen.findByText('updated line')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add src/app.ts to commit' }));
    await waitFor(() => expect(stagePathsMock).toHaveBeenCalledTimes(1));
    expect(stagePathsMock).toHaveBeenCalledWith({ target: primaryTarget, paths: ['src/app.ts'] });

    fireEvent.click(screen.getByRole('button', { name: 'Add to commit' }));
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

    expect(
      await screen.findByRole('table', { name: 'Changes in src/staged.ts (side by side)' }),
    ).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Show spaces and tabs' })).toHaveProperty(
      'checked',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'One column' }));
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

    fireEvent.click(await screen.findByText('1 note from an earlier version of these changes'));
    expect(screen.getByText(/src\/deleted\.ts · old line 1 · review/)).toBeTruthy();
    expect(screen.getByText('Restore the deleted guard.')).toBeTruthy();
  });

  it('requires renderer disclosure before invoking native discard confirmation', async () => {
    render(<GitReviewDialog target={primaryTarget} projectName="Workshop" onClose={vi.fn()} />);
    await screen.findByText('origin/feature/review');
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts Modified/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Review discard for change in src/app.ts' }),
    );

    let disclosure = await screen.findByRole('alertdialog', {
      name: 'Discard these changes?',
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

    fireEvent.click(
      screen.getByRole('button', { name: 'Review discard for change in src/app.ts' }),
    );
    disclosure = await screen.findByRole('alertdialog', {
      name: 'Discard these changes?',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(confirmDiscardMock).toHaveBeenCalledWith({ planId: discardPlanId }));
    expect(disclosure).toBeTruthy();
    expect(await screen.findByText(/Discard cancelled/)).toBeTruthy();
  });

  it('reviews the exact message, identity, and staged plan before commit confirmation', async () => {
    render(<GitReviewDialog target={primaryTarget} projectName="Workshop" onClose={vi.fn()} />);
    await screen.findByText('origin/feature/review');
    fireEvent.change(screen.getByLabelText('Commit message'), {
      target: { value: commitPlan.message },
    });
    fireEvent.click(screen.getByRole('button', { name: /Review commit/ }));

    const disclosure = await screen.findByRole('alertdialog', {
      name: 'Review your commit',
    });
    expect(prepareCommitMock).toHaveBeenCalledWith({
      target: primaryTarget,
      message: commitPlan.message,
    });
    expect(disclosure.textContent).toContain('Ada Developer <ada@example.test>');
    expect(disclosure.textContent).toContain(commitPlan.message);
    expect(confirmCommitMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(confirmCommitMock).toHaveBeenCalledWith({ planId: commitPlanId }));
    expect(await screen.findByText(`Created commit ${nextHeadOid.slice(0, 12)}.`)).toBeTruthy();
  });

  it('labels an agent run as an isolated authoritative worktree and preserves opaque targeting', async () => {
    reviewMock.mockResolvedValueOnce(success(agentReview));

    render(<GitReviewDialog target={worktreeTarget} projectName="Workshop" onClose={vi.fn()} />);

    expect(await screen.findByText('Agent workspace')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Agent workspace details' }).textContent).toContain(
      'Your main project files stay untouched.',
    );
    const repositoryStatus = screen.getByRole('region', { name: 'Repository status' });
    expect(repositoryStatus.textContent).toContain('forgeboard/agent-node-1');
    expect(repositoryStatus.textContent).toContain('0 commits ahead · 0 commits behind');
    expect(repositoryStatus.textContent).toContain('Changed');
    expect(reviewMock).toHaveBeenCalledWith(worktreeTarget);
    expect(
      screen.getByRole('tab', { name: 'Committed changes' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getAllByText(baseOid.slice(0, 12))).toHaveLength(2);
    expect(screen.getAllByText(agentHeadOid.slice(0, 12))).toHaveLength(2);
    expect(screen.getByText('1 commit ahead · 0 commits behind')).toBeTruthy();
    expect(screen.getAllByText('src/committed.ts')).toHaveLength(2);
    expect(screen.getByText('committed line')).toBeTruthy();
    expect(screen.getByText('Committed (read-only)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review delivery…' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('button', { name: 'Add to commit' })).toBeNull();
    expect(screen.getByRole('button', { name: /Prepare safe cleanup/u })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Uncommitted changes' }));
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts Modified/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add src/app.ts to commit' }));
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
      name: "Review safe cleanup of the agent's workspace",
    });
    expect(prepareCleanupMock).toHaveBeenCalledWith({ projectId, runId });
    expect(confirmCleanupMock).not.toHaveBeenCalled();
    expect(disclosure.textContent).toContain('forgeboard/agent-node-1');
    expect(disclosure.textContent).toContain('refs/heads/main');
    expect(disclosure.textContent).toContain('No unsaved changes — verified');
    expect(disclosure.textContent).toContain('Yes — verified');
    expect(disclosure.textContent).toContain('Files with unsaved changes0');
    expect(disclosure.textContent).toContain('Branch deletionRequired');
    expect(disclosure.textContent).toContain('no way to force cleanup');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Go back' }));

    fireEvent.click(
      screen.getByRole('button', {
        name: /Continue to the .*Clean up.* confirmation/u,
      }),
    );
    await waitFor(() =>
      expect(confirmCleanupMock).toHaveBeenCalledWith({
        planId: cleanupPlanId,
      }),
    );
    expect(await screen.findByText(/Cleanup cancelled/)).toBeTruthy();
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
      name: "Review safe cleanup of the agent's workspace",
    });
    expect(disclosure.textContent).toContain('src/private-change.ts');
    expect(disclosure.textContent).toContain('Files with unsaved changes (4)');
    expect(disclosure.textContent).toContain('3 more files with unsaved changes are not shown');
    expect(disclosure.textContent).toContain('This plan no longer qualifies for a safe cleanup');
    expect(
      screen.getByRole('button', {
        name: /Continue to the .*Clean up.* confirmation/u,
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
      name: "Review safe cleanup of the agent's workspace",
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Continue to the .*Clean up.* confirmation/u,
      }),
    );

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onCleanupSuccess).toHaveBeenCalledWith(
      'Cleaned up the merged agent workspace and deleted its branch.',
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
    await screen.findByRole('alertdialog', {
      name: "Review safe cleanup of the agent's workspace",
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Continue to the .*Clean up.* confirmation/u }),
    );

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "Forgeboard couldn't confirm that the workspace, branch, and run details were all removed. Refresh the run history before continuing.",
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

    await screen.findByText('Deliver the reviewed changes to the primary branch');
    const reviewDelivery = screen.getByRole('button', { name: 'Review delivery…' });
    await waitFor(() => expect(reviewDelivery).toHaveProperty('disabled', false));
    fireEvent.click(reviewDelivery);
    const disclosure = await screen.findByRole('alertdialog', {
      name: 'Review delivery to the primary branch',
    });
    expect(prepareShippingMock).toHaveBeenCalledWith({
      target: worktreeTarget,
      strategy: 'fast-forward-only',
    });
    expect(disclosure.textContent).toContain('forgeboard/agent-node-1');
    expect(disclosure.textContent).toContain(`${baseOid}..${agentHeadOid}`);
    expect(disclosure.textContent).toContain('src/committed.ts');
    expect(disclosure.textContent).toContain('Ada Developer <ada@example.test>');
    expect(disclosure.textContent).toContain('name from Forgeboard settings');
    expect(confirmShippingMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Go back' }));
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Continue to final confirmation' }),
    );
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Go back' }));

    fireEvent.click(screen.getByRole('button', { name: 'Continue to final confirmation' }));
    await waitFor(() =>
      expect(confirmShippingMock).toHaveBeenCalledWith({ planId: shippingPlanId }),
    );
    expect(await screen.findByText(/Delivered the reviewed commits/)).toBeTruthy();
  });

  it('keeps delivery fail-closed when earlier readiness evidence became stale', async () => {
    const staleReason =
      'The managed source changed after its checks ran. Prepare and approve the new exact source.';
    readinessGetMock.mockResolvedValueOnce(
      success({
        ...deliveryReadinessGetView,
        readiness: null,
        staleReason,
      }),
    );
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

    expect((await screen.findByRole('alert')).textContent).toContain(staleReason);
    const reviewDelivery = screen.getByRole('button', { name: 'Review delivery…' });
    expect(reviewDelivery).toHaveProperty('disabled', true);
    fireEvent.click(reviewDelivery);
    expect(prepareShippingMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Choose a completed workflow run and save its requirements/u),
    ).toBeTruthy();
  });

  it('reports native check cancellation without claiming a delivery check started', async () => {
    const confirmation = deferred<ReturnType<typeof success<typeof deliveryReadiness | null>>>();
    readinessRunMock.mockReturnValueOnce(confirmation.promise);
    reviewMock.mockResolvedValueOnce(success(agentReview));
    render(<GitReviewDialog target={worktreeTarget} projectName="Workshop" onClose={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Re-run Deterministic verification' }),
    );

    await waitFor(() =>
      expect(readinessRunMock).toHaveBeenCalledWith({
        readinessId: deliveryReadiness.readinessId,
        checkId: deliveryReadiness.requiredChecks[0]!.checkId,
        expectedSourceFingerprint: deliveryReadiness.sourceFingerprint.digest,
      }),
    );
    const busyNotice = await screen.findByText('Waiting for the check to finish');
    expect(busyNotice.closest('.git-review-status')?.getAttribute('data-tone')).toBe('neutral');
    await act(async () => {
      confirmation.resolve(success(null));
      await confirmation.promise;
    });
    expect(await screen.findByText('Check cancelled. No check was started.')).toBeTruthy();
    expect(screen.queryByText(/approved delivery check started/iu)).toBeNull();
  });

  it.each<readonly [GitDeliveryRequiredCheckState, string, 'neutral' | 'success' | 'warning']>([
    ['passed', 'The check passed. Delivery status was refreshed.', 'success'],
    ['failed', "The check didn't pass. Delivery stays blocked.", 'warning'],
    ['cancelled', 'The check was cancelled before it could pass.', 'neutral'],
    [
      'lost',
      "Forgeboard lost the check's final result. Delivery stays blocked — run the check again.",
      'warning',
    ],
    [
      'stale',
      'The check result no longer matches the current code. Run the check again.',
      'warning',
    ],
  ])('uses an honest %s completion notice and tone', async (state, message, tone) => {
    const terminalReadiness = readinessView({
      target: worktreeTarget,
      sourceFingerprint: deliverySourceFingerprint,
      requiredChecks: [readinessCheck(state, { sourceFingerprint: deliverySourceFingerprint })],
      approvals: deliveryReadiness.approvals,
      evidenceFingerprint: '7'.repeat(64),
    });
    readinessRunMock.mockResolvedValueOnce(success(terminalReadiness));
    readinessGetMock.mockResolvedValueOnce(success(deliveryReadinessGetView)).mockResolvedValueOnce(
      success({
        ...deliveryReadinessGetView,
        availableChecks: terminalReadiness.availableChecks,
        readiness: terminalReadiness,
      }),
    );
    reviewMock.mockResolvedValueOnce(success(agentReview));
    render(<GitReviewDialog target={worktreeTarget} projectName="Workshop" onClose={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Re-run Deterministic verification' }),
    );

    const notice = await screen.findByText(message);
    expect(notice.closest('.git-review-status')?.getAttribute('data-tone')).toBe(tone);
  });

  it('disables delivery from an authoritative refresh after a check-run error', async () => {
    const lostReadiness = readinessView({
      target: worktreeTarget,
      sourceFingerprint: deliverySourceFingerprint,
      requiredChecks: [readinessCheck('lost', { sourceFingerprint: deliverySourceFingerprint })],
      approvals: deliveryReadiness.approvals,
      evidenceFingerprint: '6'.repeat(64),
    });
    readinessRunMock.mockRejectedValueOnce(new Error('Check completion evidence was lost.'));
    readinessGetMock.mockResolvedValueOnce(success(deliveryReadinessGetView)).mockResolvedValueOnce(
      success({
        ...deliveryReadinessGetView,
        availableChecks: lostReadiness.availableChecks,
        readiness: lostReadiness,
      }),
    );
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

    const reviewDelivery = await screen.findByRole('button', { name: 'Review delivery…' });
    await waitFor(() => expect(reviewDelivery).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Re-run Deterministic verification' }));

    expect(await screen.findByText('Check completion evidence was lost.')).toBeTruthy();
    await waitFor(() => expect(reviewDelivery).toHaveProperty('disabled', true));
    expect(readinessGetMock).toHaveBeenCalledTimes(2);
    expect(prepareShippingMock).not.toHaveBeenCalled();
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

    expect(await screen.findByText('No committed changes to compare')).toBeTruthy();
    expect(screen.getByText(/not committed yet is in the other tab/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Uncommitted changes' }));
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

    expect(await screen.findByText("Can't show changes during cleanup recovery")).toBeTruthy();
    expect(screen.getByText('Cleanup recovery only')).toBeTruthy();
    expect(screen.getByText('Resume interrupted cleanup in Workshop')).toBeTruthy();
    expect(screen.getByText('Owned worktree comparison failed safely.')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Committed changes' })).toBeNull();
    expect(reviewMock).toHaveBeenCalledWith(worktreeTarget);
    expect(onError).toHaveBeenCalledWith('Owned worktree comparison failed safely.');

    fireEvent.click(screen.getByRole('button', { name: /Prepare cleanup recovery/u }));
    const disclosure = await screen.findByRole('alertdialog', {
      name: 'Review the interrupted cleanup recovery',
    });
    expect(disclosure.textContent).toContain('Recovery after an interrupted cleanup');
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
      'Finished the interrupted cleanup and marked the agent workspace as cleaned up.',
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
      await screen.findByRole('alertdialog', {
        name: "Review safe cleanup of the agent's workspace",
      }),
    ).toBeTruthy();
    expect(onCleanupTargetReactivated).toHaveBeenCalledWith(
      worktreeTarget,
      'Verified the agent workspace is intact and made it active again.',
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

    expect(await screen.findByText("Can't show changes right now")).toBeTruthy();
    expect(screen.getByText('Agent workspace')).toBeTruthy();
    expect(screen.getByText('Review changes in Workshop')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Prepare safe cleanup/u })).toBeTruthy();
    expect(screen.queryByText('Cleanup recovery only')).toBeNull();
    expect(screen.queryByText(/interrupted cleanup/iu)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Prepare safe cleanup/u }));
    expect(
      await screen.findByRole('alertdialog', {
        name: "Review safe cleanup of the agent's workspace",
      }),
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

    expect(await screen.findByText('Agent workspace')).toBeTruthy();
    expect(screen.queryByText('Cleanup recovery only')).toBeNull();
    expect(screen.queryByText(/interrupted cleanup/iu)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Prepare safe cleanup/u }));
    const disclosure = await screen.findByRole('alertdialog', {
      name: 'Review the interrupted cleanup recovery',
    });
    expect(disclosure.textContent).toContain('Recovery after an interrupted cleanup');
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
