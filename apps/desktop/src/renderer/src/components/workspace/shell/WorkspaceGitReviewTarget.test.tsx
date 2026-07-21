// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type CanvasDocument,
  type Project,
} from '../../../../../shared/application/contracts.js';
import type { GitTargetInput } from '../../../../../shared/git/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import type { DiffReviewDisplayPreferences, DiffReviewOpenRequest } from '../diff-review/index.js';
import { Workspace } from './Workspace.js';

const collaborationMocks = vi.hoisted(() => ({ graphReadOnly: false }));
const diffReviewMocks = vi.hoisted(() => ({
  refreshAgentRuns: vi.fn(),
  refreshSummary: vi.fn(),
}));

vi.mock('../canvas/useCanvasPersistence.js', () => ({
  useCanvasPersistence: () => ({
    saveState: 'saved',
    persistedUpdatedAt: '2026-07-17T12:00:00.000Z',
    flushCanvas: vi.fn(() => Promise.resolve(true)),
  }),
}));
vi.mock('../collaboration/useCollaborationCanvas.js', () => ({
  useCollaborationCanvas: () => ({
    awareness: [],
    rejectedComments: [],
    rejectedCommentEntries: [],
    graphReadOnly: collaborationMocks.graphReadOnly,
    role: null,
    canComment: false,
    createComment: vi.fn().mockResolvedValue(null),
    discardRejectedComment: vi.fn().mockResolvedValue(false),
    updateCursor: vi.fn(),
    clearCursor: vi.fn(),
  }),
}));
vi.mock('../diff-review/useDiffReviewNodeController.js', () => ({
  useDiffReviewNodeController: () => ({
    agentRuns: [],
    agentRunsLoaded: true,
    agentRunsError: null,
    authority: { state: 'ready' },
    summary: null,
    refreshAgentRuns: diffReviewMocks.refreshAgentRuns,
    refreshSummary: diffReviewMocks.refreshSummary,
  }),
}));
vi.mock('./WorkspaceCommandBar.js', () => ({
  WorkspaceCommandBar: ({
    canUndo,
    onUndo,
    onOpenGitReview,
  }: {
    canUndo: boolean;
    onUndo: () => void;
    onOpenGitReview: () => void;
  }) => (
    <div>
      <button type="button" onClick={onOpenGitReview}>
        Topbar Git review
      </button>
      <button type="button" disabled={!canUndo} onClick={onUndo}>
        Undo canvas
      </button>
    </div>
  ),
}));
vi.mock('../canvas/WorkspaceCanvas.js', () => ({
  WorkspaceCanvas: ({
    nodes,
    onSelectionChange,
  }: {
    nodes: WorkshopNode[];
    onSelectionChange: (selection: { nodes: WorkshopNode[]; edges: [] }) => void;
  }) => (
    <div>
      <output data-testid="workspace-node-state">
        {JSON.stringify(
          nodes.map((node) => ({
            id: node.id,
            kind: node.data.kind,
            locked: node.data.locked,
            reviewTarget: node.data.reviewTarget,
            viewMode: node.data.viewMode,
            showWhitespace: node.data.showWhitespace,
          })),
        )}
      </output>
      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          onClick={() => onSelectionChange({ nodes: [node], edges: [] })}
        >
          Select {node.data.title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('./WorkspaceRail.js', () => ({ WorkspaceRail: () => null }));
vi.mock('./WorkspaceInspector.js', () => ({
  WorkspaceInspector: ({
    project,
    selectedNode,
    onRecord,
    onUpdateSelected,
    onOpenDiffReview,
  }: {
    project: Project;
    selectedNode: WorkshopNode | null;
    onRecord: () => void;
    onUpdateSelected: (data: Partial<WorkshopNode['data']>) => void;
    onOpenDiffReview: (request: DiffReviewOpenRequest) => void;
  }) => {
    const isDiff = selectedNode?.data.kind === 'diff';
    return (
      <div>
        <output data-testid="selected-node-id">{selectedNode?.id ?? ''}</output>
        <button
          type="button"
          disabled={!isDiff}
          onClick={() => {
            if (!isDiff || selectedNode === null) return;
            const configuredTarget = selectedNode.data.reviewTarget ?? { kind: 'primary' as const };
            onOpenDiffReview({
              target:
                configuredTarget.kind === 'primary'
                  ? { kind: 'primary', projectId: project.id }
                  : {
                      kind: 'agent-worktree',
                      projectId: project.id,
                      runId: configuredTarget.runId,
                    },
              preferences: {
                viewMode: selectedNode.data.viewMode ?? 'split',
                showWhitespace: selectedNode.data.showWhitespace ?? false,
              },
              purpose: 'review',
            });
          }}
        >
          Open selected Diff review
        </button>
        <button
          type="button"
          disabled={!isDiff || selectedNode?.data.reviewTarget?.kind !== 'agent-run'}
          onClick={() => {
            if (
              !isDiff ||
              selectedNode === null ||
              selectedNode.data.reviewTarget?.kind !== 'agent-run'
            ) {
              return;
            }
            onOpenDiffReview({
              target: {
                kind: 'agent-worktree',
                projectId: project.id,
                runId: selectedNode.data.reviewTarget.runId,
              },
              preferences: {
                viewMode: selectedNode.data.viewMode ?? 'split',
                showWhitespace: selectedNode.data.showWhitespace ?? false,
              },
              purpose: 'cleanup-recovery',
            });
          }}
        >
          Open selected cleanup recovery
        </button>
        <button
          type="button"
          disabled={!isDiff}
          onClick={() => {
            onRecord();
            onUpdateSelected({ reviewTarget: { kind: 'agent-run', runId: RUN_ID } });
          }}
        >
          Retarget selected Diff
        </button>
        <button
          type="button"
          disabled={!isDiff}
          onClick={() => {
            onRecord();
            onUpdateSelected({ locked: true });
          }}
        >
          Lock selected Diff
        </button>
      </div>
    );
  },
}));
vi.mock('../activity/WorkspaceActivityDrawer.js', () => ({
  WorkspaceActivityDrawer: ({
    changeReports,
    onOpenGitReview,
  }: {
    changeReports: Array<{ runId: string | null }>;
    onOpenGitReview: (runId?: string) => void;
  }) => (
    <div>
      <output data-testid="change-reports">{JSON.stringify(changeReports)}</output>
      <button type="button" onClick={() => onOpenGitReview()}>
        Drawer primary review
      </button>
      {changeReports[0]?.runId && (
        <button type="button" onClick={() => onOpenGitReview(changeReports[0]?.runId ?? undefined)}>
          Drawer agent review
        </button>
      )}
    </div>
  ),
}));
vi.mock('../../shell/CommandPalette.js', () => ({
  CommandPalette: ({
    actions,
  }: {
    actions: Array<{ id: string; run: () => void }>;
    onClose: () => void;
  }) => (
    <button
      type="button"
      onClick={() => actions.find((action) => action.id === 'git-review')?.run()}
    >
      Palette Git review
    </button>
  ),
}));
vi.mock('../../git-review/GitReviewDialog.js', () => ({
  GitReviewDialog: ({
    target,
    cleanupRecovery,
    displayPreferences,
    onDisplayPreferencesChange,
    onClose,
    onCleanupSuccess,
    onCleanupTargetReactivated,
    onCleanupStateUncertain,
  }: {
    target: GitTargetInput;
    cleanupRecovery?: boolean;
    displayPreferences?: DiffReviewDisplayPreferences;
    onDisplayPreferencesChange?: (preferences: DiffReviewDisplayPreferences) => void;
    onClose: () => void;
    onCleanupSuccess?: (message: string) => void;
    onCleanupTargetReactivated?: (target: GitTargetInput, message: string) => void;
    onCleanupStateUncertain?: () => void;
  }) => (
    <div role="dialog" aria-label="Git review target">
      <output data-testid="git-target">{JSON.stringify(target)}</output>
      <output data-testid="git-cleanup-recovery">{String(cleanupRecovery ?? false)}</output>
      <output data-testid="git-display-preferences">
        {JSON.stringify(displayPreferences ?? null)}
      </output>
      <button
        type="button"
        disabled={onDisplayPreferencesChange === undefined}
        onClick={() =>
          onDisplayPreferencesChange?.({
            viewMode: displayPreferences?.viewMode === 'unified' ? 'split' : 'unified',
            showWhitespace: !(displayPreferences?.showWhitespace ?? false),
          })
        }
      >
        Toggle dialog preferences
      </button>
      <button type="button" onClick={onClose}>
        Close Git review
      </button>
      {target.kind === 'agent-worktree' && (
        <>
          <button
            type="button"
            onClick={() => {
              onCleanupSuccess?.('Cleaned up the exact merged agent worktree.');
              onClose();
            }}
          >
            Complete worktree cleanup
          </button>
          <button
            type="button"
            onClick={() =>
              onCleanupTargetReactivated?.(
                target,
                'Verified the agent worktree is intact and restored its active lifecycle state.',
              )
            }
          >
            Reactivate intact cleanup target
          </button>
          <button type="button" onClick={onCleanupStateUncertain}>
            Refresh uncertain cleanup state
          </button>
        </>
      )}
    </div>
  ),
}));
vi.mock('../runs/RunApprovalDialog.js', () => ({ RunApprovalDialog: () => null }));
vi.mock('../CheckApprovalDialog.js', () => ({ CheckApprovalDialog: () => null }));
vi.mock('../previews/useWorkspacePreviews.js', () => ({
  useWorkspacePreviews: () => ({ sessions: {}, updateSession: vi.fn() }),
}));
vi.mock('../runs/useAgentRunController.js', () => ({
  useAgentRunController: () => ({
    disclosure: null,
    preparingRun: false,
    approvingRun: false,
    runInput: '',
    setRunInput: vi.fn(),
    sendRunInput: vi.fn(),
    controlRun: vi.fn(),
    prepareSelectedRun: vi.fn(),
    cancelPreparedRun: vi.fn(),
    approvePreparedRun: vi.fn(),
  }),
}));
vi.mock('../useProjectChecks.js', () => ({
  useProjectChecks: () => ({
    latestByCheckId: new Map(),
    busyCheckId: null,
    prepare: vi.fn(),
    cancel: vi.fn(),
    plan: null,
    approving: false,
    dismissPlan: vi.fn(),
    confirm: vi.fn(),
  }),
}));
vi.mock('../workflows/useWorkflowRuns.js', () => ({
  workflowIsActive: () => false,
  useWorkflowRuns: () => ({
    executions: [],
    currentExecution: null,
    activeExecution: null,
    selectedExecutionId: null,
    loading: false,
    busyAction: null,
    selectExecution: vi.fn(),
    refresh: vi.fn(),
    start: vi.fn(),
    approveNode: vi.fn(),
    approveHuman: vi.fn(),
    decideReview: vi.fn(),
    resolveRevisionEscape: vi.fn(),
    cancel: vi.fn(),
  }),
}));

beforeEach(() => {
  collaborationMocks.graphReadOnly = false;
  diffReviewMocks.refreshAgentRuns.mockClear();
  diffReviewMocks.refreshSummary.mockClear();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      canvas: { load: vi.fn(() => Promise.resolve({ ok: true, value: canvas() })) },
      runs: { onEvent: vi.fn(() => vi.fn()) },
      agentPeers: { onEvent: vi.fn(() => vi.fn()), provision: vi.fn() },
    },
  });
});

afterEach(cleanup);

describe('Workspace Git review targeting', () => {
  it('keeps project entry points primary and binds agent review to the persisted run', async () => {
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(readReports()[0]?.runId).toBe(RUN_ID));
    expect(readReports()[0]?.runPermissionProfile).toBe('worktree-write');

    for (const entryPoint of ['Topbar Git review', 'Drawer primary review']) {
      fireEvent.click(screen.getByRole('button', { name: entryPoint }));
      expect(readTarget()).toEqual({ kind: 'primary', projectId: PROJECT_ID });
      fireEvent.click(screen.getByRole('button', { name: 'Close Git review' }));
    }

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Palette Git review' }));
    expect(readTarget()).toEqual({ kind: 'primary', projectId: PROJECT_ID });
    fireEvent.click(screen.getByRole('button', { name: 'Close Git review' }));

    fireEvent.click(screen.getByRole('button', { name: 'Drawer agent review' }));
    expect(readTarget()).toEqual({
      kind: 'agent-worktree',
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });
  });

  it('persists both dialog preferences to the exact source Diff node and restores both with one undo', async () => {
    renderWorkspace();
    await selectNode('Source Diff', 'diff-source');
    fireEvent.click(screen.getByRole('button', { name: 'Open selected Diff review' }));

    expect(readDialogPreferences()).toEqual({ viewMode: 'split', showWhitespace: false });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle dialog preferences' }));

    await waitFor(() =>
      expect(readNodeState('diff-source')).toMatchObject({
        viewMode: 'unified',
        showWhitespace: true,
      }),
    );
    expect(readNodeState('diff-other')).toMatchObject({
      viewMode: 'split',
      showWhitespace: false,
    });
    const undo = screen.getByRole('button', { name: 'Undo canvas' });
    await waitFor(() => expect(undo).toHaveProperty('disabled', false));
    fireEvent.click(undo);

    await waitFor(() =>
      expect(readNodeState('diff-source')).toMatchObject({
        viewMode: 'split',
        showWhitespace: false,
      }),
    );
    expect(readNodeState('diff-other')).toMatchObject({
      viewMode: 'split',
      showWhitespace: false,
    });
    expect(undo).toHaveProperty('disabled', true);
  });

  it('refreshes run history and Git authority after cleanup without changing the historical pin', async () => {
    renderWorkspace();
    await selectNode('Source Diff', 'diff-source');
    fireEvent.click(screen.getByRole('button', { name: 'Retarget selected Diff' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open selected Diff review' }));
    expect(readTarget()).toEqual({
      kind: 'agent-worktree',
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Complete worktree cleanup' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Git review target' })).toBeNull(),
    );
    expect(diffReviewMocks.refreshAgentRuns).toHaveBeenCalledTimes(1);
    expect(diffReviewMocks.refreshSummary).toHaveBeenCalled();
    expect(readNodeState('diff-source').reviewTarget).toEqual({
      kind: 'agent-run',
      runId: RUN_ID,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo canvas' }));
    await waitFor(() =>
      expect(readNodeState('diff-source').reviewTarget).toEqual({ kind: 'primary' }),
    );
    expect(screen.getByRole('button', { name: 'Undo canvas' })).toHaveProperty('disabled', true);
  });

  it('clears only reactivated cleanup intent while preserving the exact pinned Diff run', async () => {
    renderWorkspace();
    await selectNode('Source Diff', 'diff-source');
    fireEvent.click(screen.getByRole('button', { name: 'Retarget selected Diff' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open selected cleanup recovery' }));

    expect(readTarget()).toEqual({
      kind: 'agent-worktree',
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });
    expect(screen.getByTestId('git-cleanup-recovery').textContent).toBe('true');
    expect(readNodeState('diff-source').reviewTarget).toEqual({
      kind: 'agent-run',
      runId: RUN_ID,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reactivate intact cleanup target' }));
    await waitFor(() =>
      expect(screen.getByTestId('git-cleanup-recovery').textContent).toBe('false'),
    );
    expect(readTarget()).toEqual({
      kind: 'agent-worktree',
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });
    expect(readNodeState('diff-source').reviewTarget).toEqual({
      kind: 'agent-run',
      runId: RUN_ID,
    });
    expect(diffReviewMocks.refreshAgentRuns).toHaveBeenCalledTimes(1);
    expect(diffReviewMocks.refreshSummary).toHaveBeenCalledTimes(1);
  });

  it('refreshes uncertain cleanup state without closing or changing the pinned Diff run', async () => {
    renderWorkspace();
    await selectNode('Source Diff', 'diff-source');
    fireEvent.click(screen.getByRole('button', { name: 'Retarget selected Diff' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open selected Diff review' }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh uncertain cleanup state' }));

    expect(screen.getByRole('dialog', { name: 'Git review target' })).toBeTruthy();
    expect(readTarget()).toEqual({
      kind: 'agent-worktree',
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });
    expect(readNodeState('diff-source').reviewTarget).toEqual({
      kind: 'agent-run',
      runId: RUN_ID,
    });
    expect(diffReviewMocks.refreshAgentRuns).toHaveBeenCalledTimes(1);
    expect(diffReviewMocks.refreshSummary).toHaveBeenCalledTimes(1);
  });

  it('keeps a dialog bound to its exact source when selection drifts to another Diff node', async () => {
    renderWorkspace();
    await selectNode('Source Diff', 'diff-source');
    fireEvent.click(screen.getByRole('button', { name: 'Open selected Diff review' }));
    await selectNode('Other Diff', 'diff-other');

    fireEvent.click(screen.getByRole('button', { name: 'Toggle dialog preferences' }));
    await waitFor(() =>
      expect(readNodeState('diff-source')).toMatchObject({
        viewMode: 'unified',
        showWhitespace: true,
      }),
    );
    expect(readNodeState('diff-other')).toMatchObject({
      viewMode: 'split',
      showWhitespace: false,
    });
  });

  it.each([
    ['retargeted', 'Retarget selected Diff'],
    ['locked', 'Lock selected Diff'],
  ])('does not write dialog preferences after the source node is %s', async (_state, action) => {
    renderWorkspace();
    await selectNode('Source Diff', 'diff-source');
    fireEvent.click(screen.getByRole('button', { name: 'Open selected Diff review' }));
    fireEvent.click(screen.getByRole('button', { name: action }));

    const toggle = screen.getByRole('button', { name: 'Toggle dialog preferences' });
    await waitFor(() => expect(toggle).toHaveProperty('disabled', true));
    fireEvent.click(toggle);
    expect(readNodeState('diff-source')).toMatchObject({
      viewMode: 'split',
      showWhitespace: false,
    });
    expect(readNodeState('diff-other')).toMatchObject({
      viewMode: 'split',
      showWhitespace: false,
    });
  });

  it('does not write dialog preferences after collaboration becomes read-only', async () => {
    const onError = vi.fn();
    const view = render(workspaceElement(onError));
    await selectNode('Source Diff', 'diff-source');
    fireEvent.click(screen.getByRole('button', { name: 'Open selected Diff review' }));

    collaborationMocks.graphReadOnly = true;
    view.rerender(workspaceElement(onError));
    const toggle = screen.getByRole('button', { name: 'Toggle dialog preferences' });
    await waitFor(() => expect(toggle).toHaveProperty('disabled', true));
    fireEvent.click(toggle);
    expect(readNodeState('diff-source')).toMatchObject({
      viewMode: 'split',
      showWhitespace: false,
    });
    expect(readNodeState('diff-other')).toMatchObject({
      viewMode: 'split',
      showWhitespace: false,
    });
  });
});

const PROJECT_ID = '70000000-0000-4000-8000-000000000011';
const RUN_ID = '70000000-0000-4000-8000-000000000012';

interface DiffNodeState {
  readonly id: string;
  readonly kind: string;
  readonly locked: boolean;
  readonly reviewTarget?: { readonly kind: string; readonly runId?: string };
  readonly viewMode?: string;
  readonly showWhitespace?: boolean;
}

function renderWorkspace() {
  return render(workspaceElement(vi.fn()));
}

function workspaceElement(onError: (message: string) => void) {
  return (
    <Workspace
      project={project()}
      settings={settings()}
      agents={[]}
      extensionDiscovery={{
        registryPath: '/tmp/extensions.json',
        installed: [],
        quarantined: [],
        invalid: [],
      }}
      onClose={vi.fn()}
      onProjectUpdated={vi.fn()}
      onOpenSettings={vi.fn()}
      onError={onError}
    />
  );
}

async function selectNode(title: string, expectedId: string): Promise<void> {
  const select = await screen.findByRole('button', { name: `Select ${title}` });
  fireEvent.click(select);
  await waitFor(() => expect(screen.getByTestId('selected-node-id').textContent).toBe(expectedId));
}

function readTarget(): GitTargetInput {
  return JSON.parse(screen.getByTestId('git-target').textContent ?? '') as GitTargetInput;
}

function readDialogPreferences(): DiffReviewDisplayPreferences | null {
  return JSON.parse(
    screen.getByTestId('git-display-preferences').textContent ?? 'null',
  ) as DiffReviewDisplayPreferences | null;
}

function readNodeState(nodeId: string): DiffNodeState {
  const states = JSON.parse(
    screen.getByTestId('workspace-node-state').textContent ?? '[]',
  ) as DiffNodeState[];
  const state = states.find((candidate) => candidate.id === nodeId);
  if (state === undefined) throw new Error(`Expected node state for ${nodeId}.`);
  return state;
}

function readReports(): Array<{ runId: string | null; runPermissionProfile: string | null }> {
  return JSON.parse(screen.getByTestId('change-reports').textContent ?? '') as Array<{
    runId: string | null;
    runPermissionProfile: string | null;
  }>;
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Project',
    path: '/tmp/project',
    openedAt: '2026-07-15T12:00:00.000Z',
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function canvas(): CanvasDocument {
  return {
    id: '70000000-0000-4000-8000-000000000013',
    projectId: PROJECT_ID,
    name: 'Canvas',
    nodes: [
      {
        id: 'agent-node',
        type: 'agent',
        position: { x: 100, y: 100 },
        data: {
          kind: 'agent',
          title: 'Writable agent',
          description: 'Make a local change.',
          status: 'succeeded',
          locked: false,
          collapsed: false,
          color: '#d4a85b',
          permissionProfile: 'plan-read-only',
          lastRunPermissionProfile: 'worktree-write',
          runId: RUN_ID,
          changedFiles: ['src/change.ts'],
        },
      },
      diffNode('diff-source', 'Source Diff', 100),
      diffNode('diff-other', 'Other Diff', 200),
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: '2026-07-15T12:00:00.000Z',
  };
}

function diffNode(id: string, title: string, y: number): CanvasDocument['nodes'][number] {
  return {
    id,
    type: 'diff',
    position: { x: 300, y },
    data: {
      kind: 'diff',
      title,
      description: 'Review an authoritative Git target.',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#7697c5',
      reviewTarget: { kind: 'primary' },
      viewMode: 'split',
      showWhitespace: false,
    },
  };
}

function settings() {
  return AppSettingsSchema.parse({
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'worktree-write',
    worktreeRoot: '/tmp/forgeboard-worktrees',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH'],
    previewPortStart: 41_000,
    previewPortEnd: 41_999,
    transcriptRetentionDays: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
  });
}
