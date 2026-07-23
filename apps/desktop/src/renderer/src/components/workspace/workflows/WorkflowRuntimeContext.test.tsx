// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import type { WorkflowExecutionView } from '../../../../../shared/workflow/contracts.js';
import {
  useWorkflowRuntime,
  workflowPendingDecision,
  WorkflowRuntimeProvider,
  type WorkflowRuntimeContextValue,
} from './WorkflowRuntimeContext.js';

function execution(overrides: Partial<WorkflowExecutionView> = {}): WorkflowExecutionView {
  return {
    approvals: [],
    humanDecisions: [],
    revisionEscapes: [],
    ...overrides,
  } as unknown as WorkflowExecutionView;
}

describe('workflowPendingDecision', () => {
  it('returns null without an execution or matching request', () => {
    expect(workflowPendingDecision(null, 'n1')).toBeNull();
    expect(workflowPendingDecision(execution(), 'n1')).toBeNull();
  });

  it('prefers human decisions, then revision escapes, then launch approvals', () => {
    const human = { nodeId: 'n1' };
    const revision = { nodeId: 'n1' };
    const launch = { nodeId: 'n1' };
    expect(
      workflowPendingDecision(
        execution({
          humanDecisions: [human],
          revisionEscapes: [revision],
          approvals: [launch],
        } as unknown as Partial<WorkflowExecutionView>),
        'n1',
      ),
    ).toEqual({ kind: 'human', request: human });
    expect(
      workflowPendingDecision(
        execution({
          revisionEscapes: [revision],
          approvals: [launch],
        } as unknown as Partial<WorkflowExecutionView>),
        'n1',
      ),
    ).toEqual({ kind: 'revision', request: revision });
    expect(
      workflowPendingDecision(
        execution({ approvals: [launch] } as unknown as Partial<WorkflowExecutionView>),
        'n1',
      ),
    ).toEqual({ kind: 'launch', request: launch });
  });
});

describe('useWorkflowRuntime', () => {
  it('throws without a provider and returns the provided value with one', () => {
    expect(() => renderHook(() => useWorkflowRuntime())).toThrow(
      'useWorkflowRuntime requires a WorkflowRuntimeProvider.',
    );
    const value = {
      busyAction: null,
      startNode: vi.fn(),
    } as unknown as WorkflowRuntimeContextValue;
    const { result } = renderHook(() => useWorkflowRuntime(), {
      wrapper: ({ children }) => (
        <WorkflowRuntimeProvider value={value}>{children}</WorkflowRuntimeProvider>
      ),
    });
    expect(result.current).toBe(value);
  });
});
