// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
  type CanvasDocument,
  type Project,
} from '../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { Workspace } from './Workspace.js';

const mocks = vi.hoisted(() => ({
  controllerInput: null as null | {
    selectedPermission: string;
    permissionUnavailableReason: string | null;
  },
}));

vi.mock('../canvas/useCanvasPersistence.js', () => ({
  useCanvasPersistence: () => ({
    saveState: 'saved',
    flushCanvas: vi.fn(() => Promise.resolve(true)),
  }),
}));
vi.mock('./WorkspaceCommandBar.js', () => ({ WorkspaceCommandBar: () => null }));
vi.mock('../canvas/WorkspaceCanvas.js', () => ({ WorkspaceCanvas: () => null }));
vi.mock('./WorkspaceRail.js', () => ({
  WorkspaceRail: ({
    nodes,
    onSelectNode,
  }: {
    nodes: WorkshopNode[];
    onSelectNode: (node: WorkshopNode) => void;
  }) => (
    <button type="button" disabled={nodes[0] === undefined} onClick={() => onSelectNode(nodes[0]!)}>
      Select configured agent
    </button>
  ),
}));
vi.mock('./WorkspaceInspector.js', () => ({
  WorkspaceInspector: ({ selectedPermission }: { selectedPermission: string }) => (
    <output data-testid="selected-permission">{selectedPermission}</output>
  ),
}));
vi.mock('../activity/WorkspaceActivityDrawer.js', () => ({
  WorkspaceActivityDrawer: () => null,
}));
vi.mock('./WorkspaceOverlays.js', () => ({ WorkspaceNotifications: () => null }));
vi.mock('../../shell/CommandPalette.js', () => ({ CommandPalette: () => null }));
vi.mock('../../git-review/GitReviewDialog.js', () => ({ GitReviewDialog: () => null }));
vi.mock('../runs/RunApprovalDialog.js', () => ({ RunApprovalDialog: () => null }));
vi.mock('../CheckApprovalDialog.js', () => ({ CheckApprovalDialog: () => null }));
vi.mock('../previews/useWorkspacePreviews.js', () => ({
  useWorkspacePreviews: () => ({ sessions: {}, updateSession: vi.fn() }),
}));
vi.mock('../runs/useAgentRunController.js', () => ({
  useAgentRunController: (input: {
    selectedPermission: string;
    permissionUnavailableReason: string | null;
  }) => {
    mocks.controllerInput = {
      selectedPermission: input.selectedPermission,
      permissionUnavailableReason: input.permissionUnavailableReason,
    };
    return {
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
    };
  },
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
  mocks.controllerInput = null;
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      canvas: { load: vi.fn(() => Promise.resolve({ ok: true, value: canvas() })) },
      runs: { onEvent: vi.fn(() => vi.fn()) },
    },
  });
});

afterEach(cleanup);

describe('Workspace permission selection', () => {
  it('preserves an unavailable configured profile instead of silently substituting a run mode', async () => {
    render(
      <Workspace
        project={project()}
        settings={settings()}
        agents={[testAgent]}
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

    const select = await screen.findByRole('button', { name: 'Select configured agent' });
    await waitFor(() => expect(select).toHaveProperty('disabled', false));
    fireEvent.click(select);

    await waitFor(() =>
      expect(screen.getByTestId('selected-permission').textContent).toBe('custom'),
    );
    expect(mocks.controllerInput?.selectedPermission).toBe('custom');
    expect(mocks.controllerInput?.permissionUnavailableReason).toMatch(/can't run in Docker/u);
  });
});

const testAgent: AgentDetection = {
  id: 'test-agent',
  label: 'Deterministic test agent',
  installed: true,
  executable: '/tmp/test-agent',
  version: '1.0.0',
  providerDisclosure: 'Local fixture.',
};

function project(): Project {
  return {
    id: '70000000-0000-4000-8000-000000000021',
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

function settings() {
  return AppSettingsSchema.parse({
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'worktree-write',
    customPermissionProfile: {
      runtime: 'docker',
      ignoredFileRead: 'allow',
      sensitiveFileRead: 'allow',
    },
    dockerEnabled: true,
    dockerImage: 'example/agent:latest',
    dockerContainerExecutable: '/usr/local/bin/agent',
    worktreeRoot: '/tmp/worktrees',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH'],
    previewPortStart: 41_000,
    previewPortEnd: 41_999,
    transcriptRetentionDays: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
  });
}

function canvas(): CanvasDocument {
  return {
    id: '70000000-0000-4000-8000-000000000022',
    projectId: project().id,
    name: 'Canvas',
    nodes: [
      {
        id: 'agent-node',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          kind: 'agent',
          title: 'Configured agent',
          description: 'Run with the configured policy.',
          status: 'idle',
          locked: false,
          collapsed: false,
          color: '#445566',
          adapterId: 'test-agent',
          permissionProfile: 'custom',
        },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: '2026-07-15T12:00:00.000Z',
  };
}
