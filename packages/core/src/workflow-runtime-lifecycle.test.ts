import { describe, expect, it } from 'vitest';

import { CanvasSchema, type Canvas } from './domain.js';
import {
  cancelWorkflowExecution,
  completeWorkflowNode,
  createWorkflowExecutionRuntime,
  failWorkflowNodeBeforeLaunch,
  recoverWorkflowExecution,
  startWorkflowNode,
} from './workflow-runtime.js';
import { NodeRunStateSchema } from './workflow.js';

const NOW = '2026-07-15T12:00:00.000Z';
const STARTED = '2026-07-15T12:01:00.000Z';
const ENDED = '2026-07-15T12:02:00.000Z';

const baseNode = {
  title: 'Task',
  color: '#445566',
  icon: 'task',
  position: { x: 0, y: 0 },
  size: { width: 300, height: 200 },
  createdAt: NOW,
  updatedAt: NOW,
};

function taskNode(
  id: string,
  resources?: { cpuUnits: number; memoryMb: number; exclusiveKeys: string[] },
) {
  return {
    ...baseNode,
    id,
    type: 'task' as const,
    ...(resources === undefined ? {} : { resources }),
    data: {},
  };
}

function canvas(nodes: unknown[], edges: unknown[] = []): Canvas {
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: 'canvas-1',
    projectId: 'project-1',
    name: 'Lifecycle canvas',
    nodes,
    edges,
    groups: [],
    revisionLoops: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function runtimeFor(graph: Canvas) {
  return createWorkflowExecutionRuntime(graph, {
    planId: 'plan-1',
    runId: 'run-1',
    scope: { kind: 'workflow' },
    occurredAt: NOW,
  });
}

const INTERNAL_EXECUTION = {
  kind: 'internal' as const,
  executionId: 'operation:test-1',
  startedAt: STARTED,
};

describe('workflow runtime launch lifecycle', () => {
  it('runs and completes host-managed work without inventing a process identifier', () => {
    let runtime = runtimeFor(canvas([taskNode('task-1')]));

    runtime = startWorkflowNode(runtime, 'task-1', INTERNAL_EXECUTION, STARTED);
    expect(runtime.run.nodeRuns['task-1']).toMatchObject({
      status: 'running',
      startedAt: STARTED,
      internalExecution: INTERNAL_EXECUTION,
    });
    expect(runtime.run.nodeRuns['task-1']?.process).toBeUndefined();

    runtime = completeWorkflowNode(runtime, 'task-1', { status: 'succeeded' }, ENDED);
    expect(runtime.run.nodeRuns['task-1']).toMatchObject({
      status: 'succeeded',
      endedAt: ENDED,
    });
    expect(runtime.run.nodeRuns['task-1']?.internalExecution).toBeUndefined();
  });

  it('retains an internal execution while cancelling, then clears it on acknowledgement', () => {
    let runtime = runtimeFor(canvas([taskNode('task-1')]));
    runtime = startWorkflowNode(runtime, 'task-1', INTERNAL_EXECUTION, STARTED);

    runtime = cancelWorkflowExecution(runtime, ENDED);
    expect(runtime.run.nodeRuns['task-1']).toMatchObject({
      status: 'cancelling',
      internalExecution: INTERNAL_EXECUTION,
    });
    expect(runtime.run.nodeRuns['task-1']?.process).toBeUndefined();

    runtime = completeWorkflowNode(
      runtime,
      'task-1',
      { status: 'cancelled', reason: 'The host stopped the internal operation' },
      ENDED,
    );
    expect(runtime.run.nodeRuns['task-1']?.status).toBe('cancelled');
    expect(runtime.run.nodeRuns['task-1']?.internalExecution).toBeUndefined();
  });

  it('fails closed when an in-process execution is encountered after host restart', () => {
    let runtime = runtimeFor(canvas([taskNode('task-1')]));
    runtime = startWorkflowNode(runtime, 'task-1', INTERNAL_EXECUTION, STARTED);

    const recovered = recoverWorkflowExecution(runtime, new Map(), ENDED);
    expect(recovered.lostNodeIds).toEqual(['task-1']);
    expect(recovered.runtime.run.nodeRuns['task-1']).toMatchObject({
      status: 'lost',
      endedAt: ENDED,
      failureCode: 'INTERNAL_EXECUTION_NOT_RECOVERED',
      statusReason: 'An in-process execution cannot be proven alive after a host restart',
    });
    expect(recovered.runtime.run.nodeRuns['task-1']?.process).toBeUndefined();
    expect(recovered.runtime.run.nodeRuns['task-1']?.internalExecution).toBeUndefined();
  });

  it('records a ready-node launch failure without ever creating an active execution', () => {
    const graph = canvas(
      [taskNode('source'), taskNode('dependent')],
      [
        {
          id: 'dependency-1',
          type: 'dependency',
          sourceNodeId: 'source',
          targetNodeId: 'dependent',
          config: { requiredStatus: 'succeeded' },
          createdAt: NOW,
        },
      ],
    );
    let runtime = runtimeFor(graph);

    runtime = failWorkflowNodeBeforeLaunch(
      runtime,
      'source',
      { failureCode: 'EXECUTABLE_NOT_FOUND', reason: 'Configured executable was not found' },
      STARTED,
    );

    expect(runtime.run.nodeRuns['source']).toEqual({
      nodeId: 'source',
      status: 'failed',
      attempt: 1,
      queuedAt: NOW,
      endedAt: STARTED,
      resumable: false,
      failureCode: 'EXECUTABLE_NOT_FOUND',
      statusReason: 'Configured executable was not found',
    });
    expect(runtime.run.nodeRuns['dependent']).toMatchObject({
      status: 'cancelled',
      endedAt: STARTED,
    });
    expect(runtime.run).toMatchObject({ status: 'failed', endedAt: STARTED });
  });

  it('rejects prelaunch failure for a node that is not queued and launch-ready', () => {
    const graph = canvas(
      [taskNode('source'), taskNode('dependent')],
      [
        {
          id: 'dependency-1',
          type: 'dependency',
          sourceNodeId: 'source',
          targetNodeId: 'dependent',
          config: { requiredStatus: 'succeeded' },
          createdAt: NOW,
        },
      ],
    );
    let runtime = runtimeFor(graph);
    expect(() =>
      failWorkflowNodeBeforeLaunch(
        runtime,
        'dependent',
        { failureCode: 'LAUNCH_FAILED', reason: 'Should not launch yet' },
        STARTED,
      ),
    ).toThrow('is not runnable');

    runtime = startWorkflowNode(runtime, 'source', INTERNAL_EXECUTION, STARTED);
    expect(() =>
      failWorkflowNodeBeforeLaunch(
        runtime,
        'source',
        { failureCode: 'LAUNCH_FAILED', reason: 'Execution already started' },
        ENDED,
      ),
    ).toThrow('cannot fail before launch from status running');
  });

  it('preserves the existing PID-backed start and identity-safe recovery contract', () => {
    const process = { pid: 4242, startedAt: STARTED, identityToken: 'process-token-4242' };
    let runtime = runtimeFor(canvas([taskNode('task-1')]));
    runtime = startWorkflowNode(runtime, 'task-1', process, STARTED);

    expect(runtime.run.nodeRuns['task-1']).toMatchObject({ status: 'running', process });
    expect(runtime.run.nodeRuns['task-1']?.internalExecution).toBeUndefined();
    const recovered = recoverWorkflowExecution(
      runtime,
      new Map([[4242, 'process-token-4242']]),
      ENDED,
    );
    expect(recovered.lostNodeIds).toEqual([]);
    expect(recovered.runtime.run.nodeRuns['task-1']).toMatchObject({
      status: 'running',
      process,
    });
  });

  it('does not record a launch failure while another run owns the required resource', () => {
    const resource = { cpuUnits: 1, memoryMb: 128, exclusiveKeys: ['worktree:shared'] };
    let runtime = runtimeFor(canvas([taskNode('task-1', resource), taskNode('task-2', resource)]));
    runtime = startWorkflowNode(runtime, 'task-1', INTERNAL_EXECUTION, STARTED);

    expect(() =>
      failWorkflowNodeBeforeLaunch(
        runtime,
        'task-2',
        { failureCode: 'LAUNCH_FAILED', reason: 'This launch was never eligible' },
        ENDED,
      ),
    ).toThrow('exceeds currently available workflow resources');
    expect(runtime.run.nodeRuns['task-2']?.status).toBe('queued');
  });

  it('rejects ambiguous active states with both execution-reference kinds', () => {
    expect(
      NodeRunStateSchema.safeParse({
        nodeId: 'task-1',
        status: 'running',
        attempt: 1,
        queuedAt: NOW,
        startedAt: STARTED,
        process: { pid: 4242, startedAt: STARTED, identityToken: 'process-token-4242' },
        internalExecution: INTERNAL_EXECUTION,
      }).success,
    ).toBe(false);
  });
});
