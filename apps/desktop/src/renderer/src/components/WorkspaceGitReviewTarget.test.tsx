// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppSettingsSchema, type CanvasDocument, type Project } from '../../../shared/contracts.js';
import type { GitTargetInput } from '../../../shared/git-contracts.js';
import { Workspace } from './Workspace.js';

vi.mock('./workspace/useCanvasPersistence.js', () => ({
  useCanvasPersistence: () => ({
    saveState: 'saved',
    flushCanvas: vi.fn(() => Promise.resolve(true)),
  }),
}));
vi.mock('./workspace/WorkspaceCommandBar.js', () => ({
  WorkspaceCommandBar: ({ onOpenGitReview }: { onOpenGitReview: () => void }) => (
    <button type="button" onClick={onOpenGitReview}>
      Topbar Git review
    </button>
  ),
}));
vi.mock('./workspace/WorkspaceCanvas.js', () => ({ WorkspaceCanvas: () => null }));
vi.mock('./workspace/WorkspaceRail.js', () => ({ WorkspaceRail: () => null }));
vi.mock('./workspace/WorkspaceInspector.js', () => ({ WorkspaceInspector: () => null }));
vi.mock('./workspace/WorkspaceActivityDrawer.js', () => ({
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
vi.mock('./workspace/WorkspaceOverlays.js', () => ({ WorkspaceNotifications: () => null }));
vi.mock('./CommandPalette.js', () => ({
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
vi.mock('./git-review/GitReviewDialog.js', () => ({
  GitReviewDialog: ({ target, onClose }: { target: GitTargetInput; onClose: () => void }) => (
    <div role="dialog" aria-label="Git review target">
      <output data-testid="git-target">{JSON.stringify(target)}</output>
      <button type="button" onClick={onClose}>
        Close Git review
      </button>
    </div>
  ),
}));
vi.mock('./workspace/RunApprovalDialog.js', () => ({ RunApprovalDialog: () => null }));
vi.mock('./workspace/CheckApprovalDialog.js', () => ({ CheckApprovalDialog: () => null }));
vi.mock('./workspace/useWorkspacePreviews.js', () => ({
  useWorkspacePreviews: () => ({ sessions: {}, updateSession: vi.fn() }),
}));
vi.mock('./workspace/useAgentRunController.js', () => ({
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
vi.mock('./workspace/useProjectChecks.js', () => ({
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

beforeEach(() => {
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      canvas: { load: vi.fn(() => Promise.resolve({ ok: true, value: canvas() })) },
      runs: { onEvent: vi.fn(() => vi.fn()) },
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
});

const PROJECT_ID = '70000000-0000-4000-8000-000000000011';
const RUN_ID = '70000000-0000-4000-8000-000000000012';

function readTarget(): GitTargetInput {
  return JSON.parse(screen.getByTestId('git-target').textContent ?? '') as GitTargetInput;
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
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: '2026-07-15T12:00:00.000Z',
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
