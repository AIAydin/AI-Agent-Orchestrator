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

function sessionValue(roster: readonly unknown[] = []): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    settings: { defaultAgent: 'claude' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    nodeRoster: roster,
    checkProducers: [
      { nodeId: 't1', producerId: 'test', title: 'Unit tests', checkKind: 'test' },
      { nodeId: 't2', producerId: 'lint', title: 'Lint', checkKind: 'lint' },
    ],
    fileTargets: [],
  } as unknown as AgentSessionContextValue;
}

/** A complete review-gate view so the authoritative evidence panel can render. */
function reviewGateView(overrides: Partial<WorkflowReviewGateView> = {}): WorkflowReviewGateView {
  return {
    nodeId: 'g1',
    attempt: 1,
    status: 'waiting-human',
    deterministicStatus: 'passed',
    reviewerStatus: 'not-required',
    humanStatus: 'pending',
    checks: [],
    reviewerAssessment: null,
    missingCheckIds: [],
    failedCheckIds: [],
    pendingCheckIds: [],
    blockingFindingIds: [],
    reasons: ['Waiting for your approval.'],
    ...overrides,
  } as WorkflowReviewGateView;
}

function runtimeValue(
  overrides: Partial<WorkflowRuntimeContextValue> = {},
): WorkflowRuntimeContextValue {
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
  roster: readonly unknown[] = [],
) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue(roster)}>
        <WorkflowRuntimeProvider value={runtimeValue(runtime)}>
          <ReviewGateNodeFace id="g1" data={nodeData(overrides)} />
        </WorkflowRuntimeProvider>
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('ReviewGateNodeFace', () => {
  it('shows the authoritative gate state and evidence when the workflow has evaluated it', () => {
    renderFace(
      {},
      {
        reviewGateFor: () =>
          reviewGateView({
            checks: [
              { id: 'test', kind: 'test', status: 'passed', exitCode: 0 },
            ] as unknown as WorkflowReviewGateView['checks'],
          }),
      },
    );
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Waiting for you');
    expect(screen.getByText('Waiting for your approval.')).toBeTruthy();
    expect(screen.getByLabelText('Authoritative review gate evidence')).toBeTruthy();
    expect(screen.getByText('test', { selector: 'code' })).toBeTruthy();
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

  it('keeps reviewer and policy config behind the configure popover', () => {
    renderFace();
    expect(screen.queryByLabelText('Tests must pass')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Configure review gate' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tests must pass' }));
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('g1', { testsRequired: true });
  });

  it('selects a supported reviewer agent from the popover', () => {
    renderFace({}, {}, [
      { id: 'agent-1', title: 'Claude', kind: 'agent', locked: false, adapterId: 'claude' },
      { id: 'agent-2', title: 'Legacy', kind: 'agent', locked: false, adapterId: 'gemini' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Configure review gate' }));
    const options = [...screen.getByLabelText('Reviewer agent').querySelectorAll('option')].map(
      (option) => option.value,
    );
    expect(options).toEqual(['', 'agent-1']);
    fireEvent.change(screen.getByLabelText('Reviewer agent'), { target: { value: 'agent-1' } });
    expect(updateNodeData).toHaveBeenCalledWith('g1', { reviewerAgentId: 'agent-1' });
  });
});
