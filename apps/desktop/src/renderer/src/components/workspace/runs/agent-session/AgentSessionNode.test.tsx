// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  AppSettingsSchema,
  type AgentDetection,
  type AppSettings,
  type Project,
  type RunAdapterId,
} from '../../../../../../shared/application/contracts.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import type { AgentProviderGate } from '../useAgentProviderGate.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { AgentSessionProvider, type AgentSessionContextValue } from './AgentSessionContext.js';
import { AgentSessionNode } from './AgentSessionNode.js';

const controller = {
  session: null as { id: string; status: string } | null,
  sessions: [] as unknown[],
  output: [] as unknown[],
  pendingPlan: null as unknown,
  busy: null as string | null,
  error: null as string | null,
  notice: null as string | null,
  active: false,
  replayWindowLimited: false,
  chooseExecutable: vi.fn(async () => null),
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

vi.mock('../../terminal/useTerminalNodeController.js', () => ({
  useTerminalNodeController: () => controller,
}));
vi.mock('../../terminal/types.js', () => ({
  terminalOperationsFromWindow: () => ({}),
}));
vi.mock('../../terminal/TerminalSurface.js', () => ({
  TerminalSurface: () => <div data-testid="terminal-surface" />,
}));

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
  gateFor: vi.fn((_adapterId: string): AgentProviderGate | null => gate),
  recheckProvider: vi.fn(),
  openSettings: vi.fn(),
  reportError: vi.fn(),
  updateNodeData: vi.fn(),
  recordHistory: vi.fn(),
  nodeTitle: vi.fn((): string | null => null),
  removeAgentContext: vi.fn(),
  requestDeleteNode: vi.fn(),
};

function contextValue(): AgentSessionContextValue {
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
    recordHistory: spies.recordHistory,
    nodeTitle: spies.nodeTitle,
    removeAgentContext: spies.removeAgentContext,
    requestDeleteNode: spies.requestDeleteNode,
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

function renderNode(data: WorkshopNodeData = nodeData()) {
  return render(
    <AgentSessionProvider value={contextValue()}>
      <CanvasNodeInteractionProvider readOnly={false} setCollapsed={vi.fn()}>
        <AgentSessionNode id={NODE_ID} data={data} />
      </CanvasNodeInteractionProvider>
    </AgentSessionProvider>,
  );
}

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
});

describe('AgentSessionNode', () => {
  it('offers Start session on the start card and prepares a launch on click', () => {
    renderNode();
    const start = screen.getByRole('button', { name: 'Start session' });
    fireEvent.click(start);
    expect(controller.prepareLaunch).toHaveBeenCalledOnce();
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

  it('records a permission profile change', () => {
    renderNode();
    fireEvent.change(screen.getByLabelText('Permission profile'), {
      target: { value: 'plan-read-only' },
    });
    expect(spies.updateNodeData).toHaveBeenCalledWith(NODE_ID, {
      permissionProfile: 'plan-read-only',
    });
  });

  it('records a title change', () => {
    renderNode();
    fireEvent.change(screen.getByLabelText('Node title'), { target: { value: 'Hermes' } });
    expect(spies.updateNodeData).toHaveBeenCalledWith(NODE_ID, { title: 'Hermes' });
  });

  it('shows the last run output when a transcript exists', () => {
    renderNode(nodeData({ transcript: 'run log' }));
    expect(screen.getByText('Last run output')).toBeTruthy();
  });
});
