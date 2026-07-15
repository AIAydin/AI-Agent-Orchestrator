// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AppSettings,
  type CanvasDocument,
  type Project,
} from '../../../../../shared/application/contracts.js';
import { Workspace } from './Workspace.js';
import type { WorkspaceHandle } from '../model/types.js';

const mocks = vi.hoisted(() => ({
  flushCanvas: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../canvas/useCanvasPersistence.js', () => ({
  useCanvasPersistence: () => ({ saveState: 'saving', flushCanvas: mocks.flushCanvas }),
}));
vi.mock('./WorkspaceCommandBar.js', () => ({
  WorkspaceCommandBar: ({
    onCloseProject,
    onUndo,
  }: {
    onCloseProject: () => void;
    onUndo: () => void;
  }) => (
    <div>
      <button type="button" onClick={onCloseProject}>
        Close project
      </button>
      <button type="button" onClick={onUndo}>
        Undo canvas
      </button>
    </div>
  ),
}));
vi.mock('../canvas/WorkspaceCanvas.js', () => ({
  WorkspaceCanvas: ({
    nodes,
    onNodesChange,
    onKeyboardMove,
  }: {
    nodes: Array<{ id: string; position: { x: number; y: number } }>;
    onNodesChange: (changes: Array<{ type: 'select'; id: string; selected: boolean }>) => void;
    onKeyboardMove: (movement: { x: number; y: number }, recordUndoCheckpoint: boolean) => unknown;
  }) => (
    <div>
      <output data-testid="canvas-node-positions">
        {JSON.stringify(nodes.map(({ id, position }) => ({ id, position })))}
      </output>
      <button
        type="button"
        onClick={() =>
          onNodesChange(nodes.map((node) => ({ type: 'select', id: node.id, selected: true })))
        }
      >
        Select canvas nodes
      </button>
      <button type="button" onClick={() => onKeyboardMove({ x: 1, y: 0 }, true)}>
        Move selected right
      </button>
    </div>
  ),
}));
vi.mock('./WorkspaceRail.js', () => ({ WorkspaceRail: () => null }));
vi.mock('./WorkspaceInspector.js', () => ({ WorkspaceInspector: () => null }));
vi.mock('../activity/WorkspaceActivityDrawer.js', () => ({
  WorkspaceActivityDrawer: () => null,
}));
vi.mock('./WorkspaceOverlays.js', () => ({ WorkspaceNotifications: () => null }));
vi.mock('../../shell/CommandPalette.js', () => ({
  CommandPalette: () => <div aria-label="Command palette">Command palette open</div>,
}));
vi.mock('../../git-review/GitReviewDialog.js', () => ({ GitReviewDialog: () => null }));
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
  mocks.flushCanvas.mockReset();
  mocks.flushCanvas.mockResolvedValue(true);
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      canvas: { load: vi.fn(() => Promise.resolve({ ok: true, value: canvas() })) },
      runs: { onEvent: vi.fn(() => vi.fn()) },
    },
  });
});

afterEach(cleanup);

describe('Workspace persistence boundary', () => {
  it('exposes flushCanvas and keeps the project open when an internal close cannot save', async () => {
    const onClose = vi.fn();
    const ref = createRef<WorkspaceHandle>();
    render(
      <Workspace
        ref={ref}
        project={project()}
        settings={settings()}
        agents={[]}
        extensionDiscovery={{
          registryPath: '/tmp/extensions.json',
          installed: [],
          quarantined: [],
          invalid: [],
        }}
        onClose={onClose}
        onProjectUpdated={vi.fn()}
        onOpenSettings={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(ref.current).not.toBeNull();
    mocks.flushCanvas.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close project' }));
    await waitFor(() => expect(mocks.flushCanvas).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();

    mocks.flushCanvas.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close project' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('applies the saved VS Code command-palette shortcut in the workspace listener', () => {
    render(
      <Workspace
        project={project()}
        settings={settings({ keyboardPreset: 'vscode' })}
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

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByLabelText('Command palette')).toBeNull();
    fireEvent.keyDown(window, { key: 'P', ctrlKey: true, shiftKey: true });
    expect(screen.getByLabelText('Command palette')).toBeTruthy();
  });

  it('records keyboard movement for undo while leaving selected locked nodes in place', async () => {
    const document = canvas([
      canvasNode('open-node', 10, false),
      canvasNode('locked-node', 30, true),
    ]);
    Object.defineProperty(window, 'forgeboard', {
      configurable: true,
      value: {
        canvas: { load: vi.fn(() => Promise.resolve({ ok: true, value: document })) },
        runs: { onEvent: vi.fn(() => vi.fn()) },
      },
    });
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

    await waitFor(() =>
      expect(screen.getByTestId('canvas-node-positions').textContent).toContain('open-node'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select canvas nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move selected right' }));
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('canvas-node-positions').textContent ?? '[]')).toEqual([
        { id: 'open-node', position: { x: 11, y: 20 } },
        { id: 'locked-node', position: { x: 30, y: 20 } },
      ]),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Undo canvas' }));
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('canvas-node-positions').textContent ?? '[]')).toEqual([
        { id: 'open-node', position: { x: 10, y: 20 } },
        { id: 'locked-node', position: { x: 30, y: 20 } },
      ]),
    );
  });
});

function project(): Project {
  return {
    id: '70000000-0000-4000-8000-000000000001',
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

function canvas(nodes: CanvasDocument['nodes'] = []): CanvasDocument {
  return {
    id: '70000000-0000-4000-8000-000000000002',
    projectId: project().id,
    name: 'Canvas',
    nodes,
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: '2026-07-15T12:00:00.000Z',
  };
}

function canvasNode(id: string, x: number, locked: boolean): CanvasDocument['nodes'][number] {
  return {
    id,
    type: 'task',
    position: { x, y: 20 },
    data: {
      kind: 'task',
      title: id,
      description: id,
      status: 'idle',
      locked,
      collapsed: false,
      color: '#445566',
    },
  };
}

function settings(overrides: Partial<AppSettings> = {}) {
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
    ...overrides,
  });
}
