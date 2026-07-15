// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppSettingsSchema, type CanvasDocument, type Project } from '../../../shared/contracts.js';
import { Workspace } from './Workspace.js';
import type { WorkspaceHandle } from './workspace/types.js';

const mocks = vi.hoisted(() => ({
  flushCanvas: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('./workspace/useCanvasPersistence.js', () => ({
  useCanvasPersistence: () => ({ saveState: 'saving', flushCanvas: mocks.flushCanvas }),
}));
vi.mock('./workspace/WorkspaceCommandBar.js', () => ({
  WorkspaceCommandBar: ({ onCloseProject }: { onCloseProject: () => void }) => (
    <button type="button" onClick={onCloseProject}>
      Close project
    </button>
  ),
}));
vi.mock('./workspace/WorkspaceCanvas.js', () => ({ WorkspaceCanvas: () => null }));
vi.mock('./workspace/WorkspaceRail.js', () => ({ WorkspaceRail: () => null }));
vi.mock('./workspace/WorkspaceInspector.js', () => ({ WorkspaceInspector: () => null }));
vi.mock('./workspace/WorkspaceActivityDrawer.js', () => ({
  WorkspaceActivityDrawer: () => null,
}));
vi.mock('./workspace/WorkspaceOverlays.js', () => ({ WorkspaceNotifications: () => null }));
vi.mock('./CommandPalette.js', () => ({ CommandPalette: () => null }));
vi.mock('./git-review/GitReviewDialog.js', () => ({ GitReviewDialog: () => null }));
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

function canvas(): CanvasDocument {
  return {
    id: '70000000-0000-4000-8000-000000000002',
    projectId: project().id,
    name: 'Canvas',
    nodes: [],
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
