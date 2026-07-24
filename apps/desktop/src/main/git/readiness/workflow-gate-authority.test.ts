import { createWorkflowExecutionRuntime, type WorkflowExecutionRuntime } from '@forgeboard/core';
import { CanvasSchema, type Canvas } from '@forgeboard/core/domain';
import { describe, expect, it } from 'vitest';

import type { WorkflowExecutionRecord } from '../../storage/workflow/contracts.js';
import {
  DeliveryWorkflowGateAuthority,
  type WorkflowExecutionReader,
} from './workflow-gate-authority.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const TARGET_RUN_ID = '20000000-0000-4000-8000-000000000001';
const EXECUTION_ID = 'workflow-execution-1';
const NOW = '2026-07-17T20:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const PUBLICATION_DIGEST = 'b'.repeat(64);
const target = { kind: 'agent-worktree', projectId: PROJECT_ID, runId: TARGET_RUN_ID } as const;

describe('DeliveryWorkflowGateAuthority', () => {
  it('binds one exact passed gate and normalizes its output digest', () => {
    const record = execution(runtimeWithGates(['succeeded']));
    const authority = new DeliveryWorkflowGateAuthority(reader(record));

    const result = authority.bind(target, EXECUTION_ID);

    expect(result.binding).toMatchObject({
      executionId: EXECUTION_ID,
      sourceNodeId: 'agent-1',
      sourceAttempt: 1,
      sourceOutputDigest: DIGEST,
      gates: [{ gateNodeId: 'gate-1', gateAttempt: 1 }],
    });
    expect(result.mandatoryCheckIds).toEqual([]);
  });

  it('blocks a relevant failed gate even when another relevant gate passed', () => {
    const authority = new DeliveryWorkflowGateAuthority(
      reader(execution(runtimeWithGates(['succeeded', 'failed']))),
    );

    expect(() => authority.bind(target, EXECUTION_ID)).toThrow(
      'Review Gate gate-2 did not succeed',
    );
  });

  it('blocks a relevant gate with ambiguous reviewed sources', () => {
    const authority = new DeliveryWorkflowGateAuthority(
      reader(execution(runtimeWithGates(['succeeded'], true))),
    );

    expect(() => authority.bind(target, EXECUTION_ID)).toThrow('ambiguous reviewed sources');
  });

  it('rejects a succeeded record whose runtime identity or status disagrees', () => {
    const runtime = runtimeWithGates(['succeeded']);
    const mismatched = execution({
      ...runtime,
      run: { ...runtime.run, id: 'different-run' },
      evidence: {
        ...runtime.evidence,
        outputPublications: Object.fromEntries(
          Object.entries(runtime.evidence.outputPublications).map(([id, publication]) => [
            id,
            { ...publication, runId: 'different-run' },
          ]),
        ),
        nodeCompletionOutputs: Object.fromEntries(
          Object.entries(runtime.evidence.nodeCompletionOutputs).map(([id, output]) => [
            id,
            { ...output, runId: 'different-run' },
          ]),
        ),
      },
    });
    const authority = new DeliveryWorkflowGateAuthority(reader(mismatched));

    expect(() => authority.bind(target, EXECUTION_ID)).toThrow(
      'record does not match its succeeded runtime',
    );
  });
});

function runtimeWithGates(
  gateStatuses: readonly ('succeeded' | 'failed')[],
  ambiguous = false,
): WorkflowExecutionRuntime {
  const canvas = workflowCanvas(gateStatuses.length, ambiguous);
  const initial = createWorkflowExecutionRuntime(canvas, {
    planId: 'plan-1',
    runId: EXECUTION_ID,
    scope: { kind: 'workflow' },
    occurredAt: NOW,
  });
  const nodeRuns = Object.fromEntries(
    Object.entries(initial.run.nodeRuns).map(([nodeId, run]) => {
      const gateIndex = nodeId.startsWith('gate-') ? Number(nodeId.slice(5)) - 1 : -1;
      const status = gateIndex >= 0 ? gateStatuses[gateIndex]! : 'succeeded';
      return [nodeId, { ...run, status, endedAt: NOW }];
    }),
  );
  return {
    ...initial,
    run: { ...initial.run, status: 'succeeded', nodeRuns, updatedAt: NOW, endedAt: NOW },
    evidence: {
      ...initial.evidence,
      outputPublications: {
        'output-edge': {
          edgeId: 'output-edge',
          runId: EXECUTION_ID,
          producerNodeId: 'agent-1',
          producerAttempt: 1,
          outputKind: 'diff',
          referenceIds: [`agent-run:${TARGET_RUN_ID}`],
          contentDigest: `sha256:${PUBLICATION_DIGEST}`,
          verifiedAt: NOW,
          verifierId: 'host-verifier',
        },
      },
      nodeCompletionOutputs: {
        'agent-1': {
          runId: EXECUTION_ID,
          nodeId: 'agent-1',
          nodeAttempt: 1,
          contentDigest: `sha256:${DIGEST}`,
          sourceRunId: TARGET_RUN_ID,
          worktreePath: '/managed/agent-1',
          artifactContent: '{"schemaVersion":1,"files":[]}',
          verifiedAt: NOW,
          verifierId: 'host-verifier',
        },
      },
    },
  };
}

function workflowCanvas(gateCount: number, ambiguous: boolean): Canvas {
  const base = {
    title: 'Node',
    color: '#445566',
    icon: 'node',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const agent = (id: string) => ({
    ...base,
    id,
    type: 'agent' as const,
    data: { adapterId: 'codex', permissionProfileId: 'worktree' },
  });
  const gates = Array.from({ length: gateCount }, (_, index) => ({
    ...base,
    id: `gate-${String(index + 1)}`,
    type: 'review-gate' as const,
    data: {
      humanApprovalRequired: false,
      requiredCheckIds: [],
      retryPolicy: { maximumIterations: 1, backoffMs: 0 },
    },
  }));
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: 'canvas-1',
    projectId: PROJECT_ID,
    name: 'Delivery authority fixture',
    nodes: [
      agent('agent-1'),
      ...(ambiguous ? [agent('agent-2')] : []),
      { ...base, id: 'sink-1', type: 'task', data: {} },
      ...gates,
    ],
    edges: [
      {
        id: 'output-edge',
        sourceNodeId: 'agent-1',
        targetNodeId: 'sink-1',
        type: 'output',
        config: { outputKind: 'diff' },
        createdAt: NOW,
      },
      ...gates.map((gate) => ({
        id: `review-${gate.id}`,
        sourceNodeId: 'agent-1',
        targetNodeId: gate.id,
        type: 'review' as const,
        config: { reviewer: 'gate' as const },
        createdAt: NOW,
      })),
      ...(ambiguous
        ? [
            {
              id: 'review-ambiguous',
              sourceNodeId: 'agent-2',
              targetNodeId: 'gate-1',
              type: 'review',
              config: { reviewer: 'gate' },
              createdAt: NOW,
            },
          ]
        : []),
    ],
    groups: [],
    revisionLoops: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function execution(runtime: WorkflowExecutionRuntime): WorkflowExecutionRecord {
  return {
    schemaVersion: 1,
    id: EXECUTION_ID,
    projectId: PROJECT_ID,
    canvasId: 'canvas-1',
    status: 'succeeded',
    revision: 4,
    runtime: { schemaVersion: 1, payload: runtime as never },
    snapshot: { schemaVersion: 1, payload: {} },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function reader(record: WorkflowExecutionRecord): WorkflowExecutionReader {
  return {
    getWorkflowExecution: (executionId) => (executionId === record.id ? record : undefined),
    listProjectWorkflowExecutions: () => [record],
  };
}
