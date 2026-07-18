// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowExecutionView } from '../../../../../../shared/workflow/contracts.js';
import { WorkspaceWorkflowPanel } from '../WorkspaceWorkflowPanel.js';

afterEach(cleanup);

describe('WorkspaceWorkflowPanel', () => {
  it('shows node and edge lifecycle evidence and opens exact pending decisions', () => {
    const onReviewDecision = vi.fn();
    const current = execution();
    render(
      <WorkspaceWorkflowPanel
        executions={[current]}
        current={current}
        nodeTitles={new Map([['agent-node', 'Implementation agent']])}
        interactiveNodeIds={new Set()}
        interactionEvents={[]}
        loading={false}
        busyAction={null}
        mutationsAuthorized
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onCancel={vi.fn()}
        onReviewDecision={onReviewDecision}
        onSendInput={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );

    expect(screen.getByText('Implementation agent')).toBeTruthy();
    expect(screen.getAllByText('Waiting for approval')).toHaveLength(3);
    expect(screen.getByText('Exact prepared launch is awaiting confirmation.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review what will run' }));
    expect(onReviewDecision).toHaveBeenCalledWith({
      kind: 'launch',
      request: current.approvals[0],
    });
  });

  it('offers native-confirmed cancellation only for an active workflow', () => {
    const onCancel = vi.fn();
    const current = execution();
    const view = render(
      <WorkspaceWorkflowPanel
        executions={[current]}
        current={current}
        nodeTitles={new Map()}
        interactiveNodeIds={new Set()}
        interactionEvents={[]}
        loading={false}
        busyAction={null}
        mutationsAuthorized
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onCancel={onCancel}
        onReviewDecision={vi.fn()}
        onSendInput={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(onCancel).toHaveBeenCalledWith(current.id);

    view.rerender(
      <WorkspaceWorkflowPanel
        executions={[{ ...current, status: 'succeeded' }]}
        current={{ ...current, status: 'succeeded' }}
        nodeTitles={new Map()}
        interactiveNodeIds={new Set()}
        interactionEvents={[]}
        loading={false}
        busyAction={null}
        mutationsAuthorized
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onCancel={onCancel}
        onReviewDecision={vi.fn()}
        onSendInput={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
  });

  it('keeps workflow evidence readable while disabling every decision and control for read-only roles', () => {
    const current = execution();
    render(
      <WorkspaceWorkflowPanel
        executions={[current]}
        current={current}
        nodeTitles={new Map([['agent-node', 'Implementation agent']])}
        interactiveNodeIds={new Set(['agent-node'])}
        interactionEvents={[]}
        loading={false}
        busyAction={null}
        mutationsAuthorized={false}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onCancel={vi.fn()}
        onReviewDecision={vi.fn()}
        onSendInput={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );

    expect(screen.getByRole('status').textContent).toMatch(/view workflow history/u);
    expect(screen.getByText('Implementation agent')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Review what will run' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('shows bounded live output and sends input or interruption to the exact attempt', async () => {
    const onSendInput = vi.fn(() => Promise.resolve(true));
    const onInterrupt = vi.fn(() => Promise.resolve(true));
    const current = {
      ...execution(),
      status: 'running' as const,
      nodeRuns: [
        {
          nodeId: 'agent-node',
          status: 'running' as const,
          attempt: 2,
          queuedAt: '2026-07-15T12:00:00.000Z',
          startedAt: '2026-07-15T12:00:01.000Z',
          resumable: false,
        },
      ],
      approvals: [],
    };
    render(
      <WorkspaceWorkflowPanel
        executions={[current]}
        current={current}
        nodeTitles={new Map([['agent-node', 'Implementation agent']])}
        interactiveNodeIds={new Set(['agent-node'])}
        interactionEvents={[
          {
            executionId: current.id,
            nodeId: 'agent-node',
            attempt: 2,
            sequence: 1,
            occurredAt: '2026-07-15T12:00:02.000Z',
            kind: 'stream',
            channel: 'pty',
            text: 'Ready for input',
            truncated: false,
          },
        ]}
        loading={false}
        busyAction={null}
        mutationsAuthorized
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onCancel={vi.fn()}
        onReviewDecision={vi.fn()}
        onSendInput={onSendInput}
        onInterrupt={onInterrupt}
      />,
    );

    expect(screen.getByLabelText('Live output for Implementation agent').textContent).toContain(
      'Ready for input',
    );
    fireEvent.change(screen.getByLabelText('Send input to the running program'), {
      target: { value: 'continue\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(onSendInput).toHaveBeenCalledWith({
        executionId: current.id,
        nodeId: 'agent-node',
        attempt: 2,
        data: 'continue\n',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onInterrupt).toHaveBeenCalledWith({
      executionId: current.id,
      nodeId: 'agent-node',
      attempt: 2,
    });
  });
});

function execution(): WorkflowExecutionView {
  return {
    schemaVersion: 1,
    id: 'workflow-execution',
    projectId: 'workflow-project',
    canvasId: 'workflow-canvas',
    status: 'waiting-for-approval',
    revision: 2,
    scope: { kind: 'workflow' },
    planNodeIds: ['agent-node'],
    nodeRuns: [
      {
        nodeId: 'agent-node',
        status: 'waiting-for-approval',
        attempt: 1,
        queuedAt: '2026-07-15T12:00:00.000Z',
        resumable: false,
      },
    ],
    edges: [
      {
        edgeId: 'execute-edge',
        type: 'execute',
        sourceNodeId: 'agent-node',
        targetNodeId: 'agent-node',
        status: 'waiting-for-approval',
        disposition: 'waiting-for-approval',
        reason: 'Exact prepared launch is awaiting confirmation.',
      },
    ],
    approvals: [
      {
        executionId: 'workflow-execution',
        nodeId: 'agent-node',
        attempt: 1,
        executorId: 'agent-executor',
        preparationId: 'prepared-launch',
        approvalFingerprint: 'fingerprint-123',
        expiresAt: '2099-07-15T12:05:00.000Z',
        disclosure: { command: ['agent', 'run'] },
      },
    ],
    humanDecisions: [],
    revisionEscapes: [],
    scheduling: {
      runnableNodeIds: [],
      waitingNodeIds: [],
      waitingForApprovalNodeIds: ['agent-node'],
      blockedNodeIds: [],
      activeNodeIds: [],
    },
    cancellationRequested: false,
    testResults: [],
    createdAt: '2026-07-15T12:00:00.000Z',
    updatedAt: '2026-07-15T12:01:00.000Z',
  };
}
