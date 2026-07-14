import { describe, expect, it } from 'vitest';

import { CanvasSchema, type Canvas } from './domain.js';
import {
  WorkflowRunSchema,
  WorkflowValidationError,
  advanceRevisionLoop,
  createRevisionLoopState,
  planWorkflow,
  recoverInterruptedRun,
  requestWorkflowCancellation,
  transitionNodeRun,
  validateWorkflow,
} from './workflow.js';

const NOW = '2026-07-14T12:00:00.000Z';
const LATER = '2026-07-14T12:01:00.000Z';

function taskNode(
  id: string,
  resources?: { cpuUnits: number; memoryMb: number; exclusiveKeys?: string[] },
) {
  return {
    id,
    type: 'task' as const,
    title: id,
    color: '#445566',
    icon: 'task',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    ...(resources === undefined ? {} : { resources }),
    data: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function agentNode(id: string) {
  return {
    id,
    type: 'agent' as const,
    title: id,
    color: '#445566',
    icon: 'agent',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    data: { adapterId: 'test-agent', permissionProfileId: 'worktree' },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function reviewNode(id: string) {
  return {
    id,
    type: 'diff-review' as const,
    title: id,
    color: '#445566',
    icon: 'review',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    data: { baseRef: 'main', headRef: 'feature', worktreeId: 'worktree-1' },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function dependencyEdge(id: string, sourceNodeId: string, targetNodeId: string) {
  return {
    id,
    sourceNodeId,
    targetNodeId,
    type: 'dependency' as const,
    config: {},
    createdAt: NOW,
  };
}

function canvas(input: Record<string, unknown> & { nodes: unknown[]; edges: unknown[] }): Canvas {
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: 'canvas-1',
    projectId: 'project-1',
    name: 'Workflow',
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  });
}

describe('workflow validation and planning', () => {
  it('produces stable dependency order and resource-bounded parallel stages', () => {
    const graph = canvas({
      nodes: [taskNode('task-c'), taskNode('task-b'), taskNode('task-a')],
      edges: [
        dependencyEdge('edge-bc', 'task-b', 'task-c'),
        dependencyEdge('edge-ac', 'task-a', 'task-c'),
      ],
      workflowLimits: { maximumConcurrency: 2, maximumCpuUnits: 2, maximumMemoryMb: 512 },
    });

    const first = planWorkflow(graph, { planId: 'plan-1' });
    const second = planWorkflow(graph, { planId: 'plan-1' });
    expect(first).toEqual(second);
    expect(first.stages.map((stage) => stage.nodeIds)).toEqual([['task-a', 'task-b'], ['task-c']]);
    expect(first.dependencies['task-c']).toEqual(['task-a', 'task-b']);
  });

  it('serializes nodes that require the same exclusive resource', () => {
    const graph = canvas({
      nodes: [
        taskNode('task-a', { cpuUnits: 1, memoryMb: 128, exclusiveKeys: ['port:4173'] }),
        taskNode('task-b', { cpuUnits: 1, memoryMb: 128, exclusiveKeys: ['port:4173'] }),
      ],
      edges: [],
    });
    expect(planWorkflow(graph, { planId: 'plan-1' }).stages.map((stage) => stage.nodeIds)).toEqual([
      ['task-a'],
      ['task-b'],
    ]);
  });

  it('rejects ordinary cycles with the participating nodes', () => {
    const graph = canvas({
      nodes: [taskNode('task-a'), taskNode('task-b')],
      edges: [
        dependencyEdge('edge-ab', 'task-a', 'task-b'),
        dependencyEdge('edge-ba', 'task-b', 'task-a'),
      ],
    });
    const validation = validateWorkflow(graph);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toContainEqual({
      code: 'CYCLE',
      message: 'Workflow contains an unbounded cycle',
      entityIds: ['task-a', 'task-b'],
    });
    expect(() => planWorkflow(graph, { planId: 'plan-1' })).toThrow(WorkflowValidationError);
  });

  it('accepts only explicitly registered, structurally valid bounded revision loops', () => {
    const loop = {
      id: 'loop-1',
      implementationNodeId: 'agent-1',
      reviewNodeId: 'review-1',
      reviewEdgeId: 'review-edge',
      revisionEdgeId: 'revision-edge',
      maximumAttempts: 2,
      stopConditions: ['review-approved', 'human-accepted'] as const,
      humanEscapeHatch: {
        enabled: true as const,
        approvalRequired: true as const,
        instructions: 'A human must approve, retry, or cancel the exhausted loop.',
      },
    };
    const graph = canvas({
      nodes: [reviewNode('review-1'), agentNode('agent-1')],
      edges: [
        {
          id: 'review-edge',
          sourceNodeId: 'agent-1',
          targetNodeId: 'review-1',
          type: 'review',
          config: { reviewer: 'human' },
          createdAt: NOW,
        },
        {
          id: 'revision-edge',
          sourceNodeId: 'review-1',
          targetNodeId: 'agent-1',
          type: 'revision',
          config: { loopId: 'loop-1' },
          createdAt: NOW,
        },
      ],
      revisionLoops: [loop],
    });
    expect(validateWorkflow(graph)).toMatchObject({
      valid: true,
      topologicalOrder: ['agent-1', 'review-1'],
    });

    let state = createRevisionLoopState(graph.revisionLoops[0]!);
    state = advanceRevisionLoop(graph.revisionLoops[0]!, state, {
      type: 'review-failed',
      feedback: 'Fix the failing boundary test and preserve the accepted behavior.',
    });
    expect(state.status).toBe('revision-required');
    state = advanceRevisionLoop(graph.revisionLoops[0]!, state, { type: 'revision-completed' });
    expect(state.attemptsStarted).toBe(2);
    state = advanceRevisionLoop(graph.revisionLoops[0]!, state, {
      type: 'review-failed',
      feedback: 'The deterministic boundary test still fails.',
    });
    expect(state.status).toBe('waiting-human');
    expect(() =>
      advanceRevisionLoop(graph.revisionLoops[0]!, state, { type: 'revision-completed' }),
    ).toThrow();
  });

  it('rejects revision edges that try to bypass bounded-loop configuration', () => {
    const graph = canvas({
      nodes: [reviewNode('review-1'), agentNode('agent-1')],
      edges: [
        {
          id: 'revision-edge',
          sourceNodeId: 'review-1',
          targetNodeId: 'agent-1',
          type: 'revision',
          config: { loopId: 'unregistered-loop' },
          createdAt: NOW,
        },
      ],
    });
    expect(
      validateWorkflow(graph).issues.some((issue) => issue.code === 'UNREGISTERED_REVISION_EDGE'),
    ).toBe(true);
  });
});

describe('run lifecycle, cancellation, and recovery', () => {
  const runningNode = {
    nodeId: 'task-a',
    status: 'running' as const,
    attempt: 1,
    queuedAt: NOW,
    startedAt: NOW,
    process: { pid: 123, startedAt: NOW, identityToken: 'process-token-a' },
    resumable: false,
  };

  it('cancels queued work immediately and requests interruption for live work', () => {
    const run = WorkflowRunSchema.parse({
      schemaVersion: 1,
      id: 'run-1',
      canvasId: 'canvas-1',
      planId: 'plan-1',
      status: 'running',
      nodeRuns: {
        'task-a': runningNode,
        'task-b': { nodeId: 'task-b', status: 'queued', attempt: 1, queuedAt: NOW },
      },
      revisionLoops: {},
      createdAt: NOW,
      updatedAt: NOW,
    });
    const cancelled = requestWorkflowCancellation(run, LATER);
    expect(cancelled.status).toBe('cancelling');
    expect(cancelled.nodeRuns['task-a']?.status).toBe('cancelling');
    expect(cancelled.nodeRuns['task-b']).toMatchObject({ status: 'cancelled', endedAt: LATER });
  });

  it('never presents an unproven persisted process as alive after restart', () => {
    const run = WorkflowRunSchema.parse({
      schemaVersion: 1,
      id: 'run-1',
      canvasId: 'canvas-1',
      planId: 'plan-1',
      status: 'running',
      nodeRuns: { 'task-a': runningNode },
      revisionLoops: {},
      createdAt: NOW,
      updatedAt: NOW,
    });
    const recovered = recoverInterruptedRun(run, new Map(), LATER);
    expect(recovered.lostNodeIds).toEqual(['task-a']);
    expect(recovered.run).toMatchObject({ status: 'lost', endedAt: LATER });
    expect(recovered.run.nodeRuns['task-a']).toMatchObject({
      status: 'lost',
      failureCode: 'PROCESS_NOT_RECOVERED',
    });
    expect(recovered.run.nodeRuns['task-a']?.process).toBeUndefined();
  });

  it('requires both pid and identity token before retaining a live process', () => {
    const run = WorkflowRunSchema.parse({
      schemaVersion: 1,
      id: 'run-1',
      canvasId: 'canvas-1',
      planId: 'plan-1',
      status: 'running',
      nodeRuns: { 'task-a': runningNode },
      revisionLoops: {},
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(recoverInterruptedRun(run, new Map([[123, 'wrong-token']]), LATER).lostNodeIds).toEqual([
      'task-a',
    ]);
    expect(
      recoverInterruptedRun(run, new Map([[123, 'process-token-a']]), LATER).lostNodeIds,
    ).toEqual([]);
  });

  it('increments attempts only for explicit retry transitions', () => {
    const failed = {
      nodeId: 'task-a',
      status: 'failed' as const,
      attempt: 1,
      queuedAt: NOW,
      startedAt: NOW,
      endedAt: LATER,
      resumable: false,
      failureCode: 'TEST_FAILED',
    };
    expect(transitionNodeRun(failed, { status: 'queued', occurredAt: LATER })).toMatchObject({
      status: 'queued',
      attempt: 2,
      queuedAt: LATER,
    });
    expect(() => transitionNodeRun(failed, { status: 'succeeded', occurredAt: LATER })).toThrow(
      'Invalid run transition',
    );
  });
});
