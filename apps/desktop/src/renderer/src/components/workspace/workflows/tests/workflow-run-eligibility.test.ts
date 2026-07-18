import { describe, expect, it } from 'vitest';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { createEdgeData } from '../../model/edge-config.js';
import type { WorkshopEdge } from '../../model/types.js';
import {
  runnableWorkflowNodeCount,
  workflowExecutionMatchesCurrentCanvas,
  workflowNodeEligibility,
  workflowSelectionEligibility,
} from '../workflow-run-eligibility.js';

describe('workflow run eligibility', () => {
  it('does not present historical execution evidence after the canvas changes', () => {
    const execution = { canvasUpdatedAt: '2026-07-17T20:00:10.000Z' };
    expect(
      workflowExecutionMatchesCurrentCanvas(execution, '2026-07-17T20:00:10.000Z', false),
    ).toBe(true);
    expect(workflowExecutionMatchesCurrentCanvas(execution, '2026-07-17T20:00:10.000Z', true)).toBe(
      false,
    );
    expect(
      workflowExecutionMatchesCurrentCanvas(execution, '2026-07-17T20:00:12.000Z', false),
    ).toBe(false);
  });

  it('runs production executors and keeps ordinary canvas context passive', () => {
    const nodes = [node('agent', 'agent-1'), node('brief', 'brief-1'), node('task', 'task-1')];
    expect(runnableWorkflowNodeCount(nodes, [])).toBe(1);
    expect(workflowNodeEligibility(nodes[0]!, []).runnable).toBe(true);
    expect(workflowNodeEligibility(nodes[1]!, []).reason).toMatch(/does not launch/u);
    expect(workflowNodeEligibility(nodes[2]!, [], nodes).reason).toMatch(/Choose an Agent/u);
  });

  it('runs a Task only when its explicitly configured assignee is an existing Agent node', () => {
    const agent = node('agent', 'agent-1');
    const task = node('task', 'task-1');
    task.data['assigneeId'] = agent.id;

    expect(workflowNodeEligibility(task, [], [task, agent])).toEqual({
      runnable: true,
      reason: 'Run this Task with its configured Agent assignee and upstream dependencies',
    });
    const missing = workflowNodeEligibility(task, [], [task]);
    expect(missing.runnable).toBe(false);
    expect(missing.reason).toMatch(/missing/u);
    expect(runnableWorkflowNodeCount([task, agent], [])).toBe(2);
  });

  it('treats only an explicitly bound human diff review as internally runnable', () => {
    const review = node('diff', 'review-1');
    expect(workflowNodeEligibility(review, []).runnable).toBe(false);
    const edges: WorkshopEdge[] = [
      {
        id: 'review-edge',
        source: 'agent-1',
        target: review.id,
        data: createEdgeData('review', 'agent-1', {
          reviewer: 'human',
          requireApproval: true,
        }),
      },
    ];
    expect(workflowNodeEligibility(review, edges).runnable).toBe(true);
  });

  it('creates deterministic selection and group scopes only for runnable members', () => {
    const first = node('agent', 'agent-b');
    const second = node('test', 'test-a');
    expect(workflowSelectionEligibility([first, second], [first, second], [])).toMatchObject({
      runnable: true,
      scope: {
        kind: 'selection',
        nodeIds: ['agent-b', 'test-a'],
        includeUpstream: true,
      },
    });
    const group = node('group-frame', 'group-1');
    group.data['childNodeIds'] = ['agent-b', 'note-a'];
    const note = node('note-image', 'note-a');
    expect(workflowSelectionEligibility([group], [group, first, note], [])).toMatchObject({
      runnable: true,
      scope: { kind: 'group', groupId: 'group-1' },
    });
    expect(workflowSelectionEligibility([first, note], [first, note], []).runnable).toBe(false);
  });
});

function node(kind: WorkshopNode['data']['kind'], id: string): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x: 0, y: 0 },
    data: {
      kind,
      title: id,
      description: '',
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
    },
  };
}
