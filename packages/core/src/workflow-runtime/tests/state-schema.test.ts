import { describe, expect, it } from 'vitest';

import { CanvasSchema } from '../../model/domain.js';
import {
  createWorkflowExecutionRuntime,
  parseWorkflowExecutionRuntime,
  recoverWorkflowExecution,
  startWorkflowNode,
} from '../index.js';

const OCCURRED_AT = '2026-07-15T18:00:00.000Z';

function runtime() {
  return createWorkflowExecutionRuntime(
    CanvasSchema.parse({
      schemaVersion: 1,
      id: 'canvas-1',
      projectId: 'project-1',
      name: 'Durable workflow',
      nodes: [
        {
          id: 'task-1',
          type: 'task',
          title: 'First task',
          color: '#445566',
          icon: 'task',
          position: { x: 0, y: 0 },
          size: { width: 320, height: 180 },
          status: 'ready',
          createdAt: OCCURRED_AT,
          updatedAt: OCCURRED_AT,
          data: { description: 'First' },
        },
        {
          id: 'task-2',
          type: 'task',
          title: 'Second task',
          color: '#445566',
          icon: 'task',
          position: { x: 400, y: 0 },
          size: { width: 320, height: 180 },
          status: 'ready',
          createdAt: OCCURRED_AT,
          updatedAt: OCCURRED_AT,
          data: { description: 'Second' },
        },
      ],
      edges: [
        {
          id: 'dependency-1',
          sourceNodeId: 'task-1',
          targetNodeId: 'task-2',
          type: 'dependency',
          config: { requiredStatus: 'succeeded' },
          createdAt: OCCURRED_AT,
        },
      ],
      groups: [],
      viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
      revisionLoops: [],
      workflowLimits: {},
      createdAt: OCCURRED_AT,
      updatedAt: OCCURRED_AT,
    }),
    {
      planId: 'plan-1',
      runId: 'run-1',
      scope: { kind: 'workflow' },
      occurredAt: OCCURRED_AT,
    },
  );
}

describe('durable workflow runtime schema', () => {
  it('round-trips a complete runtime through untrusted JSON', () => {
    const original = runtime();
    const restored = parseWorkflowExecutionRuntime(JSON.parse(JSON.stringify(original)));
    expect(restored).toEqual(original);
  });

  it('rejects a runtime whose plan and run references were spliced together', () => {
    const original = runtime();
    expect(() =>
      parseWorkflowExecutionRuntime({
        ...original,
        run: { ...original.run, planId: 'different-plan' },
      }),
    ).toThrow(/persisted scoped plan/u);
  });

  it('rejects a plan whose stages no longer partition the persisted node set', () => {
    const original = runtime();
    expect(() =>
      parseWorkflowExecutionRuntime({
        ...original,
        plan: {
          ...original.plan,
          stages: original.plan.stages.map((stage, index) =>
            index === 0 ? { ...stage, nodeIds: ['task-1', 'task-1'] } : stage,
          ),
        },
      }),
    ).toThrow(/every planned node exactly once/u);
  });

  it('rejects evidence map keys or run ownership that do not match embedded evidence', () => {
    const original = runtime();
    expect(() =>
      parseWorkflowExecutionRuntime({
        ...original,
        evidence: {
          ...original.evidence,
          humanApprovals: {
            'execute-edge-1': {
              runId: 'different-run',
              targetId: 'another-edge',
              targetType: 'execute-edge',
              targetAttempt: 1,
              evidenceFingerprint: 'fingerprint',
              approvalId: 'approval-1',
              approvedBy: 'local-user',
              approvedAt: OCCURRED_AT,
            },
          },
        },
      }),
    ).toThrow();
  });

  it('rehydrates internal execution references but still fails them closed during recovery', () => {
    const started = startWorkflowNode(
      runtime(),
      'task-1',
      { kind: 'internal', executionId: 'internal-1', startedAt: OCCURRED_AT },
      OCCURRED_AT,
    );
    const restored = parseWorkflowExecutionRuntime(JSON.parse(JSON.stringify(started)));
    expect(restored.run.nodeRuns['task-1']?.internalExecution).toMatchObject({
      executionId: 'internal-1',
    });

    const recovered = recoverWorkflowExecution(restored, new Map(), '2026-07-15T18:01:00.000Z');
    expect(recovered.runtime.run.nodeRuns['task-1']).toMatchObject({
      status: 'lost',
      failureCode: 'INTERNAL_EXECUTION_NOT_RECOVERED',
    });
  });
});
