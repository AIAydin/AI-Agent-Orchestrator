// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
  type Project,
  type RunAdapterId,
} from '../../../../../../shared/application/contracts.js';
import type {
  TerminalLaunchPlanView,
  TerminalSessionView,
} from '../../../../../../shared/terminal/index.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { AgentSessionProvider, type AgentSessionContextValue } from './AgentSessionContext.js';
import { AgentSessionNode } from './AgentSessionNode.js';

const controller = {
  loaded: false,
  session: null as {
    id: string;
    status: string;
    exitCode?: number | null;
    exitSignal?: string | null;
  } | null,
  sessions: [] as unknown[],
  output: [] as unknown[],
  pendingPlan: null as unknown,
  busy: null as string | null,
  error: null as string | null,
  notice: null as string | null,
  active: false,
  replayWindowLimited: false,
  chooseExecutable: vi.fn(() => Promise.resolve(null)),
  prepareLaunch: vi.fn(async () => {}),
  confirmLaunch: vi.fn(async () => {}),
  cancelLaunch: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  selectSession: vi.fn(async () => {}),
  sendInput: vi.fn(),
  resize: vi.fn(),
  interrupt: vi.fn(async () => {}),
  terminate: vi.fn(async () => {}),
};

// Captures the options (in particular `configuration`) the node last passed into the controller
// hook, so tests can assert the peer provision's extraArguments/peerProvisionId reached it.
const { controllerOptionsHolder } = vi.hoisted(() => ({
  controllerOptionsHolder: {
    current: null as {
      configuration?: unknown;
      onSessionChange?: (session: TerminalSessionView | null) => void;
    } | null,
  },
}));

vi.mock('../../terminal/useTerminalNodeController.js', () => ({
  useTerminalNodeController: (options: {
    configuration?: unknown;
    onSessionChange?: (session: TerminalSessionView | null) => void;
  }) => {
    controllerOptionsHolder.current = options;
    return controller;
  },
}));
vi.mock('../../terminal/types.js', () => ({
  terminalOperationsFromWindow: () => ({}),
}));
vi.mock('../../terminal/TerminalSurface.js', () => ({
  TerminalSurface: () => <div data-testid="terminal-surface" />,
}));

const provisionMock = vi.fn();

const claude: AgentDetection & { id: RunAdapterId } = {
  id: 'claude',
  label: 'Claude Code',
  installed: true,
  executable: '/usr/local/bin/claude',
  version: '2.1.0',
  providerDisclosure: 'runs claude',
  capabilities: {
    modelSelection: true,
    pause: false,
    resume: false,
    interactiveInput: false,
    interrupt: false,
  },
};

const settings: AppSettings = AppSettingsSchema.parse({
  theme: 'system',
  reducedMotion: false,
  density: 'comfortable',
  defaultAgent: 'claude',
  defaultPermissionProfile: 'worktree-write',
  worktreeRoot: '/tmp/worktrees',
  terminalShell: '/bin/sh',
  envAllowlist: ['PATH'],
  previewPortStart: 41_000,
  previewPortEnd: 41_999,
  transcriptRetentionDays: 30,
  collaborationEnabled: false,
  collaborationUrl: '',
});

const NODE_ID = 'node-x';

const spies = {
  openSettings: vi.fn(),
  reportError: vi.fn(),
  updateNodeData: vi.fn(),
  recordHistory: vi.fn(),
  nodeTitle: vi.fn((): string | null => null),
  removeAgentContext: vi.fn(),
  requestDeleteNode: vi.fn(),
  attachWhiteboardContext: vi.fn((): string => ''),
  fitGroupFrame: vi.fn(),
  arrangeGroupFrame: vi.fn(),
  openGitPrReadiness: vi.fn(),
  openDiffReview: vi.fn(),
};

function contextValue(overrides: Partial<AgentSessionContextValue> = {}): AgentSessionContextValue {
  return {
    project: { id: 'proj-1' } as Project,
    settings,
    runnableAgents: [claude],
    graphReadOnly: false,
    openSettings: spies.openSettings,
    reportError: spies.reportError,
    updateNodeData: spies.updateNodeData,
    fitGroupFrame: spies.fitGroupFrame,
    arrangeGroupFrame: spies.arrangeGroupFrame,
    recordHistory: spies.recordHistory,
    nodeTitle: spies.nodeTitle,
    removeAgentContext: spies.removeAgentContext,
    requestDeleteNode: spies.requestDeleteNode,
    attachWhiteboardContext: spies.attachWhiteboardContext,
    nodeRoster: [],
    checkProducers: [],
    fileTargets: [],
    openGitPrReadiness: spies.openGitPrReadiness,
    openDiffReview: spies.openDiffReview,
    ...overrides,
  };
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'agent',
    title: 'Session',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#445566',
    adapterId: 'claude',
    permissionProfile: 'worktree-write',
    ...overrides,
  };
}

function nodeTree(
  data: WorkshopNodeData,
  contextOverrides: Partial<AgentSessionContextValue> = {},
) {
  return (
    <AgentSessionProvider value={contextValue(contextOverrides)}>
      <CanvasNodeInteractionProvider readOnly={false} setCollapsed={vi.fn()}>
        <AgentSessionNode id={NODE_ID} data={data} />
      </CanvasNodeInteractionProvider>
    </AgentSessionProvider>
  );
}

function renderNode(
  data: WorkshopNodeData = nodeData(),
  contextOverrides: Partial<AgentSessionContextValue> = {},
) {
  return render(nodeTree(data, contextOverrides));
}

const REVIEW_PLAN: TerminalLaunchPlanView = {
  kind: 'terminal-launch',
  planId: 'plan-1',
  projectId: 'proj-1',
  projectName: 'Forgeboard',
  nodeId: NODE_ID,
  executable: '/usr/local/bin/claude',
  arguments: [],
  cwdRelative: '',
  environmentVariableNames: [],
  columns: 120,
  rows: 36,
  permission: {
    label: 'Local process',
    sandboxed: false,
    filesystem: 'operating-system-user',
    network: 'operating-system-user',
    detail: 'The working directory limits context but is not a security sandbox.',
  },
  workspace: { kind: 'managed-agent-worktree', adapterId: 'claude' },
  expiresAt: '2026-07-17T16:10:00.000Z',
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  controller.loaded = false;
  controller.session = null;
  controller.active = false;
  controller.pendingPlan = null;
  controller.error = null;
  controller.notice = null;
  controller.busy = null;
  controllerOptionsHolder.current = null;

  provisionMock.mockReset();
  provisionMock.mockResolvedValue({
    ok: true,
    value: {
      provisionId: 'default-provision-id',
      available: true,
      hint: null,
      extraArguments: [],
    },
  });
  (
    window as unknown as {
      forgeboard: { agentPeers: { provision: typeof provisionMock } };
    }
  ).forgeboard = {
    agentPeers: { provision: provisionMock },
  };
});

describe('AgentSessionNode', () => {
  it('launches the CLI automatically once the session list settles', async () => {
    controller.loaded = true;
    renderNode();
    // Peer provisioning happens before prepareLaunch, so the launch fires only after that
    // IPC round trip resolves — never synchronously within the render.
    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'Start session' })).toBeNull();
  });

  it('requests a managed worktree and records the durable run returned by main', () => {
    renderNode();
    expect(controllerOptionsHolder.current?.configuration).toMatchObject({
      workspace: { kind: 'managed-agent-worktree', adapterId: 'claude' },
    });

    controllerOptionsHolder.current?.onSessionChange?.({
      id: '30000000-0000-4000-8000-000000000001',
      projectId: 'proj-1',
      nodeId: NODE_ID,
      executable: 'claude',
      arguments: [],
      cwdRelative: '.',
      environmentVariableNames: [],
      columns: 80,
      rows: 24,
      permission: {
        label: 'Local terminal',
        sandboxed: false,
        filesystem: 'operating-system-user',
        network: 'operating-system-user',
        detail: 'Local terminal.',
      },
      status: 'running',
      startedAt: '2026-07-23T12:00:00.000Z',
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      earliestSequence: 1,
      nextSequence: 1,
      outputTruncated: false,
      workspace: {
        kind: 'managed-agent-worktree',
        runId: '40000000-0000-4000-8000-000000000001',
        branch: 'forgeboard/node-x/claude-1',
      },
      updatedAt: '2026-07-23T12:00:00.000Z',
    });

    expect(spies.updateNodeData).toHaveBeenCalledWith(NODE_ID, {
      runId: '40000000-0000-4000-8000-000000000001',
      branch: 'forgeboard/node-x/claude-1',
      worktreeId: undefined,
      worktreeRecordedActive: true,
      lastRunPermissionProfile: 'worktree-write',
    });
  });

  it('provisions peer tools before preparing the launch, threading the material into the configuration', async () => {
    provisionMock.mockResolvedValueOnce({
      ok: true,
      value: {
        provisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        available: true,
        hint: null,
        extraArguments: ['--mcp-config', '/tmp/peer-mcp.json'],
      },
    });
    controller.loaded = true;
    renderNode();

    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());

    expect(provisionMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      nodeId: NODE_ID,
      adapterId: 'claude',
    });
    // Provision must resolve, and the resulting configuration reach the controller, before
    // prepareLaunch fires.
    const provisionCallOrder = provisionMock.mock.invocationCallOrder[0]!;
    const prepareLaunchCallOrder = controller.prepareLaunch.mock.invocationCallOrder[0]!;
    expect(provisionCallOrder).toBeLessThan(prepareLaunchCallOrder);

    const configuration = controllerOptionsHolder.current?.configuration as {
      arguments: readonly string[];
      peerProvisionId?: string;
    };
    expect(configuration.arguments).toEqual(
      expect.arrayContaining(['--mcp-config', '/tmp/peer-mcp.json']),
    );
    expect(configuration.peerProvisionId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('still starts the session and shows a terse hint when peer tools are unavailable', async () => {
    provisionMock.mockResolvedValueOnce({
      ok: true,
      value: {
        provisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        available: false,
        hint: 'Peer tools unavailable.',
        extraArguments: [],
      },
    });
    controller.loaded = true;
    renderNode();

    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
    expect(await screen.findByText('Peer tools unavailable.')).toBeTruthy();
  });

  it('still starts the session with a fallback hint when provisioning rejects', async () => {
    provisionMock.mockRejectedValueOnce(new Error('agent-peers hub unreachable'));
    controller.loaded = true;
    renderNode();

    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
    expect(await screen.findByText('Peer tools unavailable.')).toBeTruthy();
  });

  it('provisions again on Restart after the session exits, instead of reusing the stale provision', async () => {
    provisionMock.mockResolvedValue({
      ok: true,
      value: {
        provisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        available: true,
        hint: null,
        extraArguments: [],
      },
    });
    controller.session = {
      id: 's1',
      status: 'failed',
      exitCode: 1,
      exitSignal: null,
    };
    controller.active = false;
    renderNode();

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    await waitFor(() => expect(provisionMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
  });

  it('shows a terse Starting state — no gate, settings, or Start buttons on the node', () => {
    renderNode();
    expect(screen.getByText('Starting…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start session' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh status' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull();
  });

  it('does not launch before the session list has settled', () => {
    renderNode();
    expect(provisionMock).not.toHaveBeenCalled();
    expect(controller.prepareLaunch).not.toHaveBeenCalled();
  });

  it('launches only once per mount, even across re-renders', async () => {
    controller.loaded = true;
    const view = render(nodeTree(nodeData()));
    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
    view.rerender(nodeTree(nodeData()));
    view.rerender(nodeTree(nodeData()));
    expect(controller.prepareLaunch).toHaveBeenCalledOnce();
    expect(provisionMock).toHaveBeenCalledTimes(1);
  });

  it('does not launch when the node is read-only', () => {
    controller.loaded = true;
    renderNode(nodeData({ locked: true }));
    expect(provisionMock).not.toHaveBeenCalled();
    expect(controller.prepareLaunch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Start session' })).toBeNull();
  });

  it('does not launch over a reattached live session', () => {
    controller.loaded = true;
    controller.session = { id: 's1', status: 'running' };
    controller.active = true;
    renderNode();
    expect(provisionMock).not.toHaveBeenCalled();
    expect(controller.prepareLaunch).not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-surface')).toBeTruthy();
  });

  it('relaunches over a persisted ended session on mount', async () => {
    controller.loaded = true;
    controller.session = { id: 's0', status: 'exited', exitCode: 0, exitSignal: null };
    controller.active = false;
    renderNode();
    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
  });

  it('offers Retry instead of auto-launching after a controller error', async () => {
    controller.loaded = true;
    controller.error = 'The provider CLI could not start.';
    renderNode();
    expect(controller.prepareLaunch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
  });

  it('renders the terminal surface while a session is active', () => {
    controller.session = { id: 's1', status: 'running' };
    controller.active = true;
    renderNode();
    expect(screen.getByTestId('terminal-surface')).toBeTruthy();
  });

  it('keeps the terminal surface visible after the session ends and shows the exit code', () => {
    controller.session = {
      id: 's1',
      status: 'failed',
      exitCode: 127,
      exitSignal: null,
    };
    controller.active = false;
    renderNode();
    // The final output stays readable instead of collapsing to an exit-only card.
    expect(screen.getByTestId('terminal-surface')).toBeTruthy();
    expect(screen.getByText(/Session ended · exit 127/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy();
  });

  it('records a permission profile change', () => {
    renderNode();
    fireEvent.change(screen.getByLabelText('Permission profile'), {
      target: { value: 'plan-read-only' },
    });
    expect(spies.updateNodeData).toHaveBeenCalledWith(NODE_ID, {
      permissionProfile: 'plan-read-only',
    });
  });

  it('edits the title only after double-clicking the draggable title text', () => {
    renderNode();
    const titleBar = screen.getByLabelText('Move Session agent node');
    expect(titleBar.classList.contains('agent-drag-handle')).toBe(true);
    // In display mode the title is static text with no nodrag class, so the whole bar can drag it.
    const titleText = screen.getByText('Session');
    expect(titleText.classList.contains('nodrag')).toBe(false);
    expect(screen.queryByLabelText('Node title')).toBeNull();

    fireEvent.doubleClick(titleText);
    const input = screen.getByLabelText('Node title');
    fireEvent.change(input, { target: { value: 'Hermes' } });
    // The draft commits on Enter, not on every keystroke.
    expect(spies.updateNodeData).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(spies.updateNodeData).toHaveBeenCalledWith(NODE_ID, {
      title: 'Hermes',
    });
  });

  it('auto-suffixes a rename that collides with another node on the canvas', () => {
    renderNode(nodeData(), {
      nodeRoster: [
        { id: NODE_ID, title: 'Session', kind: 'agent', locked: false },
        { id: 'node-y', title: 'Atlas', kind: 'agent', locked: false },
      ],
    });
    fireEvent.doubleClick(screen.getByText('Session'));
    const input = screen.getByLabelText('Node title');
    fireEvent.change(input, { target: { value: 'Atlas' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(spies.updateNodeData).toHaveBeenCalledWith(NODE_ID, {
      title: 'Atlas 2',
    });
  });

  it('falls back to an assigned friendly name when the rename is emptied out', () => {
    renderNode(nodeData(), {
      nodeRoster: [{ id: NODE_ID, title: 'Session', kind: 'agent', locked: false }],
    });
    fireEvent.doubleClick(screen.getByText('Session'));
    const input = screen.getByLabelText('Node title');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(spies.updateNodeData).toHaveBeenCalledWith(NODE_ID, {
      title: 'Atlas',
    });
  });

  it('cancels a title edit on Escape without committing', () => {
    renderNode();
    fireEvent.doubleClick(screen.getByText('Session'));
    const input = screen.getByLabelText('Node title');
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(spies.updateNodeData).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Node title')).toBeNull();
  });

  it('does not enter title edit mode when read-only', () => {
    renderNode(nodeData({ locked: true }));
    fireEvent.doubleClick(screen.getByText('Session'));
    expect(screen.queryByLabelText('Node title')).toBeNull();
  });

  it('shows the last run output when a transcript exists', () => {
    renderNode(nodeData({ transcript: 'run log' }));
    expect(screen.getByText('Last run output')).toBeTruthy();
  });

  it('auto-confirms a prepared launch with no in-app review dialog', async () => {
    controller.pendingPlan = REVIEW_PLAN;
    renderNode();
    // Start goes straight to the agent: the prepared plan confirms itself, no review page.
    await waitFor(() => expect(controller.confirmLaunch).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(controller.cancelLaunch).not.toHaveBeenCalled();
  });

  it("re-provisions peer tools fresh when a config-drift restart relaunches the session, instead of reusing the terminated session's stale provision", async () => {
    provisionMock.mockResolvedValueOnce({
      ok: true,
      value: {
        provisionId: 'first-provision-id',
        available: true,
        hint: null,
        extraArguments: [],
      },
    });
    controller.loaded = true;
    const view = render(nodeTree(nodeData()));

    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(
      (controllerOptionsHolder.current?.configuration as { peerProvisionId?: string } | undefined)
        ?.peerProvisionId,
    ).toBe('first-provision-id');

    // The launch auto-confirms (no in-app review dialog) and the session goes live.
    controller.pendingPlan = REVIEW_PLAN;
    view.rerender(nodeTree(nodeData()));
    await waitFor(() => expect(controller.confirmLaunch).toHaveBeenCalledOnce());

    controller.pendingPlan = null;
    controller.session = { id: 's1', status: 'running' };
    controller.active = true;
    view.rerender(nodeTree(nodeData()));

    // Config drifts (model change) while the session is live -> "Restart to apply" appears.
    view.rerender(nodeTree(nodeData({ model: 'gpt-5' })));
    fireEvent.click(screen.getByRole('button', { name: 'Restart to apply' }));
    expect(controller.terminate).toHaveBeenCalledOnce();

    // terminate() resolving is not enough to relaunch; the session must go inactive first.
    await Promise.resolve();
    await Promise.resolve();
    expect(provisionMock).toHaveBeenCalledTimes(1);

    provisionMock.mockResolvedValueOnce({
      ok: true,
      value: {
        provisionId: 'second-provision-id',
        available: true,
        hint: null,
        extraArguments: ['--mcp-config', '/tmp/peer-mcp-2.json'],
      },
    });

    // The terminated session reports inactive: the relaunch must re-provision fresh (a SECOND
    // provision() call), never reuse the first (already-consumed) provisionId.
    controller.session = { id: 's1', status: 'exited' };
    controller.active = false;
    view.rerender(nodeTree(nodeData({ model: 'gpt-5' })));

    await waitFor(() => expect(provisionMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledTimes(2));

    const relaunchConfiguration = controllerOptionsHolder.current?.configuration as {
      arguments: readonly string[];
      peerProvisionId?: string;
    };
    expect(relaunchConfiguration.peerProvisionId).toBe('second-provision-id');
    expect(relaunchConfiguration.arguments).toEqual(
      expect.arrayContaining(['--mcp-config', '/tmp/peer-mcp-2.json']),
    );
  });

  it('restarts to apply only after the live session goes inactive, not merely after terminate resolves', async () => {
    controller.pendingPlan = REVIEW_PLAN;
    const view = render(nodeTree(nodeData()));

    // The launch auto-confirms (no dialog) as soon as the plan is prepared.
    await waitFor(() => expect(controller.confirmLaunch).toHaveBeenCalledOnce());

    // A live session whose launched config has drifted surfaces the Restart-to-apply button.
    controller.pendingPlan = null;
    controller.session = { id: 's1', status: 'running' };
    controller.active = true;
    view.rerender(nodeTree(nodeData({ model: 'gpt-5' })));

    fireEvent.click(screen.getByRole('button', { name: 'Restart to apply' }));
    expect(controller.terminate).toHaveBeenCalledOnce();

    // terminate() resolving is NOT enough to relaunch: while the session is still active the real
    // prepareLaunch guard rejects a relaunch, so the node must wait for the session to go inactive.
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.prepareLaunch).not.toHaveBeenCalled();

    // Once the terminated session reports inactive on the next render, the relaunch fires.
    controller.session = { id: 's1', status: 'exited' };
    controller.active = false;
    view.rerender(nodeTree(nodeData({ model: 'gpt-5' })));
    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
  });

  it('keeps provider and model configuration out of the compact terminal footer', () => {
    renderNode();
    expect(screen.queryByLabelText('Agent')).toBeNull();
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.getByLabelText('Permission profile')).toBeTruthy();
  });

  it('disables permission profile options that require Docker when Docker is off', () => {
    const dockerDisabledSettings: AppSettings = AppSettingsSchema.parse({
      ...settings,
      dockerEnabled: false,
    });
    renderNode(nodeData(), { settings: dockerDisabledSettings });

    const permissionSelect = screen.getByLabelText('Permission profile');
    const dockerOption = permissionSelect.querySelector('option[value="docker-isolated"]');
    const worktreeOption = permissionSelect.querySelector('option[value="worktree-write"]');
    expect(dockerOption?.hasAttribute('disabled')).toBe(true);
    expect(worktreeOption?.hasAttribute('disabled')).toBe(false);
  });
});
