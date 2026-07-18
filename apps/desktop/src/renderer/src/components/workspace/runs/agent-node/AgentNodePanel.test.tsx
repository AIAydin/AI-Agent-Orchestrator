// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AgentDetection,
} from '../../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { AgentNodePanel } from './AgentNodePanel.js';

vi.mock('./AgentAttemptHistory.js', () => ({ AgentAttemptHistory: () => null }));

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

    const permission = screen.getByRole('combobox', { name: 'Permission profile' });
    fireEvent.focus(permission);
    fireEvent.change(permission, { target: { value: 'plan-read-only' } });

    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    fireEvent.focus(prompt);
    fireEvent.change(prompt, { target: { value: 'Implement the feature.' } });

    expect(onRecord).toHaveBeenCalledTimes(4);
    expect(onUpdateSelected).toHaveBeenCalledWith({ adapterId: 'test-agent', model: undefined });
    expect(onUpdateSelected).toHaveBeenCalledWith({ model: 'gpt-5.2' });
    expect(onUpdateSelected).toHaveBeenCalledWith({ permissionProfile: 'plan-read-only' });
    expect(onUpdateSelected).toHaveBeenCalledWith({ prompt: 'Implement the feature.' });
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

    fireEvent.click(screen.getByRole('button', { name: 'Send “continue”' }));
    expect(onSendRunInput).toHaveBeenCalledWith('continue');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Pause unavailable' }).disabled,
    ).toBe(true);
    expect(screen.getByText(/cannot pause an Agent process/iu)).toBeTruthy();
    expect(screen.getByText(/always launches a freshly reviewed continuation/iu)).toBeTruthy();
  });
});

function renderPanel(
  selectedNode: WorkshopNode,
  overrides: {
    readonly onRecord?: () => void;
    readonly onUpdateSelected?: () => void;
    readonly onSendRunInput?: (explicitInput?: string) => void;
    readonly running?: boolean;
  } = {},
) {
  return render(
    <AgentNodePanel
      projectId="95000000-0000-4000-8000-000000000001"
      selectedNode={selectedNode}
      selectedAdapter="codex"
      selectedPermission="worktree-write"
      runnableAgents={[codex, testAgent]}
      settings={settings}
      runInput=""
      running={overrides.running ?? false}
      preparingRun={false}
      configurationReadOnly={false}
      onRecord={overrides.onRecord ?? vi.fn()}
      onUpdateSelected={overrides.onUpdateSelected ?? vi.fn()}
      onRunInputChange={vi.fn()}
      onSendRunInput={overrides.onSendRunInput ?? vi.fn()}
      onControlRun={vi.fn()}
      onPrepareRun={vi.fn()}
    />,
  );
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
