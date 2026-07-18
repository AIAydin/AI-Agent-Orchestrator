// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkflowApprovalRequest,
  WorkflowEventEnvelope,
  WorkflowExecutionView,
  WorkflowInteractionEventEnvelope,
} from '../../../../../../shared/workflow/contracts.js';
import { useWorkflowRuns } from '../useWorkflowRuns.js';

const PROJECT_ID = 'workflow-project';
const CANVAS_ID = 'workflow-canvas';
const list = vi.fn();
const start = vi.fn();
const approveNode = vi.fn();
const approveHuman = vi.fn();
const decideReview = vi.fn();
const resolveRevisionEscape = vi.fn();
const cancel = vi.fn();
const cancelNode = vi.fn();
const sendInput = vi.fn();
const interrupt = vi.fn();
const onError = vi.fn();
let eventListener: ((event: WorkflowEventEnvelope) => void) | null = null;
let interactionListener: ((event: WorkflowInteractionEventEnvelope) => void) | null = null;

beforeEach(() => {
  for (const mock of [
    list,
    start,
    approveNode,
    approveHuman,
    decideReview,
    resolveRevisionEscape,
    cancel,
    cancelNode,
    sendInput,
    interrupt,
    onError,
  ]) {
    mock.mockReset();
  }
  list.mockResolvedValue({ ok: true, value: [] });
  sendInput.mockResolvedValue({ ok: true, value: true });
  interrupt.mockResolvedValue({ ok: true, value: true });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      workflows: {
        list,
        start,
        approveNode,
        approveHuman,
        decideReview,
        resolveRevisionEscape,
        cancel,
        cancelNode,
        sendInput,
        interrupt,
        onEvent: vi.fn((listener: (event: WorkflowEventEnvelope) => void) => {
          eventListener = listener;
          return () => {
            eventListener = null;
          };
        }),
        onInteractionEvent: vi.fn((listener: (event: WorkflowInteractionEventEnvelope) => void) => {
          interactionListener = listener;
          return () => {
            interactionListener = null;
          };
        }),
      },
    },
  });
});

afterEach(() => {
  eventListener = null;
  interactionListener = null;
  cleanup();
});

describe('useWorkflowRuns', () => {
  it('retains interaction output that arrives just before its workflow execution is recorded', async () => {
    const hook = renderWorkflowHook(vi.fn(() => Promise.resolve(true)));
    await waitFor(() => expect(interactionListener).not.toBeNull());

    act(() => {
      interactionListener?.({
        executionId: 'workflow-execution',
        nodeId: 'agent-node',
        attempt: 1,
        sequence: 0,
        occurredAt: '2026-07-15T12:00:00.000Z',
        kind: 'stream',
        channel: 'stdout',
        text: 'output before node-started\n',
        truncated: false,
      });
    });
    expect(hook.result.current.workflows.interactionEvents).toEqual([]);

    act(() => {
      eventListener?.(workflowEvent(execution({ status: 'running', revision: 2 })));
    });
    await waitFor(() =>
      expect(hook.result.current.workflows.interactionEvents).toEqual([
        expect.objectContaining({
          executionId: 'workflow-execution',
          text: 'output before node-started\n',
        }),
      ]),
    );
  });

  it('saves before starting and sends only a typed workflow scope', async () => {
    const flushCanvas = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    start.mockResolvedValue({ ok: true, value: execution() });
    const hook = renderWorkflowHook(flushCanvas);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    await act(async () => await hook.result.current.workflows.start({ kind: 'workflow' }));
    expect(start).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      'The workflow was not started because the canvas could not be saved.',
    );

    await act(
      async () =>
        await hook.result.current.workflows.start({
          kind: 'node',
          nodeId: 'agent-node',
          includeUpstream: true,
        }),
    );
    await act(
      async () =>
        await hook.result.current.workflows.cancelNode({
          executionId: 'workflow-execution',
          nodeId: 'agent-node',
          attempt: 1,
        }),
    );
    expect(start).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      scope: { kind: 'node', nodeId: 'agent-node', includeUpstream: true },
    });
    expect(hook.result.current.workflows.currentExecution?.id).toBe('workflow-execution');
  });

  it('adopts validated main-process events only for the open canvas', async () => {
    const hook = renderWorkflowHook(vi.fn(() => Promise.resolve(true)));
    await waitFor(() => expect(eventListener).not.toBeNull());

    act(() => {
      eventListener?.(workflowEvent(execution({ status: 'running', revision: 2 })));
      eventListener?.(
        workflowEvent(
          execution({
            id: 'other-execution',
            canvasId: 'other-canvas',
            revision: 9,
          }),
        ),
      );
    });

    expect(hook.result.current.workflows.executions).toHaveLength(1);
    expect(hook.result.current.workflows.currentExecution?.revision).toBe(2);
    expect(hook.result.current.events[0]).toBe('Workflow node started for agent-node.');
  });

  it('never lets an older event or mutation response replace a newer durable revision', async () => {
    approveNode.mockResolvedValue({
      ok: true,
      value: execution({ revision: 2 }),
    });
    const hook = renderWorkflowHook(vi.fn(() => Promise.resolve(true)));
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => {
      eventListener?.(workflowEvent(execution({ status: 'running', revision: 3 })));
      eventListener?.(workflowEvent(execution({ status: 'queued', revision: 2 })));
    });
    const request: WorkflowApprovalRequest = {
      executionId: 'workflow-execution',
      nodeId: 'agent-node',
      attempt: 1,
      executorId: 'agent-executor',
      preparationId: 'prepared-launch',
      approvalFingerprint: 'fingerprint-123',
      expiresAt: '2099-07-15T12:05:00.000Z',
      disclosure: {},
    };

    await act(async () => await hook.result.current.workflows.approveNode(request));

    expect(hook.result.current.workflows.currentExecution).toMatchObject({
      revision: 3,
      status: 'running',
    });
  });

  it('binds launch approval to the exact prepared request without renderer authority fields', async () => {
    approveNode.mockResolvedValue({
      ok: true,
      value: execution({ revision: 3 }),
    });
    const hook = renderWorkflowHook(vi.fn(() => Promise.resolve(true)));
    const request: WorkflowApprovalRequest = {
      executionId: 'workflow-execution',
      nodeId: 'agent-node',
      attempt: 1,
      executorId: 'agent-executor',
      preparationId: 'prepared-launch',
      approvalFingerprint: 'fingerprint-123',
      expiresAt: '2099-07-15T12:05:00.000Z',
      disclosure: { command: ['agent', 'run'] },
    };

    await act(async () => await hook.result.current.workflows.approveNode(request));

    expect(approveNode).toHaveBeenCalledWith({
      executionId: request.executionId,
      nodeId: request.nodeId,
      preparationId: request.preparationId,
      approvalFingerprint: request.approvalFingerprint,
      confirmed: true,
    });
    expect(approveNode.mock.calls[0]?.[0]).not.toHaveProperty('approvedBy');
    expect(approveNode.mock.calls[0]?.[0]).not.toHaveProperty('approvedAt');
  });

  it('keeps history readable but rejects every workflow mutation for read-only roles', async () => {
    list.mockResolvedValue({ ok: true, value: [execution()] });
    const flushCanvas = vi.fn(() => Promise.resolve(true));
    const hook = renderWorkflowHook(flushCanvas, false);
    await waitFor(() => expect(hook.result.current.workflows.executions).toHaveLength(1));

    await act(async () => await hook.result.current.workflows.start({ kind: 'workflow' }));
    const request: WorkflowApprovalRequest = {
      executionId: 'workflow-execution',
      nodeId: 'agent-node',
      attempt: 1,
      executorId: 'agent-executor',
      preparationId: 'prepared-launch',
      approvalFingerprint: 'fingerprint-123',
      expiresAt: '2099-07-15T12:05:00.000Z',
      disclosure: {},
    };
    await act(async () => await hook.result.current.workflows.approveNode(request));
    await act(
      async () =>
        await hook.result.current.workflows.sendInput({
          executionId: 'workflow-execution',
          nodeId: 'agent-node',
          attempt: 1,
          data: 'blocked\n',
        }),
    );

    expect(list).toHaveBeenCalledOnce();
    expect(flushCanvas).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(approveNode).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
    expect(cancelNode).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      'This collaboration role can inspect workflow history but cannot mutate workflow execution.',
    );
  });

  it('keeps live output bounded and sends controls with only execution, node, and attempt identity', async () => {
    const hook = renderWorkflowHook(vi.fn(() => Promise.resolve(true)));
    await waitFor(() => expect(eventListener).not.toBeNull());
    act(() => {
      eventListener?.(
        workflowEvent(
          execution({
            status: 'running',
            revision: 2,
            nodeRuns: [
              {
                nodeId: 'agent-node',
                status: 'running',
                attempt: 1,
                queuedAt: '2026-07-15T12:00:00.000Z',
                startedAt: '2026-07-15T12:00:01.000Z',
                resumable: false,
              },
            ],
          }),
        ),
      );
    });
    await waitFor(() => expect(hook.result.current.workflows.executions).toHaveLength(1));
    act(() => {
      for (let sequence = 0; sequence < 300; sequence += 1) {
        interactionListener?.({
          executionId: 'workflow-execution',
          nodeId: 'agent-node',
          attempt: 1,
          sequence,
          occurredAt: '2026-07-15T12:00:02.000Z',
          kind: 'stream',
          channel: 'stdout',
          text: `line-${String(sequence)}`,
          truncated: false,
        });
      }
    });
    expect(hook.result.current.workflows.interactionEvents).toHaveLength(256);

    await act(async () => {
      await hook.result.current.workflows.sendInput({
        executionId: 'workflow-execution',
        nodeId: 'agent-node',
        attempt: 1,
        data: 'continue\n',
      });
      await hook.result.current.workflows.interrupt({
        executionId: 'workflow-execution',
        nodeId: 'agent-node',
        attempt: 1,
      });
    });
    expect(sendInput).toHaveBeenCalledWith({
      executionId: 'workflow-execution',
      nodeId: 'agent-node',
      attempt: 1,
      data: 'continue\n',
    });
    expect(interrupt).toHaveBeenCalledWith({
      executionId: 'workflow-execution',
      nodeId: 'agent-node',
      attempt: 1,
    });
    expect(sendInput.mock.calls[0]?.[0]).not.toHaveProperty('runId');
    expect(sendInput.mock.calls[0]?.[0]).not.toHaveProperty('ownerId');
  });
});

function renderWorkflowHook(flushCanvas: () => Promise<boolean>, mutationsAuthorized = true) {
  return renderHook(() => {
    const [events, setEvents] = useState<string[]>([]);
    const workflows = useWorkflowRuns({
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      flushCanvas,
      setEvents,
      onError,
      mutationsAuthorized,
    });
    return { workflows, events };
  });
}

function workflowEvent(value: WorkflowExecutionView): WorkflowEventEnvelope {
  return {
    type: 'node-started',
    occurredAt: '2026-07-15T12:00:01.000Z',
    nodeId: 'agent-node',
    payload: {},
    execution: value,
  };
}

function execution(overrides: Partial<WorkflowExecutionView> = {}): WorkflowExecutionView {
  return {
    schemaVersion: 1,
    id: 'workflow-execution',
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    status: 'queued',
    revision: 1,
    scope: { kind: 'workflow' },
    planNodeIds: ['agent-node'],
    nodeRuns: [
      {
        nodeId: 'agent-node',
        status: 'queued',
        attempt: 1,
        queuedAt: '2026-07-15T12:00:00.000Z',
        resumable: false,
      },
    ],
    edges: [],
    approvals: [],
    humanDecisions: [],
    revisionEscapes: [],
    scheduling: {
      runnableNodeIds: ['agent-node'],
      waitingNodeIds: [],
      waitingForApprovalNodeIds: [],
      blockedNodeIds: [],
      activeNodeIds: [],
    },
    cancellationRequested: false,
    testResults: [],
    canvasUpdatedAt: '2026-07-15T12:00:00.000Z',
    createdAt: '2026-07-15T12:00:00.000Z',
    updatedAt: '2026-07-15T12:00:00.000Z',
    ...overrides,
  };
}
