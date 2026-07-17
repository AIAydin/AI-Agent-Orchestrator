// @vitest-environment jsdom

import type { DiffReviewTarget } from '@forgeboard/core/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitReviewView, GitTargetInput } from '../../../../../shared/git/contracts.js';
import {
  DiffReviewNodeInspector,
  diffReviewGitSummary,
  type DiffReviewAgentRunOption,
  type DiffReviewAuthorityAvailability,
  type DiffReviewDisplayPreferences,
  type DiffReviewGitSummary,
  type DiffReviewOpenRequest,
} from './DiffReviewNodeInspector.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const RUN_ID = '20000000-0000-4000-8000-000000000001';
const SECOND_RUN_ID = '20000000-0000-4000-8000-000000000002';

const runs: readonly DiffReviewAgentRunOption[] = [
  {
    runId: RUN_ID,
    nodeLabel: 'Implement auth',
    agentLabel: 'Codex CLI',
    status: 'succeeded',
    branch: 'forgeboard/auth',
    worktreeState: 'active',
    endedAt: '2026-07-16T15:00:00.000Z',
  },
  {
    runId: SECOND_RUN_ID,
    nodeLabel: 'Review auth',
    agentLabel: 'Claude Code',
    status: 'failed',
    branch: null,
    worktreeState: 'active',
    endedAt: '2026-07-16T15:05:00.000Z',
  },
];

afterEach(cleanup);

describe('DiffReviewNodeInspector', () => {
  it('selects only opaque authoritative targets and passes display preferences to review', () => {
    const onOpenReview = vi.fn<(request: DiffReviewOpenRequest) => void>();
    render(<InteractiveInspector onOpenReview={onOpenReview} />);

    const target = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Review target' });
    expect([...target.options].map((option) => option.text)).toEqual([
      'Primary checkout · Demo project',
      'Implement auth · Codex CLI · succeeded · forgeboard/auth',
      'Review auth · Claude Code · failed · detached branch',
    ]);

    fireEvent.change(target, { target: { value: `agent:${RUN_ID}` } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Layout' }), {
      target: { value: 'split' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Show whitespace characters/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Open authoritative review' }));

    expect(onOpenReview).toHaveBeenCalledWith({
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
      preferences: { viewMode: 'split', showWhitespace: true },
      purpose: 'review',
    });
    expect(JSON.stringify(onOpenReview.mock.calls)).not.toMatch(/worktreeRoot|repositoryPath|cwd/u);
    expect(screen.getByText(/never hides or discards Git changes/u)).toBeTruthy();
  });

  it('keeps an exact older selection available outside the bounded recent-run picker', () => {
    const missingRunId = '20000000-0000-4000-8000-000000000099';
    const onTargetChange = vi.fn();
    const onOpenReview = vi.fn();
    render(
      <DiffReviewNodeInspector
        {...baseProps()}
        selectedTarget={{ kind: 'agent-run', runId: missingRunId }}
        agentRuns={[]}
        onTargetChange={onTargetChange}
        onOpenReview={onOpenReview}
      />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open authoritative review' })).toHaveProperty(
      'disabled',
      false,
    );
    const target = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Review target' });
    expect(target.disabled).toBe(false);
    expect(
      [...target.options].find((option) => option.value === `agent:${missingRunId}`),
    ).toHaveProperty('disabled', false);
    expect(screen.getByRole('option', { name: /outside recent picker/u })).toBeTruthy();
    expect(screen.queryByText(/No recent active or interrupted-cleanup agent runs/u)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open authoritative review' }));
    expect(onOpenReview).toHaveBeenCalledWith({
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: missingRunId },
      preferences: { viewMode: 'unified', showWhitespace: false },
      purpose: 'review',
    });

    fireEvent.change(target, { target: { value: 'primary' } });
    expect(onTargetChange).toHaveBeenCalledWith({ kind: 'primary' });
  });

  it('opens an interrupted cleanup only as recovery despite unavailable Git authority', () => {
    const onOpenReview = vi.fn();
    const cleanupPendingRun: DiffReviewAgentRunOption = {
      ...runs[0]!,
      worktreeState: 'cleanup-pending',
    };
    render(
      <DiffReviewNodeInspector
        {...baseProps()}
        selectedTarget={{ kind: 'agent-run', runId: RUN_ID }}
        agentRuns={[cleanupPendingRun]}
        authority={{
          state: 'unavailable',
          reason: 'This agent worktree cleanup is incomplete and cannot be used safely.',
        }}
        onOpenReview={onOpenReview}
      />,
    );

    expect(
      screen.getByRole('option', {
        name: /cleanup interrupted · recovery only/u,
      }),
    ).toBeTruthy();
    expect(screen.getByText('Cleanup recovery')).toBeTruthy();
    expect(screen.getByText('Agent cleanup recovery')).toBeTruthy();
    expect(screen.getByText(/Cleanup was interrupted for this exact agent run/u)).toBeTruthy();
    const open = screen.getByRole('button', { name: 'Open cleanup recovery' });
    expect(open).toHaveProperty('disabled', false);
    expect(screen.queryByRole('button', { name: 'Open authoritative review' })).toBeNull();

    fireEvent.click(open);
    expect(onOpenReview).toHaveBeenCalledWith({
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID },
      preferences: { viewMode: 'unified', showWhitespace: false },
      purpose: 'cleanup-recovery',
    });
  });

  it('shows bounded-history loading separately from exact main-process verification', () => {
    const missingRunId = '20000000-0000-4000-8000-000000000099';
    const onOpenReview = vi.fn();
    const view = render(
      <DiffReviewNodeInspector
        {...baseProps()}
        selectedTarget={{ kind: 'agent-run', runId: missingRunId }}
        agentRuns={[]}
        agentRunsLoaded={false}
        authority={{ state: 'loading', message: 'Verifying the exact persisted run…' }}
        onOpenReview={onOpenReview}
      />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Verifying the exact persisted run…')).toBeTruthy();
    expect(screen.getByText('Checking')).toBeTruthy();
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Review target' }),
    ).toHaveProperty('value', `agent:${missingRunId}`);
    expect(screen.getByRole('option', { name: /loading recent history/u })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByRole('button', { name: 'Open authoritative review' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Refresh persisted runs' })).toHaveProperty(
      'disabled',
      true,
    );

    view.rerender(
      <DiffReviewNodeInspector
        {...baseProps()}
        selectedTarget={{ kind: 'agent-run', runId: missingRunId }}
        agentRuns={[]}
        agentRunsLoaded
        authority={{ state: 'loading', message: 'Verifying the exact persisted run…' }}
        onOpenReview={onOpenReview}
      />,
    );
    expect(screen.getByRole('option', { name: /outside recent picker/u })).toBeTruthy();

    view.rerender(
      <DiffReviewNodeInspector
        {...baseProps()}
        selectedTarget={{ kind: 'agent-run', runId: missingRunId }}
        agentRuns={[]}
        agentRunsLoaded
        authority={{ state: 'unavailable', reason: 'The exact run no longer owns a worktree.' }}
        onOpenReview={onOpenReview}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'The exact run no longer owns a worktree.',
    );
    expect(screen.getByRole('combobox', { name: 'Review target' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByRole('button', { name: 'Check exact pinned run' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.queryByText('Agent cleanup recovery')).toBeNull();
    expect(screen.queryByText(/Cleanup was interrupted/u)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Check exact pinned run' }));
    expect(onOpenReview).toHaveBeenCalledWith({
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: missingRunId },
      preferences: { viewMode: 'unified', showWhitespace: false },
      purpose: 'review',
    });
  });

  it('identifies and lets the UI bind an unpersisted legacy primary default', () => {
    const onTargetChange = vi.fn();
    const onRecord = vi.fn();
    render(
      <DiffReviewNodeInspector
        projectId={PROJECT_ID}
        projectName="Demo project"
        nodeId="diff-node"
        locked={false}
        configurationReadOnly={false}
        selectedTarget={undefined}
        agentRuns={runs}
        agentRunsLoaded
        agentRunsError={null}
        preferences={{ viewMode: 'unified', showWhitespace: false }}
        authority={{ state: 'ready' }}
        summary={null}
        onRecord={onRecord}
        onTargetChange={onTargetChange}
        onPreferencesChange={vi.fn()}
        onRefreshAgentRuns={vi.fn()}
        onRefreshSummary={vi.fn()}
        onOpenReview={vi.fn()}
      />,
    );

    expect(screen.getByText(/no persisted review target/u)).toBeTruthy();
    expect(screen.getByText('Default target')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bind primary target' }));
    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onTargetChange).toHaveBeenCalledWith({ kind: 'primary' });
  });

  it('keeps locked configuration immutable but allows a ready authoritative review to open', () => {
    const onOpenReview = vi.fn();
    const onTargetChange = vi.fn();
    const onPreferencesChange = vi.fn();
    const onRefreshAgentRuns = vi.fn();
    render(
      <DiffReviewNodeInspector
        {...baseProps()}
        locked
        onOpenReview={onOpenReview}
        onTargetChange={onTargetChange}
        onPreferencesChange={onPreferencesChange}
        onRefreshAgentRuns={onRefreshAgentRuns}
      />,
    );

    expect(screen.getByText(/This node is locked/u)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Review target' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('combobox', { name: 'Layout' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: /Show whitespace characters/u })).toHaveProperty(
      'disabled',
      true,
    );
    const refreshRuns = screen.getByRole('button', { name: 'Refresh persisted runs' });
    expect(refreshRuns).toHaveProperty('disabled', false);
    fireEvent.click(refreshRuns);
    expect(onRefreshAgentRuns).toHaveBeenCalledTimes(1);
    const open = screen.getByRole('button', { name: 'Open authoritative review' });
    expect(open).toHaveProperty('disabled', false);
    fireEvent.click(open);

    expect(onOpenReview).toHaveBeenCalledWith({
      target: { kind: 'primary', projectId: PROJECT_ID },
      preferences: { viewMode: 'unified', showWhitespace: false },
      purpose: 'review',
    });
    expect(onTargetChange).not.toHaveBeenCalled();
    expect(onPreferencesChange).not.toHaveBeenCalled();
  });

  it('keeps collaboration-read-only controls honest and exposes retry actions', () => {
    const onRefreshAgentRuns = vi.fn();
    const onRefreshSummary = vi.fn();
    render(
      <DiffReviewNodeInspector
        {...baseProps()}
        configurationReadOnly
        agentRuns={[]}
        agentRunsError="History storage is temporarily unavailable."
        authority={{ state: 'unavailable', reason: 'Git status could not be read.' }}
        onRefreshAgentRuns={onRefreshAgentRuns}
        onRefreshSummary={onRefreshSummary}
      />,
    );

    expect(screen.getByText(/collaboration role can inspect/u)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Review target' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      screen
        .getAllByRole('alert')
        .map((alert) => alert.textContent)
        .join(' '),
    ).toContain('History storage is temporarily unavailable.');
    expect(screen.queryByText(/No recent active or interrupted-cleanup agent runs/u)).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh persisted runs' })).toHaveProperty(
      'disabled',
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh persisted runs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Git summary' }));
    expect(onRefreshAgentRuns).toHaveBeenCalledTimes(1);
    expect(onRefreshSummary).toHaveBeenCalledTimes(1);
  });

  it('shows only a target-bound summary and exposes clear unavailable state', () => {
    const mismatched = summary({ kind: 'agent-worktree', projectId: PROJECT_ID, runId: RUN_ID });
    const view = render(<DiffReviewNodeInspector {...baseProps()} summary={mismatched} />);

    expect(screen.getByText(/summary belongs to a previous target/u)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Bound Git summary' })).toBeNull();

    view.rerender(
      <DiffReviewNodeInspector
        {...baseProps()}
        summary={summary({ kind: 'primary', projectId: PROJECT_ID })}
      />,
    );
    expect(screen.getByRole('region', { name: 'Bound Git summary' })).toBeTruthy();
    expect(screen.getByText('feature/review')).toBeTruthy();
    expect(screen.getByText('Changed · 3 paths')).toBeTruthy();
    expect(screen.getByText('+12 −4')).toBeTruthy();

    view.rerender(
      <DiffReviewNodeInspector
        {...baseProps()}
        authority={{ state: 'unavailable', reason: 'This project is not a Git repository.' }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'This project is not a Git repository.',
    );
    expect(screen.getByRole('button', { name: 'Open authoritative review' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('combobox', { name: 'Review target' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('shows authoritative committed-agent counts against the persisted base', () => {
    const target: GitTargetInput = {
      kind: 'agent-worktree',
      projectId: PROJECT_ID,
      runId: RUN_ID,
    };
    render(
      <DiffReviewNodeInspector
        {...baseProps()}
        selectedTarget={{ kind: 'agent-run', runId: RUN_ID }}
        summary={{
          ...summary(target),
          dirty: false,
          changedFileCount: 0,
          additions: 0,
          deletions: 0,
          baseComparison: {
            ahead: 2,
            behind: 1,
            commitCount: 3,
            changedFileCount: 2,
            additions: 19,
            deletions: 4,
          },
        }}
      />,
    );

    expect(screen.getByText('Agent vs base')).toBeTruthy();
    expect(screen.getByText('Clean · 0 paths')).toBeTruthy();
    expect(screen.getByText('2 paths · +19 −4 · 3 commits · 2 ahead · 1 behind')).toBeTruthy();
  });

  it('derives committed-agent path and line counts from the authoritative base comparison', () => {
    const result = diffReviewGitSummary({
      ...review(),
      target: {
        kind: 'agent-worktree',
        projectId: PROJECT_ID,
        runId: RUN_ID,
        nodeId: 'agent-node',
        worktreeId: SECOND_RUN_ID,
        agentId: 'test-agent',
        baseRef: 'refs/heads/main',
        baseCommit: 'a'.repeat(40),
      },
      branch: 'forgeboard/review',
      headOid: 'b'.repeat(40),
      dirty: false,
      entries: [],
      staged: { files: [], additions: 0, deletions: 0 },
      unstaged: { files: [], additions: 0, deletions: 0 },
      baseComparison: {
        baseCommit: 'a'.repeat(40),
        headCommit: 'b'.repeat(40),
        ahead: 1,
        behind: 0,
        commitCount: 1,
        commits: [{ oid: 'b'.repeat(40), relation: 'ahead' }],
        commitIdsTruncated: false,
        diff: {
          files: [
            {
              oldPath: 'src/a.ts',
              newPath: 'src/a.ts',
              status: 'modified',
              binary: false,
              hunks: [],
            },
            { oldPath: null, newPath: 'src/b.ts', status: 'added', binary: false, hunks: [] },
          ],
          additions: 19,
          deletions: 4,
        },
      },
    });

    expect(result).toMatchObject({
      dirty: false,
      changedFileCount: 0,
      additions: 0,
      deletions: 0,
      baseComparison: {
        changedFileCount: 2,
        additions: 19,
        deletions: 4,
        commitCount: 1,
      },
    });
  });

  it('derives a bounded renderer summary without copying authoritative worktree metadata', () => {
    const result = diffReviewGitSummary(review());

    expect(result).toEqual({
      target: { kind: 'primary', projectId: PROJECT_ID },
      branch: 'main',
      dirty: true,
      conflicted: false,
      changedFileCount: 1,
      additions: 7,
      deletions: 3,
      ahead: 2,
      behind: 1,
      refreshedAt: '2026-07-16T15:30:00.000Z',
    });
    expect(JSON.stringify(result)).not.toMatch(/nodeId|worktreeId|baseRef|baseCommit/u);
  });
});

function InteractiveInspector({
  onOpenReview,
}: {
  onOpenReview: (request: DiffReviewOpenRequest) => void;
}) {
  const [selectedTarget, setSelectedTarget] = useState<DiffReviewTarget>({ kind: 'primary' });
  const [preferences, setPreferences] = useState<DiffReviewDisplayPreferences>({
    viewMode: 'unified',
    showWhitespace: false,
  });
  return (
    <DiffReviewNodeInspector
      {...baseProps()}
      selectedTarget={selectedTarget}
      preferences={preferences}
      onTargetChange={setSelectedTarget}
      onPreferencesChange={setPreferences}
      onOpenReview={onOpenReview}
    />
  );
}

function baseProps(): {
  projectId: string;
  projectName: string;
  nodeId: string;
  locked: boolean;
  configurationReadOnly: boolean;
  selectedTarget: DiffReviewTarget;
  agentRuns: readonly DiffReviewAgentRunOption[];
  agentRunsLoaded: boolean;
  agentRunsError: string | null;
  preferences: DiffReviewDisplayPreferences;
  authority: DiffReviewAuthorityAvailability;
  summary: DiffReviewGitSummary | null;
  onRecord: () => void;
  onTargetChange: (target: DiffReviewTarget) => void;
  onPreferencesChange: (preferences: DiffReviewDisplayPreferences) => void;
  onRefreshAgentRuns: () => void;
  onRefreshSummary: () => void;
  onOpenReview: (request: DiffReviewOpenRequest) => void;
} {
  return {
    projectId: PROJECT_ID,
    projectName: 'Demo project',
    nodeId: 'diff-node',
    locked: false,
    configurationReadOnly: false,
    selectedTarget: { kind: 'primary' },
    agentRuns: runs,
    agentRunsLoaded: true,
    agentRunsError: null,
    preferences: { viewMode: 'unified', showWhitespace: false },
    authority: { state: 'ready' },
    summary: null,
    onRecord: vi.fn(),
    onTargetChange: vi.fn(),
    onPreferencesChange: vi.fn(),
    onRefreshAgentRuns: vi.fn(),
    onRefreshSummary: vi.fn(),
    onOpenReview: vi.fn(),
  };
}

function summary(target: GitTargetInput): DiffReviewGitSummary {
  return {
    target,
    branch: 'feature/review',
    dirty: true,
    conflicted: false,
    changedFileCount: 3,
    additions: 12,
    deletions: 4,
    ahead: 1,
    behind: 0,
    refreshedAt: '2026-07-16T15:20:00.000Z',
  };
}

function review(): GitReviewView {
  return {
    target: { kind: 'primary', projectId: PROJECT_ID },
    branch: 'main',
    detached: false,
    headOid: 'a'.repeat(40),
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
    dirty: true,
    conflicted: false,
    entries: [
      {
        kind: 'ordinary',
        path: 'src/review.ts',
        index: 'M',
        worktree: 'M',
      },
    ],
    staged: { files: [], additions: 2, deletions: 1 },
    unstaged: { files: [], additions: 5, deletions: 2 },
    identity: {
      name: 'Reviewer',
      email: 'reviewer@example.test',
      nameSource: 'settings',
      emailSource: 'settings',
      ready: true,
    },
    refreshedAt: '2026-07-16T15:30:00.000Z',
  };
}
