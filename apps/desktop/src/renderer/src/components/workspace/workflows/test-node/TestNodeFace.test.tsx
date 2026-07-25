// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkflowExecutionView } from '../../../../../../shared/workflow/contracts.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import {
  WorkflowRuntimeProvider,
  type WorkflowRuntimeContextValue,
} from '../WorkflowRuntimeContext.js';
import { TestNodeFace } from './TestNodeFace.js';

const startNode = vi.fn();
const cancelNode = vi.fn();
const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  startNode.mockClear();
  cancelNode.mockClear();
  updateNodeData.mockClear();
  recordHistory.mockClear();
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    reportError: vi.fn(),
  } as unknown as AgentSessionContextValue;
}

function runtimeValue(
  executions: readonly WorkflowExecutionView[] = [],
  overrides: Partial<WorkflowRuntimeContextValue> = {},
): WorkflowRuntimeContextValue {
  return {
    executions,
    interactionEvents: [],
    busyAction: null,
    mutationsAuthorized: true,
    reviewGateFor: () => null,
    pendingDecisionFor: () => null,
    requestDecision: vi.fn(),
    startNode,
    cancelNode,
    ...overrides,
  } as WorkflowRuntimeContextValue;
}

function execution(overrides: Record<string, unknown> = {}): WorkflowExecutionView {
  return {
    id: 'x1',
    updatedAt: '2026-07-20T10:00:00.000Z',
    nodeRuns: [{ nodeId: 'n1', attempt: 1, status: 'running' }],
    testResults: [],
    approvals: [],
    humanDecisions: [],
    revisionEscapes: [],
    ...overrides,
  } as unknown as WorkflowExecutionView;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'test',
    title: 'Unit tests',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#64a774',
    command: { executable: 'pnpm', arguments: ['test'] },
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(
  overrides: Partial<WorkshopNodeData> = {},
  runtime: WorkflowRuntimeContextValue = runtimeValue(),
) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <WorkflowRuntimeProvider value={runtime}>
          <TestNodeFace id="n1" data={nodeData(overrides)} />
        </WorkflowRuntimeProvider>
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('TestNodeFace', () => {
  it('shows the command line and starts a run', () => {
    renderFace();
    expect(screen.getByRole('textbox', { name: 'Command' })).toHaveProperty('value', 'pnpm test');
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(startNode).toHaveBeenCalledWith('n1');
  });

  it('edits the command from the single input, keeping quoted arguments together', () => {
    renderFace();
    const input = screen.getByRole('textbox', { name: 'Command' });
    fireEvent.focus(input);
    expect(recordHistory).toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'vitest run --grep "auth flow"' } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      command: {
        executable: 'vitest',
        arguments: ['run', '--grep', 'auth flow'],
        environmentNames: [],
      },
    });
  });

  it('edits the description in place', () => {
    renderFace({ description: 'Old' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Runs the unit suite' },
    });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { description: 'Runs the unit suite' });
  });

  it('offers Cancel while an attempt is active', () => {
    renderFace({}, runtimeValue([execution()]));
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Running');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelNode).toHaveBeenCalledWith({ executionId: 'x1', nodeId: 'n1', attempt: 1 });
  });

  it('blocks starting without a configured command or authorization', () => {
    renderFace({ command: { executable: '', arguments: [] } });
    expect(screen.getByRole('button', { name: 'Run' })).toHaveProperty('disabled', true);
    cleanup();
    renderFace({}, runtimeValue([], { mutationsAuthorized: false }));
    expect(screen.getByRole('button', { name: 'Run' })).toHaveProperty('disabled', true);
  });

  it('previews the latest output', () => {
    const runtime = runtimeValue([
      execution({
        nodeRuns: [{ nodeId: 'n1', attempt: 2, status: 'failed', statusReason: 'Exited with 1' }],
        testResults: [
          {
            nodeId: 'n1',
            attempt: 2,
            checkExecutionId: 'chk-2',
            status: 'failed',
            output: 'FAIL current output',
            outputTruncated: false,
            summary: null,
            startedAt: '2026-07-20T09:00:00.000Z',
            endedAt: '2026-07-20T09:01:00.000Z',
            artifacts: [],
          },
        ],
      }),
    ]);
    renderFace({}, runtime);
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Failed');
    expect(screen.getByLabelText('Test output')).toHaveProperty(
      'textContent',
      'FAIL current output',
    );
    expect(screen.getByText('Exited with 1')).toBeTruthy();
  });

  it('ignores legacy configure-step data without rendering it', () => {
    renderFace({
      checkKind: 'custom',
      runIds: ['00000000-0000-4000-8000-000000000000'],
      artifactPaths: ['coverage/index.html'],
      command: {
        executable: 'pnpm',
        arguments: ['test'],
        cwdRelative: 'packages/app',
        environmentNames: ['CI'],
      },
    });
    expect(screen.queryByText('Configure')).toBeNull();
    expect(screen.queryByLabelText('Program')).toBeNull();
    expect(screen.queryByLabelText('Result files to keep')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Command' })).toHaveProperty('value', 'pnpm test');
  });
});
