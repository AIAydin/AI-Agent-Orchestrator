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
import type { TerminalLaunchPlanView } from '../../../../../../shared/terminal/index.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import type { AgentProviderGate } from '../useAgentProviderGate.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { AgentSessionProvider, type AgentSessionContextValue } from './AgentSessionContext.js';
import { AgentSessionNode } from './AgentSessionNode.js';

const controller = {
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
  controllerOptionsHolder: { current: null as { configuration?: unknown } | null },
}));

vi.mock('../../terminal/useTerminalNodeController.js', () => ({
  useTerminalNodeController: (options: { configuration?: unknown }) => {
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

let gate: AgentProviderGate | null = null;
const spies = {
  gateFor: vi.fn((): AgentProviderGate | null => gate),
  recheckProvider: vi.fn(),
  openSettings: vi.fn(),
  reportError: vi.fn(),
  updateNodeData: vi.fn(),
  recordHistory: vi.fn(),
  nodeTitle: vi.fn((): string | null => null),
  removeAgentContext: vi.fn(),
  requestDeleteNode: vi.fn(),
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
    gateFor: spies.gateFor,
    recheckProvider: spies.recheckProvider,
    openSettings: spies.openSettings,
    reportError: spies.reportError,
    updateNodeData: spies.updateNodeData,
    fitGroupFrame: spies.fitGroupFrame,
    arrangeGroupFrame: spies.arrangeGroupFrame,
    recordHistory: spies.recordHistory,
    nodeTitle: spies.nodeTitle,
    removeAgentContext: spies.removeAgentContext,
    requestDeleteNode: spies.requestDeleteNode,
    nodeRoster: [],
    checkProducers: [],
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

function nodeTree(data: WorkshopNodeData, contextOverrides: Partial<AgentSessionContextValue> = {}) {
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
  expiresAt: '2026-07-17T16:10:00.000Z',
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  gate = null;
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
    window as unknown as { forgeboard: { agentPeers: { provision: typeof provisionMock } } }
  ).forgeboard = {
    agentPeers: { provision: provisionMock },
  };
});

describe('AgentSessionNode', () => {
  it('offers Start session on the start card and prepares a launch on click', async () => {
    renderNode();
    const start = screen.getByRole('button', { name: 'Start session' });
    fireEvent.click(start);
    // Peer provisioning now happens before prepareLaunch, so the launch fires only after that
    // IPC round trip resolves — no longer synchronously within the click handler.
    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
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
    renderNode();
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

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
    renderNode();
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
    expect(await screen.findByText('Peer tools unavailable.')).toBeTruthy();
  });

  it('still starts the session with a fallback hint when provisioning rejects', async () => {
    provisionMock.mockRejectedValueOnce(new Error('agent-peers hub unreachable'));
    renderNode();
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

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
    controller.session = { id: 's1', status: 'failed', exitCode: 1, exitSignal: null };
    controller.active = false;
    renderNode();

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    await waitFor(() => expect(provisionMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
  });

  it('hides Start behind a provider gate warning and rechecks the provider', () => {
    gate = {
      providerId: 'anthropic' as never,
      productName: 'Claude',
      state: 'unknown',
      settled: true,
      busy: false,
      blockedReason: 'needs a refresh',
      warning: 'needs a refresh',
      actionLabel: 'Refresh status',
      busyActionLabel: 'Refreshing…',
    };
    renderNode();
    expect(screen.queryByRole('button', { name: 'Start session' })).toBeNull();
    expect(screen.getByText('needs a refresh')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    expect(spies.recheckProvider).toHaveBeenCalledWith('claude');
  });

  it('renders the terminal surface while a session is active', () => {
    controller.session = { id: 's1', status: 'running' };
    controller.active = true;
    renderNode();
    expect(screen.getByTestId('terminal-surface')).toBeTruthy();
  });

  it('keeps the terminal surface visible after the session ends and shows the exit code', () => {
    controller.session = { id: 's1', status: 'failed', exitCode: 127, exitSignal: null };
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
    expect(spies.updateNodeData).toHaveBeenCalledWith(NODE_ID, { title: 'Hermes' });
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

  it('re-provisions peer tools fresh when a config-drift restart relaunches the session, instead of reusing the terminated session\'s stale provision', async () => {
    provisionMock.mockResolvedValueOnce({
      ok: true,
      value: {
        provisionId: 'first-provision-id',
        available: true,
        hint: null,
        extraArguments: [],
      },
    });
    const view = render(nodeTree(nodeData()));

    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
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

  it('renders the Model input only when the agent supports model selection', () => {
    renderNode();
    expect(screen.getByLabelText('Model')).toBeTruthy();
    cleanup();

    const claudeNoModelSelection: AgentDetection & { id: RunAdapterId } = {
      ...claude,
      capabilities: { ...claude.capabilities!, modelSelection: false },
    };
    render(nodeTree(nodeData(), { runnableAgents: [claudeNoModelSelection] }));
    expect(screen.queryByLabelText('Model')).toBeNull();
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
