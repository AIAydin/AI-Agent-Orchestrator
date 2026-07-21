// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkflowReviewGateView } from '../../../../../../shared/workflow/contracts.js';
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
import { ReviewGateNodeFace } from './ReviewGateNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
const requestDecision = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  requestDecision.mockClear();
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    nodeRoster: [],
    checkProducers: [
      { nodeId: 't1', producerId: 'test', title: 'Unit tests', checkKind: 'test' },
      { nodeId: 't2', producerId: 'lint', title: 'Lint', checkKind: 'lint' },
    ],
  } as unknown as AgentSessionContextValue;
}

function runtimeValue(overrides: Partial<WorkflowRuntimeContextValue> = {}): WorkflowRuntimeContextValue {
  return {
    executions: [],
    interactionEvents: [],
    busyAction: null,
    mutationsAuthorized: true,
    reviewGateFor: () => null,
    pendingDecisionFor: () => null,
    requestDecision,
    startNode: vi.fn(),
    cancelNode: vi.fn(),
    revealArtifact: vi.fn(),
    openArtifact: vi.fn(),
    ...overrides,
  } as WorkflowRuntimeContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'review-gate',
    title: 'Quality gate',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#64a774',
    humanApprovalRequired: true,
    requiredCheckIds: [],
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(
  overrides: Partial<WorkshopNodeData> = {},
  runtime: Partial<WorkflowRuntimeContextValue> = {},
) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <WorkflowRuntimeProvider value={runtimeValue(runtime)}>
          <ReviewGateNodeFace id="g1" data={nodeData(overrides)} />
        </WorkflowRuntimeProvider>
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('ReviewGateNodeFace', () => {
  it('shows the authoritative gate state when the workflow has evaluated it', () => {
    renderFace(
      {},
      {
        reviewGateFor: () =>
          ({
            nodeId: 'g1',
            status: 'waiting-human',
            reasons: ['Waiting for your approval.'],
          }) as unknown as WorkflowReviewGateView,
      },
    );
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Waiting for you');
    expect(screen.getByText('Waiting for your approval.')).toBeTruthy();
  });

  it('falls back to the saved gate state without an evaluation', () => {
    renderFace({ gateState: 'passed' });
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Passed');
  });

  it('toggles required checks in place', () => {
    renderFace();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Require Unit tests' }));
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('g1', { requiredCheckIds: ['test'] });
  });

  it('surfaces the pending decision as an approval action', () => {
    const target = { kind: 'human' as const, request: { nodeId: 'g1' } };
    renderFace({}, { pendingDecisionFor: () => target as never });
    fireEvent.click(screen.getByRole('button', { name: 'Review and decide' }));
    expect(requestDecision).toHaveBeenCalledWith(target);
  });
});
