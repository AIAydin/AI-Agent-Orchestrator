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
const revealArtifact = vi.fn(() => Promise.resolve(undefined));
const openArtifact = vi.fn(() => Promise.resolve(undefined));

afterEach(cleanup);
beforeEach(() => {
  startNode.mockClear();
  cancelNode.mockClear();
  revealArtifact.mockClear();
  openArtifact.mockClear();
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData: vi.fn(),
    recordHistory: vi.fn(),
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
    revealArtifact,
    openArtifact,
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
  it('shows the command summary and starts a run', () => {
    renderFace();
    expect(screen.getByText('pnpm test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review and run' }));
    expect(startNode).toHaveBeenCalledWith('n1');
  });

  it('offers Cancel while an attempt is active', () => {
    renderFace({}, runtimeValue([execution()]));
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Running');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelNode).toHaveBeenCalledWith({ executionId: 'x1', nodeId: 'n1', attempt: 1 });
  });

  it('shows the latest attempt summary and artifact actions', () => {
    const runtime = runtimeValue([
      execution({
        nodeRuns: [{ nodeId: 'n1', attempt: 1, status: 'succeeded' }],
        testResults: [
          {
            nodeId: 'n1',
            attempt: 1,
            checkExecutionId: 'chk-1',
            status: 'passed',
            output: 'Tests: 12 passed, 12 total',
            outputTruncated: false,
            summary: { parser: 'jest', passed: 12, failed: 0, skipped: 0, total: 12 },
            startedAt: '2026-07-20T09:00:00.000Z',
            endedAt: '2026-07-20T09:01:00.000Z',
            artifacts: [
              {
                executionId: 'x1',
                nodeId: 'n1',
                attempt: 1,
                projectId: 'p1',
                relativePath: 'coverage/index.html',
                sha256: 'abc',
                label: 'report',
              },
            ],
          },
        ],
      }),
    ]);
    renderFace({}, runtime);
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Passed');
    expect(screen.getByText('12 passed · 0 failed · 12 total')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal report' }));
    expect(revealArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'coverage/index.html', checkExecutionId: 'chk-1' }),
    );
  });

  it('blocks starting without a configured command or authorization', () => {
    renderFace({ command: { executable: '', arguments: [] } });
    expect(screen.getByRole('button', { name: 'Review and run' })).toHaveProperty('disabled', true);
    cleanup();
    renderFace({}, runtimeValue([], { mutationsAuthorized: false }));
    expect(screen.getByRole('button', { name: 'Review and run' })).toHaveProperty('disabled', true);
  });
});
