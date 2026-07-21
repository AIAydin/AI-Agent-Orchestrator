// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { WorkflowExecutionView } from '../../../../../shared/workflow/contracts.js';
import { NodeRunHistory, nodeRunHistoryEntries } from './NodeRunHistory.js';

describe('NodeRunHistory', () => {
  it('shows an honest shared empty state for a node with no workflow attempts', () => {
    render(<NodeRunHistory nodeId="note-node" executions={[]} />);

    expect(screen.getByRole('heading', { name: 'Workflow run history' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/No saved workflow runs/iu);
    expect(screen.getByText(/saved locally and restored/iu)).toBeTruthy();
  });

  it('projects only the selected node and orders durable attempts newest first', () => {
    const older = execution('execution-old', '2026-07-17T12:00:00.000Z', [
      nodeRun('selected', 1, 'failed', 'The check failed.'),
      nodeRun('another-node', 1, 'succeeded'),
    ]);
    const newer = execution('execution-new', '2026-07-18T12:00:00.000Z', [
      nodeRun('selected', 2, 'succeeded'),
    ]);

    expect(nodeRunHistoryEntries('selected', [older, newer])).toMatchObject([
      { executionId: 'execution-new', attempt: 2, status: 'succeeded' },
      {
        executionId: 'execution-old',
        attempt: 1,
        status: 'failed',
        statusReason: 'The check failed.',
      },
    ]);

    render(<NodeRunHistory nodeId="selected" executions={[older, newer]} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('The check failed.')).toBeTruthy();
    expect(screen.queryByText('another-node')).toBeNull();
  });

  it('bounds long retained histories in the inspector', () => {
    const executions = Array.from({ length: 25 }, (_, index) =>
      execution(
        `execution-${String(index)}`,
        `2026-07-18T12:${String(index).padStart(2, '0')}:00.000Z`,
        [nodeRun('selected', index + 1, 'succeeded')],
      ),
    );

    expect(nodeRunHistoryEntries('selected', executions)).toHaveLength(20);
    expect(nodeRunHistoryEntries('selected', executions)[0]?.attempt).toBe(25);
  });
});

function execution(
  id: string,
  updatedAt: string,
  nodeRuns: WorkflowExecutionView['nodeRuns'],
): WorkflowExecutionView {
  return {
    schemaVersion: 1,
    id,
    projectId: 'project',
    canvasId: 'canvas',
    status: 'succeeded',
    revision: 1,
    scope: { kind: 'workflow' },
    planNodeIds: nodeRuns.map(({ nodeId }) => nodeId),
    nodeRuns,
    edges: [],
    approvals: [],
    humanDecisions: [],
    revisionEscapes: [],
    reviewGates: [],
    scheduling: {
      runnableNodeIds: [],
      waitingNodeIds: [],
      waitingForApprovalNodeIds: [],
      blockedNodeIds: [],
      activeNodeIds: [],
    },
    cancellationRequested: false,
    testResults: [],
    canvasUpdatedAt: '2026-07-18T10:00:00.000Z',
    createdAt: updatedAt,
    updatedAt,
    endedAt: updatedAt,
  };
}

function nodeRun(
  nodeId: string,
  attempt: number,
  status: WorkflowExecutionView['nodeRuns'][number]['status'],
  statusReason?: string,
): WorkflowExecutionView['nodeRuns'][number] {
  return {
    nodeId,
    status,
    attempt,
    queuedAt: '2026-07-18T10:00:00.000Z',
    startedAt: '2026-07-18T10:00:01.000Z',
    endedAt: '2026-07-18T10:00:02.000Z',
    resumable: false,
    ...(statusReason === undefined ? {} : { statusReason }),
  };
}
