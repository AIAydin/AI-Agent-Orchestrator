import {
  completeWorkflowNode,
  createWorkflowExecutionRuntime,
  getSchedulingSnapshot,
  startWorkflowNode,
  type WorkflowExecutionRuntime,
} from '@forgeboard/core';
import { CanvasSchema } from '@forgeboard/core/domain';
import { describe, expect, it } from 'vitest';

import {
  WorkflowApproveNodeInputSchema,
  WorkflowExecutionViewSchema,
} from '../../../shared/workflow/contracts.js';
import type { WorkflowHostState } from './service.js';
import { workflowHostStateToView } from './view.js';

const PROJECT_ID = '4dcf7f9c-6288-4fe7-8bf9-21a320ce42d7';
const CANVAS_ID = 'cc40cabc-b741-4598-81a8-19227e02ed31';
const NODE_ID = '43c6b3a8-f744-4529-b524-c79698643b23';
const RUN_ID = 'b95fe115-adc7-43cb-952e-d027aca07cb1';
const AGENT_RUN_ID = 'b95fe115-adc7-43cb-952e-d027aca07cb2';
const PLAN_ID = '5b7116f3-cb9d-4e90-8fee-bcc56af2a837';
const T0 = '2026-07-15T19:00:00.000Z';
const T1 = '2026-07-15T19:01:00.000Z';
const T2 = '2026-07-15T20:00:00.000Z';

describe('renderer-safe workflow view', () => {
  it('shows launch approval as a lifecycle state without exposing storage envelopes', () => {
    const runtime = queuedRuntime();
    const view = workflowHostStateToView(
      state(runtime, [
        {
          executionId: RUN_ID,
          nodeId: NODE_ID,
          attempt: 1,
          executorId: 'forgeboard.agent',
          preparationId: 'prepared-agent-1',
          approvalFingerprint: '12345678abcdef',
          expiresAt: T2,
          disclosure: { executable: 'forgeboard-codex', environmentVariableNames: ['PATH'] },
        },
      ]),
    );

    expect(view.nodeRuns).toMatchObject([
      { nodeId: NODE_ID, status: 'waiting-for-approval', attempt: 1 },
    ]);
    expect(view.approvals).toHaveLength(1);
    expect(view.canvasUpdatedAt).toBe(runtime.canvas.updatedAt);
    expect(view).not.toHaveProperty('runtime');
    expect(view).not.toHaveProperty('snapshot');
    expect(WorkflowExecutionViewSchema.parse(view)).toEqual(view);
  });

  it('shows a deferred Git preparation as retryable approval instead of node failure', () => {
    const runtime = queuedRuntime();
    const reason = 'Approve the exact Git filter command to continue preparing this node.';
    const view = workflowHostStateToView(
      state(
        runtime,
        [],
        [
          {
            nodeId: NODE_ID,
            attempt: 1,
            executorId: 'forgeboard.agent',
            reason,
            disclosure: { fingerprint: 'a'.repeat(64), operation: 'worktree-inspection' },
          },
        ],
      ),
    );

    expect(view.status).toBe('waiting-for-approval');
    expect(view.nodeRuns).toMatchObject([
      { nodeId: NODE_ID, status: 'waiting-for-approval', statusReason: reason },
    ]);
    expect(view.scheduling.runnableNodeIds).toEqual([]);
    expect(view.scheduling.waitingForApprovalNodeIds).toEqual([NODE_ID]);
    expect(view.approvals).toEqual([]);
  });

  it('exposes a real PID but strips its host identity token', () => {
    const runtime = startWorkflowNode(
      queuedRuntime(),
      NODE_ID,
      { pid: 4242, startedAt: T1, identityToken: 'private-process-identity-token' },
      T1,
    );
    const view = workflowHostStateToView(state(runtime));
    expect(view.nodeRuns[0]?.execution).toEqual({ kind: 'process', pid: 4242 });
    expect(JSON.stringify(view)).not.toContain('private-process-identity-token');
  });

  it('exposes only the exact current succeeded agent attempt with an active managed worktree', () => {
    const runtime = completedAgentRuntime();
    const record = persistedAgentRun();
    const view = workflowHostStateToView(state(runtime), [], {
      getRun: (runId) => (runId === AGENT_RUN_ID ? record : undefined),
    });

    expect(view.nodeRuns[0]?.reviewableAgentRunId).toBe(AGENT_RUN_ID);

    const staleAttempt = {
      ...runtime,
      evidence: {
        ...runtime.evidence,
        nodeCompletionOutputs: {
          ...runtime.evidence.nodeCompletionOutputs,
          [NODE_ID]: {
            ...runtime.evidence.nodeCompletionOutputs[NODE_ID]!,
            nodeAttempt: 2,
          },
        },
      },
    };
    expect(
      workflowHostStateToView(state(staleAttempt), [], { getRun: () => record }).nodeRuns[0]
        ?.reviewableAgentRunId,
    ).toBeUndefined();
    expect(
      workflowHostStateToView(state(runtime), [], {
        getRun: () => ({ ...record, supersededByRunId: RUN_ID }),
      }).nodeRuns[0]?.reviewableAgentRunId,
    ).toBeUndefined();
    expect(
      workflowHostStateToView(state(runtime), [], {
        getRun: () => ({ ...record, cwd: '/managed/swapped-run' }),
      }).nodeRuns[0]?.reviewableAgentRunId,
    ).toBeUndefined();
  });

  it('projects authoritative persisted review-gate evaluation with a passed reason', () => {
    const view = workflowHostStateToView(state(reviewGateRuntime()));

    expect(view.reviewGates).toEqual([
      expect.objectContaining({
        nodeId: 'review-gate',
        attempt: 1,
        status: 'passed',
        deterministicStatus: 'passed',
        reviewerStatus: 'not-required',
        humanStatus: 'not-required',
        checks: [],
        reviewerAssessment: null,
        blockingFindingIds: [],
        reasons: ['All required review gate evidence passed'],
      }),
    ]);
    expect(WorkflowExecutionViewSchema.parse(view)).toEqual(view);
  });

  it('forbids renderer-authored actors, timestamps, and negative confirmation', () => {
    const base = {
      executionId: RUN_ID,
      nodeId: NODE_ID,
      preparationId: 'prepared-agent-1',
      approvalFingerprint: '12345678abcdef',
      confirmed: true,
    } as const;
    expect(WorkflowApproveNodeInputSchema.parse(base)).toEqual(base);
    expect(WorkflowApproveNodeInputSchema.safeParse({ ...base, confirmed: false }).success).toBe(
      false,
    );
    expect(
      WorkflowApproveNodeInputSchema.safeParse({
        ...base,
        approvedBy: 'renderer-forged-user',
        approvedAt: T1,
      }).success,
    ).toBe(false);
  });
});

function queuedRuntime(): WorkflowExecutionRuntime {
  const canvas = CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Workflow view',
    nodes: [
      {
        id: NODE_ID,
        type: 'agent',
        title: 'Agent',
        color: '#445566',
        icon: 'bot',
        position: { x: 0, y: 0 },
        size: { width: 320, height: 180 },
        status: 'ready',
        data: {
          adapterId: 'codex',
          permissionProfileId: 'worktree-write',
          promptDraft: 'Make a deterministic change.',
        },
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    edges: [],
    groups: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    revisionLoops: [],
    workflowLimits: {},
    createdAt: T0,
    updatedAt: T0,
  });
  return createWorkflowExecutionRuntime(canvas, {
    planId: PLAN_ID,
    runId: RUN_ID,
    scope: { kind: 'workflow' },
    occurredAt: T0,
  });
}

function reviewGateRuntime(): WorkflowExecutionRuntime {
  const canvas = CanvasSchema.parse({
    schemaVersion: 1,
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Review gate view',
    nodes: [
      {
        id: 'review-gate',
        type: 'review-gate',
        title: 'Review gate',
        color: '#445566',
        icon: 'shield',
        position: { x: 0, y: 0 },
        size: { width: 320, height: 180 },
        status: 'ready',
        data: { humanApprovalRequired: false },
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    edges: [],
    groups: [],
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    revisionLoops: [],
    workflowLimits: {},
    createdAt: T0,
    updatedAt: T0,
  });
  return createWorkflowExecutionRuntime(canvas, {
    planId: PLAN_ID,
    runId: RUN_ID,
    scope: { kind: 'workflow' },
    occurredAt: T0,
  });
}

function completedAgentRuntime(): WorkflowExecutionRuntime {
  let runtime = startWorkflowNode(
    queuedRuntime(),
    NODE_ID,
    { pid: 4242, startedAt: T1, identityToken: 'agent-process' },
    T1,
  );
  runtime = completeWorkflowNode(runtime, NODE_ID, { status: 'succeeded' }, T2);
  return {
    ...runtime,
    evidence: {
      ...runtime.evidence,
      nodeCompletionOutputs: {
        [NODE_ID]: {
          runId: RUN_ID,
          nodeId: NODE_ID,
          nodeAttempt: 1,
          contentDigest: `sha256:${'a'.repeat(64)}`,
          sourceRunId: AGENT_RUN_ID,
          worktreePath: '/managed/agent-run',
          artifactContent: '{"schemaVersion":1,"files":[]}',
          verifiedAt: T2,
          verifierId: 'workflow-host',
        },
      },
    },
  };
}

function persistedAgentRun() {
  return {
    id: AGENT_RUN_ID,
    projectId: PROJECT_ID,
    nodeId: NODE_ID,
    adapterId: 'codex',
    status: 'succeeded' as const,
    cwd: '/managed/agent-run',
    branch: 'forgeboard/agent-run',
    worktreeId: 'b95fe115-adc7-43cb-952e-d027aca07cb3',
    worktreeState: 'active' as const,
    worktreeAuthority: 'owned' as const,
    repositoryRoot: '/repo',
    managedRoot: '/managed',
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    startedAt: T1,
    endedAt: T2,
    exitCode: 0,
    createdAt: T1,
    updatedAt: T2,
  };
}

function state(
  runtime: WorkflowExecutionRuntime,
  approvals: WorkflowHostState['approvals'] = [],
  delegateApprovals: WorkflowHostState['delegateApprovals'] = [],
): WorkflowHostState {
  return {
    execution: {
      schemaVersion: 1,
      id: RUN_ID,
      projectId: PROJECT_ID,
      canvasId: CANVAS_ID,
      status: runtime.run.status,
      revision: 1,
      runtime: { schemaVersion: 1, payload: {} },
      snapshot: { schemaVersion: 1, payload: {} },
      createdAt: T0,
      updatedAt: runtime.run.updatedAt,
    },
    runtime,
    scheduling: getSchedulingSnapshot(runtime),
    approvals,
    delegateApprovals,
  };
}
