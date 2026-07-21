// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
} from '../../../../../../shared/application/contracts.js';
import type { AgentProviderGate } from '../useAgentProviderGate.js';
import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { AgentNodePanel } from './AgentNodePanel.js';

vi.mock('./AgentAttemptHistory.js', () => ({
  AgentAttemptHistory: () => null,
}));

afterEach(cleanup);

const settings = AppSettingsSchema.parse({
  theme: 'system',
  reducedMotion: false,
  density: 'comfortable',
  defaultAgent: 'codex',
  defaultPermissionProfile: 'worktree-write',
  worktreeRoot: '/tmp/worktrees',
  branchPrefix: 'forgeboard/',
  gitRemote: 'origin',
  terminalShell: '/bin/sh',
  envAllowlist: [],
  developmentCommand: { executable: '', arguments: [] },
  lintCommand: { executable: '', arguments: [] },
  testCommand: { executable: '', arguments: [] },
  dockerEnabled: false,
  dockerImage: '',
  dockerContainerExecutable: '',
  previewPortStart: 41_000,
  previewPortEnd: 41_999,
  transcriptRetentionDays: 30,
  collaborationEnabled: false,
  collaborationUrl: '',
});

const codex: AgentDetection & { id: 'codex' } = {
  id: 'codex',
  label: 'Codex',
  installed: true,
  executable: '/usr/local/bin/codex',
  version: '1.0.0',
  providerDisclosure: 'Provider-controlled network.',
  capabilities: {
    interactiveInput: true,
    interrupt: true,
    pause: false,
    resume: true,
    modelSelection: true,
  },
  capabilitySource: 'manifest',
};

const testAgent: AgentDetection & { id: 'test-agent' } = {
  ...codex,
  id: 'test-agent',
  label: 'Test agent',
  capabilities: { ...codex.capabilities!, modelSelection: false },
};

describe('AgentNodePanel configuration and usage', () => {
  it('records an undo checkpoint before every Agent-specific configuration field edit', () => {
    const onRecord = vi.fn();
    const onUpdateSelected = vi.fn();
    renderPanel(agentNode(), { onRecord, onUpdateSelected });

    const adapter = screen.getByRole('combobox', { name: 'Agent to run' });
    fireEvent.focus(adapter);
    fireEvent.change(adapter, { target: { value: 'test-agent' } });

    const model = screen.getByRole('textbox', { name: 'Model (optional)' });
    fireEvent.focus(model);
    fireEvent.change(model, { target: { value: 'gpt-5.2' } });

    const permission = screen.getByRole('combobox', {
      name: 'Permission profile',
    });
    fireEvent.focus(permission);
    fireEvent.change(permission, { target: { value: 'plan-read-only' } });

    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    fireEvent.focus(prompt);
    fireEvent.change(prompt, { target: { value: 'Implement the feature.' } });

    expect(onRecord).toHaveBeenCalledTimes(4);
    expect(onUpdateSelected).toHaveBeenCalledWith({
      adapterId: 'test-agent',
      model: undefined,
    });
    expect(onUpdateSelected).toHaveBeenCalledWith({ model: 'gpt-5.2' });
    expect(onUpdateSelected).toHaveBeenCalledWith({
      permissionProfile: 'plan-read-only',
    });
    expect(onUpdateSelected).toHaveBeenCalledWith({
      prompt: 'Implement the feature.',
    });
  });

  it('displays every token category exactly when the provider reports it', () => {
    renderPanel(
      agentNode({
        tokenUsage: {
          inputTokens: 1_200,
          cachedInputTokens: 800,
          outputTokens: 300,
          totalTokens: 1_500,
        },
      }),
    );

    expect(metric('Input tokens')).toBe('1,200');
    expect(metric('Cached input tokens')).toBe('800');
    expect(metric('Output tokens')).toBe('300');
    expect(metric('Total tokens')).toBe('1,500');
  });

  it('offers only real input/interrupt controls and explains pause versus reviewed resume', () => {
    const onSendRunInput = vi.fn();
    renderPanel(
      agentNode({
        status: 'running',
        interactiveInputSupported: true,
        interruptSupported: true,
        pauseSupported: false,
      }),
      { running: true, onSendRunInput },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send continue input' }));
    expect(onSendRunInput).toHaveBeenCalledWith('continue');
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Pause or continue Agent process',
      }).disabled,
    ).toBe(true);
    const pauseStatus = screen.getByRole('group', {
      name: 'Pause or continue Agent process unavailable',
    });
    const pauseTooltip = screen.getByRole('tooltip', {
      name: 'Pause is unavailable on this operating system or runtime.',
    });
    expect(pauseStatus.getAttribute('aria-describedby')).toBe(pauseTooltip.id);
    expect(screen.getByText(/unsupported platforms and Docker remain unavailable/iu)).toBeTruthy();
    expect(screen.getByText(/always launches a freshly reviewed continuation/iu)).toBeTruthy();
  });

  it('offers distinct same-process pause and continue controls only for a capable live session', () => {
    const onControlRun = vi.fn();
    const view = renderPanel(
      agentNode({
        status: 'running',
        interactiveInputSupported: true,
        interruptSupported: true,
        pauseSupported: true,
      }),
      { running: true, onControlRun },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pause or continue Agent process' }));
    expect(onControlRun).toHaveBeenCalledWith('pause');

    view.rerender(
      <AgentNodePanel
        {...panelProps(
          agentNode({
            status: 'paused',
            interactiveInputSupported: true,
            interruptSupported: true,
            pauseSupported: true,
          }),
          { running: true, onControlRun },
        )}
      />,
    );
    const input = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Message to the running agent',
    });
    expect(input.disabled).toBe(true);
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Continue this Agent run before sending input.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause or continue Agent process' }));
    expect(onControlRun).toHaveBeenCalledWith('continue');
  });
});

describe('AgentNodePanel provider connection run gate', () => {
  it('blocks the start control with a visible reason while the provider is disconnected', () => {
    const onRecheckProvider = vi.fn();
    const onOpenSettings = vi.fn();
    const onPrepareRun = vi.fn();
    renderPanel(agentNode({ adapterId: 'claude' }), {
      providerGate: disconnectedGate(),
      onRecheckProvider,
      onOpenSettings,
      onPrepareRun,
    });

    const runButton = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Review and run Agent',
    });
    expect(runButton.disabled).toBe(true);
    const tooltip = screen.getByRole('tooltip', {
      name: "Claude Code isn't connected. Connect it in Settings → Agents & runtime.",
    });
    expect(runButton.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(screen.getByRole('status').textContent).toContain(
      "Claude Code isn't connected. Connect it in Settings → Agents & runtime.",
    );

    fireEvent.click(runButton);
    expect(onPrepareRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRecheckProvider).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('asks for a status refresh when the connection state needs one and relabels while busy', () => {
    const unknownGate = disconnectedGate({
      state: 'unknown',
      blockedReason: "Claude Code's connection status needs a refresh. Refresh it, then try again.",
      warning: "Claude Code's connection status needs a refresh before this agent can run.",
      actionLabel: 'Refresh status',
      busyActionLabel: 'Refreshing status…',
    });
    const view = renderPanel(agentNode({ adapterId: 'claude' }), { providerGate: unknownGate });

    expect(screen.getByRole('status').textContent).toContain('needs a refresh');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Review and run Agent' }).disabled,
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Refresh status' })).toBeTruthy();

    view.rerender(
      <AgentNodePanel
        {...panelProps(agentNode({ adapterId: 'claude' }), {
          providerGate: { ...unknownGate, busy: true },
        })}
      />,
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Refreshing status…' }).disabled,
    ).toBe(true);
  });

  it('unblocks the run without reopening settings after a successful re-check', () => {
    const view = renderPanel(agentNode({ adapterId: 'claude' }), {
      providerGate: disconnectedGate(),
    });
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Review and run Agent' }).disabled,
    ).toBe(true);

    view.rerender(
      <AgentNodePanel
        {...panelProps(agentNode({ adapterId: 'claude' }), {
          providerGate: disconnectedGate({
            state: 'connected',
            blockedReason: null,
            warning: null,
          }),
        })}
      />,
    );

    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Review and run Agent' }).disabled,
    ).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('never gates agents without a provider connection', () => {
    const onPrepareRun = vi.fn();
    renderPanel(agentNode({ adapterId: 'test-agent' }), { onPrepareRun });

    const runButton = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Review and run Agent',
    });
    expect(runButton.disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(runButton);
    expect(onPrepareRun).toHaveBeenCalledTimes(1);
  });
});

interface PanelOverrides {
  readonly onRecord?: () => void;
  readonly onUpdateSelected?: () => void;
  readonly onSendRunInput?: (explicitInput?: string) => void;
  readonly onControlRun?: (action: 'pause' | 'continue' | 'interrupt' | 'terminate') => void;
  readonly running?: boolean;
  readonly providerGate?: AgentProviderGate | null;
  readonly onRecheckProvider?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onPrepareRun?: () => void;
}

function renderPanel(selectedNode: WorkshopNode, overrides: PanelOverrides = {}) {
  return render(<AgentNodePanel {...panelProps(selectedNode, overrides)} />);
}

function panelProps(selectedNode: WorkshopNode, overrides: PanelOverrides = {}) {
  return {
    projectId: '95000000-0000-4000-8000-000000000001',
    selectedNode,
    selectedAdapter: 'codex' as const,
    selectedPermission: 'worktree-write' as const,
    runnableAgents: [codex, testAgent],
    settings,
    runInput: '',
    running: overrides.running ?? false,
    preparingRun: false,
    configurationReadOnly: false,
    onRecord: overrides.onRecord ?? vi.fn(),
    onUpdateSelected: overrides.onUpdateSelected ?? vi.fn(),
    onRunInputChange: vi.fn(),
    onSendRunInput: overrides.onSendRunInput ?? vi.fn(),
    onControlRun: overrides.onControlRun ?? vi.fn(),
    onPrepareRun: overrides.onPrepareRun ?? vi.fn(),
    ...(overrides.providerGate === undefined ? {} : { providerGate: overrides.providerGate }),
    ...(overrides.onRecheckProvider === undefined
      ? {}
      : { onRecheckProvider: overrides.onRecheckProvider }),
    ...(overrides.onOpenSettings === undefined ? {} : { onOpenSettings: overrides.onOpenSettings }),
  };
}

function disconnectedGate(overrides: Partial<AgentProviderGate> = {}): AgentProviderGate {
  return {
    providerId: 'claude',
    productName: 'Claude Code',
    state: 'disconnected',
    settled: true,
    busy: false,
    blockedReason: "Claude Code isn't connected. Connect it in Settings → Agents & runtime.",
    warning: "Claude Code isn't connected. Connect it in Settings → Agents & runtime.",
    actionLabel: 'Check again',
    busyActionLabel: 'Checking again…',
    ...overrides,
  };
}

function agentNode(data: Partial<WorkshopNode['data']> = {}): WorkshopNode {
  return {
    id: 'agent-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'agent',
      title: 'Agent',
      description: '',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      adapterId: 'codex',
      model: 'gpt-5.1',
      permissionProfile: 'worktree-write',
      prompt: 'Initial prompt',
      ...data,
    },
  };
}

function metric(label: string): string | null {
  return (
    screen.getByText(label, { selector: 'dt' }).parentElement?.querySelector('dd')?.textContent ??
    null
  );
}
