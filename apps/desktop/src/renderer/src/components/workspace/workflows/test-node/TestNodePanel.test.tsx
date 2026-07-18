// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppSettingsSchema } from '../../../../../../shared/application/contracts.js';
import type {
  WorkflowExecutionView,
  WorkflowInteractionEventEnvelope,
} from '../../../../../../shared/workflow/contracts.js';
import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { TestNodePanel } from './TestNodePanel.js';
import type { TestNodeArtifact, TestNodePanelProps } from './contracts.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const CANVAS_ID = '10000000-0000-4000-8000-000000000002';
const EXECUTION_ID = 'execution-1';
const CHECK_EXECUTION_ID = '20000000-0000-4000-8000-000000000003';
const NOW = '2026-07-17T14:00:00.000Z';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'forgeboard');
});

describe('TestNodePanel', () => {
  it('configures and launches the exact node command entirely from the panel', () => {
    const onUpdate = vi.fn();
    const onStart = vi.fn();
    renderPanel({ onUpdate, onStart });

    fireEvent.change(screen.getByLabelText(/Result files/u), {
      target: { value: 'coverage/index.html\nreports/junit.xml' },
    });
    expect(onUpdate).toHaveBeenCalledWith({
      artifactPaths: ['coverage/index.html', 'reports/junit.xml'],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review and run' }));
    expect(onStart).toHaveBeenCalledWith('test-1');
    expect(screen.getByText(/Output text is never treated as a file path/u)).toBeTruthy();
  });

  it('streams parsed output, retains attempts, and forwards trusted artifact identity', async () => {
    const artifact = trustedArtifact();
    const runningBase = execution('running', '2026-07-17T14:02:00.000Z');
    const running: WorkflowExecutionView = {
      ...runningBase,
      testResults: [testResult(artifact)],
    };
    const previous = execution('failed', '2026-07-17T13:00:00.000Z', 'execution-old');
    const onCancel = vi.fn();
    const onRevealArtifact = vi.fn().mockResolvedValue(undefined);
    const onOpenArtifact = vi.fn().mockResolvedValue(undefined);
    renderPanel({
      configurationReadOnly: true,
      executions: [running, previous],
      interactionEvents: [interaction('Tests: 4 passed, 1 failed, 2 skipped, 7 total\n')],
      onCancel,
      onRevealArtifact,
      onOpenArtifact,
    });

    expect(screen.getByRole('group', { name: 'Test command configuration' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText('Test result summary').textContent).toContain('4');
    expect(screen.getByLabelText('Test output').textContent).toContain('1 failed');
    expect(screen.getByRole('region', { name: 'Previous test attempts' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledWith({
      executionId: EXECUTION_ID,
      nodeId: 'test-1',
      attempt: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal coverage report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open coverage report' }));
    const action = {
      checkExecutionId: CHECK_EXECUTION_ID,
      executionId: EXECUTION_ID,
      nodeId: 'test-1',
      attempt: 1,
      relativePath: artifact.relativePath,
      sha256: artifact.sha256,
    };
    await waitFor(() => expect(onRevealArtifact).toHaveBeenCalledWith(action));
    expect(onOpenArtifact).toHaveBeenCalledWith(action);
  });

  it('shows honest approval and lost-process recovery states without allowing read-only relaunch', () => {
    const awaitingBase = execution('waiting-for-approval', NOW);
    const awaiting: WorkflowExecutionView = {
      ...awaitingBase,
      approvals: [
        {
          executionId: awaitingBase.id,
          nodeId: 'test-1',
          attempt: 1,
          executorId: 'process',
          preparationId: 'preparation-1',
          approvalFingerprint: 'approved-command',
          expiresAt: '2026-07-17T15:00:00.000Z',
          disclosure: {},
        },
      ],
    };
    const view = renderPanel({
      configurationReadOnly: true,
      executions: [awaiting],
    });
    expect(screen.getByText(/Nothing has started/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /run/u })).toBeNull();

    view.rerender(<TestNodePanel {...panelProps({ executions: [execution('lost', NOW)] })} />);
    expect(screen.getByRole('alert').textContent).toMatch(/lost track of the previous run/u);
  });

  it('expands a retained attempt with its complete output, summary, and verified artifacts', async () => {
    const artifact = {
      ...trustedArtifact(),
      executionId: EXECUTION_ID,
      relativePath: 'reports/previous.json',
      label: 'previous report',
    };
    const base = execution('succeeded', '2026-07-17T15:00:00.000Z');
    const retained = {
      ...testResult(artifact),
      checkExecutionId: '20000000-0000-4000-8000-000000000004',
      status: 'failed' as const,
      exitCode: 1,
      endedAt: '2026-07-17T14:30:00.000Z',
      output: 'Tests: 2 passed, 1 failed, 0 skipped, 3 total\nretained failure\n',
      summary: {
        passed: 2,
        failed: 1,
        skipped: 0,
        total: 3,
        parser: 'jest' as const,
      },
    };
    const executionWithHistory: WorkflowExecutionView = {
      ...base,
      nodeRuns: [{ ...base.nodeRuns[0]!, attempt: 2 }],
      testResults: [retained],
    };
    const onOpenArtifact = vi.fn().mockResolvedValue(undefined);
    renderPanel({ executions: [executionWithHistory], onOpenArtifact });

    fireEvent.click(screen.getByText(/Attempt 1 · Failed/u));
    expect(screen.getByText('Saved result')).toBeTruthy();
    expect(screen.getByLabelText('Test result summary').textContent).toContain('3');
    expect(screen.getByLabelText('Test output').textContent).toContain('retained failure');
    fireEvent.click(screen.getByRole('button', { name: 'Open previous report' }));
    await waitFor(() =>
      expect(onOpenArtifact).toHaveBeenCalledWith({
        checkExecutionId: retained.checkExecutionId,
        executionId: EXECUTION_ID,
        nodeId: 'test-1',
        attempt: 1,
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
      }),
    );
  });
});

function renderPanel(overrides: Partial<TestNodePanelProps> = {}) {
  return render(<TestNodePanel {...panelProps(overrides)} />);
}

function panelProps(overrides: Partial<TestNodePanelProps> = {}): TestNodePanelProps {
  return {
    projectId: PROJECT_ID,
    node: node(),
    settings: AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: '/tmp/worktrees',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      testCommand: { executable: 'pnpm', arguments: ['test'] },
      previewPortStart: 41_000,
      previewPortEnd: 41_999,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: '',
    }),
    locked: false,
    configurationReadOnly: false,
    mutationsAuthorized: true,
    executions: [],
    interactionEvents: [],
    busyAction: null,
    onRecord: vi.fn(),
    onUpdate: vi.fn(),
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onRevealArtifact: vi.fn().mockResolvedValue(undefined),
    onOpenArtifact: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    ...overrides,
  };
}

function node(): WorkshopNode {
  return {
    id: 'test-1',
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind: 'test',
      title: 'Unit tests',
      description: 'Run tests',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
      command: { executable: 'pnpm', arguments: ['test'] },
      checkKind: 'test',
      runIds: ['test'],
    },
  };
}

function execution(
  status: WorkflowExecutionView['nodeRuns'][number]['status'],
  updatedAt: string,
  id = EXECUTION_ID,
): WorkflowExecutionView {
  const active = ['queued', 'running', 'waiting-for-approval', 'paused', 'cancelling'].includes(
    status,
  );
  return {
    schemaVersion: 1,
    id,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    status,
    revision: 1,
    scope: { kind: 'node', nodeId: 'test-1', includeUpstream: false },
    planNodeIds: ['test-1'],
    nodeRuns: [
      {
        nodeId: 'test-1',
        status,
        attempt: 1,
        queuedAt: '2026-07-17T12:00:00.000Z',
        ...(status === 'queued' || status === 'waiting-for-approval'
          ? {}
          : { startedAt: '2026-07-17T12:00:01.000Z' }),
        ...(active ? {} : { endedAt: updatedAt }),
        resumable: false,
        ...(status === 'failed' ? { statusReason: 'The test command exited with code 1.' } : {}),
      },
    ],
    edges: [],
    approvals: [],
    humanDecisions: [],
    revisionEscapes: [],
    scheduling: {
      runnableNodeIds: [],
      waitingNodeIds: [],
      waitingForApprovalNodeIds: status === 'waiting-for-approval' ? ['test-1'] : [],
      blockedNodeIds: [],
      activeNodeIds: active ? ['test-1'] : [],
    },
    cancellationRequested: false,
    testResults: [],
    canvasUpdatedAt: '2026-07-17T12:00:00.000Z',
    createdAt: '2026-07-17T12:00:00.000Z',
    updatedAt,
    ...(active ? {} : { endedAt: updatedAt }),
  };
}

function interaction(text: string): WorkflowInteractionEventEnvelope {
  return {
    executionId: EXECUTION_ID,
    nodeId: 'test-1',
    attempt: 1,
    sequence: 1,
    occurredAt: NOW,
    kind: 'stream',
    channel: 'stdout',
    text,
    truncated: false,
  };
}

function testResult(artifact: TestNodeArtifact): WorkflowExecutionView['testResults'][number] {
  return {
    executionId: EXECUTION_ID,
    nodeId: 'test-1',
    attempt: 1,
    checkExecutionId: CHECK_EXECUTION_ID,
    status: 'running',
    exitCode: null,
    startedAt: '2026-07-17T14:00:00.000Z',
    endedAt: null,
    output: '',
    outputTruncated: false,
    summary: null,
    artifacts: [artifact],
  };
}

function trustedArtifact(): TestNodeArtifact {
  return {
    executionId: EXECUTION_ID,
    nodeId: 'test-1',
    attempt: 1,
    projectId: PROJECT_ID,
    relativePath: 'coverage/index.html',
    label: 'coverage report',
    kind: 'report',
    sha256: 'a'.repeat(64),
    sizeBytes: 420,
  };
}
