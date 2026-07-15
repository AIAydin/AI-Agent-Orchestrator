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
  validateWorkflowExecutionConfiguration,
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

function testNode(id: string, runId: string) {
  return {
    id,
    type: 'test' as const,
    title: id,
    color: '#445566',
    icon: 'test',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    data: { command: { executable: 'pnpm', args: ['test'] }, runIds: [runId] },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function gateNode(id: string, maximumIterations: number) {
  return {
    id,
    type: 'review-gate' as const,
    title: id,
    color: '#445566',
    icon: 'gate',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    data: {
      humanApprovalRequired: false,
      retryPolicy: { maximumIterations, backoffMs: 0 },
    },
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
  it('keeps draft canvases honest but blocks only selected unconfigured nodes at plan time', () => {
    const draftAgent = {
      ...agentNode('draft-agent'),
      data: {},
    };
    const graph = canvas({ nodes: [taskNode('ready-task'), draftAgent], edges: [] });

    expect(validateWorkflow(graph).valid).toBe(true);
    expect(validateWorkflowExecutionConfiguration(graph, ['draft-agent'])).toEqual([
      {
        code: 'MISSING_NODE_CONFIGURATION',
        message: 'draft-agent requires agent adapter, permission profile before it can run',
        entityIds: ['draft-agent'],
      },
    ]);
    expect(
      planWorkflow(graph, {
        planId: 'task-only-plan',
        targetNodeIds: ['ready-task'],
        includeUpstream: false,
      }).nodeIds,
    ).toEqual(['ready-task']);
    expect(() => planWorkflow(graph, { planId: 'full-plan' })).toThrowError(
      /Workflow validation failed with 1 issue/u,
    );
  });

  it('blocks unavailable extension nodes when they are selected for execution', () => {
    const graph = canvas({
      nodes: [
        {
          id: 'extension-1',
          type: 'extension',
          title: 'Quarantined tool',
          color: '#445566',
          icon: 'box',
          position: { x: 0, y: 0 },
          size: { width: 300, height: 200 },
          data: {
            extensionId: 'example.tools',
            extensionVersion: '1.0.0',
            nodeTypeId: 'tool',
            definition: {},
            availability: 'quarantined',
          },
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      edges: [],
    });

    expect(validateWorkflowExecutionConfiguration(graph)).toContainEqual({
      code: 'NODE_UNAVAILABLE',
      message: 'Quarantined tool cannot run while its extension is quarantined',
      entityIds: ['extension-1'],
    });
    expect(() => planWorkflow(graph, { planId: 'extension-plan' })).toThrow(
      WorkflowValidationError,
    );
  });

  it('stores a draft revision edge but refuses to execute it without a bounded loop', () => {
    const graph = canvas({
      nodes: [taskNode('implementation'), taskNode('review')],
      edges: [
        {
          id: 'draft-revision',
          sourceNodeId: 'review',
          targetNodeId: 'implementation',
          type: 'revision',
          config: {},
          createdAt: NOW,
        },
      ],
    });

    expect(validateWorkflow(graph).valid).toBe(true);
    expect(validateWorkflowExecutionConfiguration(graph)).toContainEqual({
      code: 'MISSING_EDGE_CONFIGURATION',
      message: 'Revision edge requires a bounded loop before it can run',
      entityIds: ['draft-revision'],
    });
    expect(() => planWorkflow(graph, { planId: 'draft-revision-plan' })).toThrow(
      WorkflowValidationError,
    );
  });

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

  it('rejects missing required context and reviewer targets that contradict edge configuration', () => {
    const graph = canvas({
      nodes: [taskNode('source'), agentNode('agent-target'), reviewNode('review-target')],
      edges: [
        {
          id: 'required-context',
          sourceNodeId: 'source',
          targetNodeId: 'agent-target',
          type: 'context',
          config: { required: true, attachmentIds: [] },
          createdAt: NOW,
        },
        {
          id: 'wrong-agent-reviewer',
          sourceNodeId: 'source',
          targetNodeId: 'review-target',
          type: 'review',
          config: { reviewer: 'agent' },
          createdAt: NOW,
        },
        {
          id: 'wrong-gate-reviewer',
          sourceNodeId: 'source',
          targetNodeId: 'review-target',
          type: 'review',
          config: { reviewer: 'gate' },
          createdAt: NOW,
        },
      ],
    });

    expect(validateWorkflow(graph).issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['MISSING_REQUIRED_CONTEXT', 'INVALID_REVIEWER', 'INVALID_REVIEWER']),
    );
  });

  it('allows explicit Context edges to target an Agent-backed Task', () => {
    const graph = canvas({
      nodes: [taskNode('context-source'), taskNode('assigned-task')],
      edges: [
        {
          id: 'task-context',
          sourceNodeId: 'context-source',
          targetNodeId: 'assigned-task',
          type: 'context',
          config: { required: true, attachmentIds: ['context-source'] },
          createdAt: NOW,
        },
      ],
    });

    expect(validateWorkflow(graph).valid).toBe(true);
  });

  it('unifies a review gate retry policy with its bounded revision loop', () => {
    const graph = canvas({
      nodes: [agentNode('agent-1'), gateNode('gate-1', 3)],
      edges: [
        {
          id: 'review-edge',
          sourceNodeId: 'agent-1',
          targetNodeId: 'gate-1',
          type: 'review',
          config: { reviewer: 'gate', requireApproval: true },
          createdAt: NOW,
        },
        {
          id: 'revision-edge',
          sourceNodeId: 'gate-1',
          targetNodeId: 'agent-1',
          type: 'revision',
          config: { loopId: 'loop-1' },
          createdAt: NOW,
        },
      ],
      revisionLoops: [
        {
          id: 'loop-1',
          implementationNodeId: 'agent-1',
          reviewNodeId: 'gate-1',
          reviewEdgeId: 'review-edge',
          revisionEdgeId: 'revision-edge',
          maximumAttempts: 2,
          stopConditions: ['review-approved'],
          humanEscapeHatch: {
            enabled: true,
            approvalRequired: true,
            instructions: 'A human decides how to resolve an exhausted review loop.',
          },
        },
      ],
    });

    expect(validateWorkflow(graph).issues).toContainEqual({
      code: 'RETRY_POLICY_MISMATCH',
      message: 'Review-gate retry iterations must equal the bounded revision-loop attempt limit',
      entityIds: ['loop-1', 'gate-1'],
    });
  });

  it('requires a real reviewer agent and an unambiguous producer for every required check', () => {
    const duplicateProducer = (id: string) => ({
      id,
      type: 'test' as const,
      title: id,
      color: '#445566',
      icon: 'test',
      position: { x: 0, y: 0 },
      size: { width: 300, height: 200 },
      data: {
        command: { executable: 'pnpm', args: ['test'] },
        runIds: ['duplicate-check'],
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const graph = canvas({
      nodes: [
        agentNode('implementation'),
        duplicateProducer('producer-a'),
        duplicateProducer('producer-b'),
        {
          ...gateNode('gate-1', 1),
          data: {
            humanApprovalRequired: false,
            reviewerAgentId: 'missing-reviewer',
            requiredCheckIds: ['missing-check', 'duplicate-check'],
            retryPolicy: { maximumIterations: 1, backoffMs: 0 },
          },
        },
      ],
      edges: [
        {
          id: 'review-edge',
          sourceNodeId: 'implementation',
          targetNodeId: 'gate-1',
          type: 'review',
          config: { reviewer: 'gate', requireApproval: true },
          createdAt: NOW,
        },
      ],
    });

    expect(validateWorkflow(graph).issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'INVALID_REVIEWER',
        'MISSING_CHECK_PRODUCER',
        'AMBIGUOUS_CHECK_PRODUCER',
      ]),
    );
  });

  it('requires each check producer to consume a verified output from the reviewed source', () => {
    const graph = canvas({
      nodes: [
        agentNode('implementation'),
        testNode('producer', 'required-check'),
        {
          ...gateNode('gate-1', 1),
          data: {
            humanApprovalRequired: false,
            requiredCheckIds: ['required-check'],
            retryPolicy: { maximumIterations: 1, backoffMs: 0 },
          },
        },
      ],
      edges: [
        {
          id: 'review-edge',
          sourceNodeId: 'implementation',
          targetNodeId: 'gate-1',
          type: 'review',
          config: { reviewer: 'gate', requireApproval: true },
          createdAt: NOW,
        },
      ],
    });

    expect(validateWorkflow(graph).issues).toContainEqual({
      code: 'MISSING_CHECK_INPUT',
      message:
        'A required check producer must consume a required verified output from the reviewed source',
      entityIds: ['gate-1', 'required-check', 'implementation', 'producer'],
    });
  });

  it('restricts human decisions to one mandatory edge on a dedicated review node', () => {
    const graph = canvas({
      nodes: [
        taskNode('source-a'),
        taskNode('source-b'),
        taskNode('arbitrary-target'),
        reviewNode('shared-review'),
        reviewNode('optional-review'),
        reviewNode('controlled-review'),
      ],
      edges: [
        {
          id: 'arbitrary-human-review',
          sourceNodeId: 'source-a',
          targetNodeId: 'arbitrary-target',
          type: 'review',
          config: { reviewer: 'human', requireApproval: true },
          createdAt: NOW,
        },
        {
          id: 'shared-review-a',
          sourceNodeId: 'source-a',
          targetNodeId: 'shared-review',
          type: 'review',
          config: { reviewer: 'human', requireApproval: true },
          createdAt: NOW,
        },
        {
          id: 'shared-review-b',
          sourceNodeId: 'source-b',
          targetNodeId: 'shared-review',
          type: 'review',
          config: { reviewer: 'human', requireApproval: true },
          createdAt: NOW,
        },
        {
          id: 'optional-human-review',
          sourceNodeId: 'source-a',
          targetNodeId: 'optional-review',
          type: 'review',
          config: { reviewer: 'human', requireApproval: false },
          createdAt: NOW,
        },
        {
          id: 'controlled-human-review',
          sourceNodeId: 'source-a',
          targetNodeId: 'controlled-review',
          type: 'review',
          config: { reviewer: 'human', requireApproval: true },
          createdAt: NOW,
        },
        {
          id: 'unrelated-control',
          sourceNodeId: 'source-b',
          targetNodeId: 'controlled-review',
          type: 'execute',
          config: {},
          createdAt: NOW,
        },
      ],
    });

    expect(
      validateWorkflow(graph).issues.filter((issue) => issue.code === 'INVALID_REVIEW_TARGET'),
    ).toHaveLength(4);
  });

  it('rejects revision loops whose only success path is the exhausted human escape', () => {
    const graph = canvas({
      nodes: [agentNode('implementation'), reviewNode('review-1')],
      edges: [
        {
          id: 'review-edge',
          sourceNodeId: 'implementation',
          targetNodeId: 'review-1',
          type: 'review',
          config: { reviewer: 'human', requireApproval: true },
          createdAt: NOW,
        },
        {
          id: 'revision-edge',
          sourceNodeId: 'review-1',
          targetNodeId: 'implementation',
          type: 'revision',
          config: { loopId: 'loop-1' },
          createdAt: NOW,
        },
      ],
      revisionLoops: [
        {
          id: 'loop-1',
          implementationNodeId: 'implementation',
          reviewNodeId: 'review-1',
          reviewEdgeId: 'review-edge',
          revisionEdgeId: 'revision-edge',
          maximumAttempts: 1,
          stopConditions: ['human-accepted'],
          humanEscapeHatch: {
            enabled: true,
            approvalRequired: true,
            instructions: 'A human resolves the exhausted review loop.',
          },
        },
      ],
    });

    expect(validateWorkflow(graph).issues).toContainEqual({
      code: 'UNACHIEVABLE_STOP_CONDITION',
      message: 'A revision loop requires an automatic success stop condition before human escape',
      entityIds: ['loop-1', 'human-accepted'],
    });
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

  it('rejects a terminal aggregate while a sibling node is still nonterminal', () => {
    expect(() =>
      WorkflowRunSchema.parse({
        schemaVersion: 1,
        id: 'run-1',
        canvasId: 'canvas-1',
        planId: 'plan-1',
        status: 'failed',
        nodeRuns: {
          'task-a': {
            nodeId: 'task-a',
            status: 'failed',
            attempt: 1,
            queuedAt: NOW,
            endedAt: LATER,
          },
          'task-b': { nodeId: 'task-b', status: 'queued', attempt: 1, queuedAt: NOW },
        },
        revisionLoops: {},
        createdAt: NOW,
        updatedAt: LATER,
        endedAt: LATER,
      }),
    ).toThrow('cannot be terminal');
  });

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
