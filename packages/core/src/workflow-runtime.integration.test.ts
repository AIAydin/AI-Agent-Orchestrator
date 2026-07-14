import { describe, expect, it } from 'vitest';

import { CanvasSchema, type Canvas, type CheckResult } from './domain.js';
import type { ReviewerAssessment } from './workflow-gates.js';
import {
  applyRevisionReview,
  approveWorkflowHumanDecision,
  cancelWorkflowExecution,
  completeWorkflowNode,
  contextAttachmentsForNode,
  createWorkflowExecutionRuntime,
  evaluateExecutableEdge,
  getRevisionEscapeRequest,
  getSchedulingSnapshot,
  getWorkflowHumanApprovalRequest,
  planWorkflowScope,
  publishWorkflowOutput,
  queueRevisionAttempt,
  recordWorkflowContextResolution,
  recordWorkflowGateChecks,
  recordWorkflowHumanReviewDecision,
  recordWorkflowReview,
  recoverWorkflowExecution,
  resolveRevisionEscape,
  startWorkflowNode,
  type WorkflowEvidenceVerifier,
  type WorkflowExecutionRuntime,
} from './workflow-runtime.js';

const NOW = '2026-07-14T12:00:00.000Z';
const T1 = '2026-07-14T12:01:00.000Z';
const T2 = '2026-07-14T12:02:00.000Z';
const T3 = '2026-07-14T12:03:00.000Z';
const T4 = '2026-07-14T12:04:00.000Z';
const FIRST_DIGEST = 'sha256:first-reviewed-output';
const SECOND_DIGEST = 'sha256:second-reviewed-output';

const HOST_VERIFIER: WorkflowEvidenceVerifier = {
  verifyContextResolution: () => true,
  verifyOutputPublication: () => true,
  verifyCheckResult: () => true,
  verifyReviewerAssessment: () => true,
};

const baseNode = {
  title: 'Node',
  color: '#445566',
  icon: 'node',
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

function agentNode(id: string) {
  return {
    ...baseNode,
    id,
    type: 'agent' as const,
    data: { adapterId: 'test-agent', permissionProfileId: 'worktree' },
  };
}

function reviewerNode() {
  return agentNode('reviewer-agent');
}

function noteNode(id: string) {
  return { ...baseNode, id, type: 'note-image' as const, data: { markdown: 'Explicit brief' } };
}

function diffReviewNode(id: string) {
  return {
    ...baseNode,
    id,
    type: 'diff-review' as const,
    data: { baseRef: 'main', headRef: 'feature', worktreeId: 'worktree-1' },
  };
}

function testNode(id: string) {
  return {
    ...baseNode,
    id,
    type: 'test' as const,
    data: { command: { executable: 'pnpm', args: ['test'] }, runIds: ['check-test'] },
  };
}

function gateNode(id: string, maximumIterations = 2, humanApprovalRequired = false, backoffMs = 0) {
  return {
    ...baseNode,
    id,
    type: 'review-gate' as const,
    data: {
      humanApprovalRequired,
      requiredCheckIds: ['check-test'],
      testsRequired: true,
      reviewerAgentId: 'reviewer-agent',
      retryPolicy: { maximumIterations, backoffMs },
    },
  };
}

function canvas(input: {
  nodes: unknown[];
  edges?: unknown[];
  groups?: unknown[];
  revisionLoops?: unknown[];
  limits?: { maximumConcurrency: number; maximumCpuUnits: number; maximumMemoryMb: number };
}): Canvas {
  return CanvasSchema.parse({
    schemaVersion: 1,
    id: 'canvas-1',
    projectId: 'project-1',
    name: 'Executable workflow',
    nodes: input.nodes,
    edges: input.edges ?? [],
    groups: input.groups ?? [],
    revisionLoops: input.revisionLoops ?? [],
    ...(input.limits === undefined ? {} : { workflowLimits: input.limits }),
    viewState: { viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function process(pid: number) {
  return { pid, startedAt: NOW, identityToken: `process-token-${pid}` };
}

function check(
  status: CheckResult['status'],
  producerAttempt = 1,
  reviewedNodeAttempt = 1,
  reviewedOutputDigest = FIRST_DIGEST,
): CheckResult {
  return {
    id: 'check-test',
    runId: 'run-1',
    producerNodeId: 'test-1',
    producerAttempt,
    reviewedNodeId: 'agent-1',
    reviewedNodeAttempt,
    reviewedOutputDigest,
    kind: 'test',
    command: { executable: 'pnpm', args: ['test'], environmentNames: [] },
    status,
  };
}

function runtimeFor(graph: Canvas) {
  return createWorkflowExecutionRuntime(graph, {
    planId: 'plan-1',
    runId: 'run-1',
    scope: { kind: 'workflow' },
    occurredAt: NOW,
  });
}

function publish(
  runtime: WorkflowExecutionRuntime,
  edgeId: string,
  referenceId: string,
  contentDigest = FIRST_DIGEST,
): WorkflowExecutionRuntime {
  const edge = runtime.canvas.edges.find((candidate) => candidate.id === edgeId);
  if (edge?.type !== 'output') throw new Error(`Missing output edge ${edgeId}`);
  const producer = runtime.run.nodeRuns[edge.sourceNodeId];
  if (producer === undefined) throw new Error(`Missing output producer ${edge.sourceNodeId}`);
  return publishWorkflowOutput(
    runtime,
    {
      edgeId,
      runId: runtime.run.id,
      producerNodeId: edge.sourceNodeId,
      producerAttempt: producer.attempt,
      outputKind: edge.config.outputKind,
      referenceIds: [referenceId],
      contentDigest,
      verifiedAt: runtime.run.updatedAt,
      verifierId: 'host-verifier',
    },
    HOST_VERIFIER,
  );
}

function approve(
  runtime: WorkflowExecutionRuntime,
  targetId: string,
  approvedAt = T3,
): WorkflowExecutionRuntime {
  const request = getWorkflowHumanApprovalRequest(runtime, targetId);
  return approveWorkflowHumanDecision(runtime, {
    ...request,
    approvalId: `approval-${targetId}-${String(request.targetAttempt)}`,
    approvedBy: 'human-reviewer',
    approvedAt,
  });
}

function decideHumanReview(
  runtime: WorkflowExecutionRuntime,
  targetId: string,
  decision: 'approved' | 'changes-requested',
  decidedAt = T3,
): WorkflowExecutionRuntime {
  const request = getWorkflowHumanApprovalRequest(runtime, targetId);
  return recordWorkflowHumanReviewDecision(runtime, {
    ...request,
    decisionId: `decision-${targetId}-${String(request.targetAttempt)}`,
    decision,
    ...(decision === 'changes-requested'
      ? { feedback: 'Update the implementation and rerun the reviewed evidence.' }
      : {}),
    decidedBy: 'human-reviewer',
    decidedAt,
  });
}

function resolveEscape(
  runtime: WorkflowExecutionRuntime,
  loopId: string,
  decision: 'accept' | 'cancel',
  decidedAt = T4,
): WorkflowExecutionRuntime {
  return resolveRevisionEscape(runtime, {
    ...getRevisionEscapeRequest(runtime, loopId),
    decision,
    decidedBy: 'human-reviewer',
    decidedAt,
  });
}

function reviewAssessment(
  runtime: WorkflowExecutionRuntime,
  reviewEdgeId: string,
  verdict: 'approved' | 'changes-requested' = 'approved',
  reviewedOutputDigest = FIRST_DIGEST,
): ReviewerAssessment {
  const edge = runtime.canvas.edges.find((candidate) => candidate.id === reviewEdgeId);
  if (edge?.type !== 'review') throw new Error(`Missing review edge ${reviewEdgeId}`);
  const target = runtime.canvas.nodes.find((candidate) => candidate.id === edge.targetNodeId);
  const reviewerNodeId =
    edge.config.reviewer === 'agent'
      ? edge.targetNodeId
      : target?.type === 'review-gate'
        ? target.data.reviewerAgentId
        : undefined;
  if (reviewerNodeId === undefined) throw new Error('Missing reviewer agent');
  const reviewer = runtime.run.nodeRuns[reviewerNodeId];
  const reviewed = runtime.run.nodeRuns[edge.sourceNodeId];
  if (reviewer === undefined || reviewed === undefined)
    throw new Error('Missing review provenance');
  return {
    reviewerNodeId,
    reviewerAttempt: reviewer.attempt,
    reviewedNodeId: edge.sourceNodeId,
    reviewedNodeAttempt: reviewed.attempt,
    reviewedOutputDigest,
    verdict,
    findings: [],
  };
}

function recordReview(
  runtime: WorkflowExecutionRuntime,
  reviewEdgeId: string,
  verdict: 'approved' | 'changes-requested' = 'approved',
  reviewedOutputDigest = FIRST_DIGEST,
): WorkflowExecutionRuntime {
  return recordWorkflowReview(
    runtime,
    reviewEdgeId,
    reviewAssessment(runtime, reviewEdgeId, verdict, reviewedOutputDigest),
    HOST_VERIFIER,
  );
}

describe('scoped workflow planning and typed edge behavior', () => {
  it('plans one node, a selection, a group, and the complete workflow deterministically', () => {
    const graph = canvas({
      nodes: [taskNode('task-a'), taskNode('task-b'), taskNode('task-c')],
      edges: [
        {
          id: 'edge-ab',
          sourceNodeId: 'task-a',
          targetNodeId: 'task-b',
          type: 'dependency',
          config: {},
          createdAt: NOW,
        },
      ],
      groups: [
        {
          id: 'group-1',
          title: 'Build',
          nodeIds: ['task-b', 'task-c'],
          position: { x: 0, y: 0 },
          size: { width: 800, height: 500 },
          color: '#223344',
        },
      ],
    });
    expect(
      planWorkflowScope(graph, {
        planId: 'one',
        scope: { kind: 'node', nodeId: 'task-b' },
      }).nodeIds,
    ).toEqual(['task-a', 'task-b']);
    expect(
      planWorkflowScope(graph, {
        planId: 'selection',
        scope: { kind: 'selection', nodeIds: ['task-c'], includeUpstream: false },
      }).nodeIds,
    ).toEqual(['task-c']);
    expect(
      planWorkflowScope(graph, {
        planId: 'group',
        scope: { kind: 'group', groupId: 'group-1' },
      }).nodeIds,
    ).toEqual(['task-a', 'task-b', 'task-c']);
    expect(
      planWorkflowScope(graph, { planId: 'all', scope: { kind: 'workflow' } }).nodeIds,
    ).toEqual(['task-a', 'task-b', 'task-c']);
  });

  it('retains authoritative dependencies even when an isolated scope requests no upstream work', () => {
    const graph = canvas({
      nodes: [{ ...taskNode('outside-source'), status: 'failed' }, taskNode('isolated-target')],
      edges: [
        {
          id: 'outside-dependency',
          sourceNodeId: 'outside-source',
          targetNodeId: 'isolated-target',
          type: 'dependency',
          config: {},
          createdAt: NOW,
        },
      ],
    });
    const runtime = createWorkflowExecutionRuntime(graph, {
      planId: 'isolated-plan',
      runId: 'isolated-run',
      scope: { kind: 'node', nodeId: 'isolated-target', includeUpstream: false },
      occurredAt: NOW,
    });
    expect(runtime.plan.nodeIds).toEqual(['isolated-target', 'outside-source']);
    expect(runtime.plan.executableEdgeIds).toEqual(['outside-dependency']);
    expect(getSchedulingSnapshot(runtime).runnableNodeIds).toEqual(['outside-source']);
    expect(evaluateExecutableEdge(runtime, 'outside-dependency').disposition).toBe('waiting');
  });

  it('cannot isolate a Git/PR side effect from its deterministic review gate', () => {
    const graph = canvas({
      nodes: [
        taskNode('merge-source'),
        testNode('test-1'),
        {
          ...gateNode('merge-gate', 1),
          data: {
            humanApprovalRequired: false,
            requiredCheckIds: ['check-test'],
            testsRequired: true,
            retryPolicy: { maximumIterations: 1, backoffMs: 0 },
          },
        },
        {
          ...baseNode,
          id: 'merge-pr',
          type: 'git-pr',
          data: { worktreeId: 'worktree-1', branch: 'feature', baseBranch: 'main' },
        },
      ],
      edges: [
        {
          id: 'merge-check-input',
          sourceNodeId: 'merge-source',
          targetNodeId: 'test-1',
          type: 'output',
          config: { outputKind: 'diff', required: true },
          createdAt: NOW,
        },
        {
          id: 'merge-control',
          sourceNodeId: 'merge-source',
          targetNodeId: 'merge-pr',
          type: 'execute',
          config: { approval: 'review-gate', approvalGateNodeId: 'merge-gate' },
          createdAt: NOW,
        },
      ],
    });
    const runtime = createWorkflowExecutionRuntime(graph, {
      planId: 'isolated-merge-plan',
      runId: 'isolated-merge-run',
      scope: { kind: 'node', nodeId: 'merge-pr', includeUpstream: false },
      occurredAt: NOW,
    });

    expect(runtime.plan.nodeIds).toEqual(['merge-gate', 'merge-pr', 'merge-source', 'test-1']);
    expect(runtime.plan.executableEdgeIds).toEqual(['merge-check-input', 'merge-control']);
    expect(getSchedulingSnapshot(runtime).runnableNodeIds).not.toContain('merge-pr');
    expect(evaluateExecutableEdge(runtime, 'merge-control').disposition).toBe('waiting');
  });

  it('executes Context, Execute, Output, Review, Revision, and Dependency semantics', () => {
    const graph = canvas({
      nodes: [
        noteNode('brief-1'),
        taskNode('task-source'),
        taskNode('task-dependent'),
        agentNode('agent-1'),
        reviewerNode(),
        testNode('test-1'),
        gateNode('gate-1'),
      ],
      edges: [
        {
          id: 'context-edge',
          sourceNodeId: 'brief-1',
          targetNodeId: 'agent-1',
          type: 'context',
          config: { attachmentIds: ['attachment-1'] },
          createdAt: NOW,
        },
        {
          id: 'execute-edge',
          sourceNodeId: 'task-source',
          targetNodeId: 'agent-1',
          type: 'execute',
          config: { approval: 'human' },
          createdAt: NOW,
        },
        {
          id: 'dependency-edge',
          sourceNodeId: 'task-source',
          targetNodeId: 'task-dependent',
          type: 'dependency',
          config: {},
          createdAt: NOW,
        },
        {
          id: 'output-edge',
          sourceNodeId: 'agent-1',
          targetNodeId: 'test-1',
          type: 'output',
          config: { outputKind: 'diff' },
          createdAt: NOW,
        },
        {
          id: 'review-edge',
          sourceNodeId: 'agent-1',
          targetNodeId: 'gate-1',
          type: 'review',
          config: { reviewer: 'gate' },
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
          stopConditions: ['review-approved', 'human-accepted'],
          humanEscapeHatch: {
            enabled: true,
            approvalRequired: true,
            instructions: 'A human must accept or cancel the exhausted revision loop.',
          },
        },
      ],
    });
    let runtime = runtimeFor(graph);
    expect(evaluateExecutableEdge(runtime, 'context-edge').disposition).toBe('waiting');
    expect(() => contextAttachmentsForNode(runtime, 'agent-1')).toThrow(
      'has not been verified by the host',
    );
    expect(() =>
      recordWorkflowContextResolution(
        runtime,
        {
          edgeId: 'context-edge',
          runId: runtime.run.id,
          sourceNodeId: 'brief-1',
          targetNodeId: 'agent-1',
          targetAttempt: 1,
          attachmentIds: ['attachment-1'],
          contentDigest: 'sha256:context-attachment',
          verifiedAt: T1,
          verifierId: 'host-verifier',
        },
        { ...HOST_VERIFIER, verifyContextResolution: () => false },
      ),
    ).toThrow('Host verifier rejected');
    runtime = recordWorkflowContextResolution(
      runtime,
      {
        edgeId: 'context-edge',
        runId: runtime.run.id,
        sourceNodeId: 'brief-1',
        targetNodeId: 'agent-1',
        targetAttempt: 1,
        attachmentIds: ['attachment-1'],
        contentDigest: 'sha256:context-attachment',
        verifiedAt: T1,
        verifierId: 'host-verifier',
      },
      HOST_VERIFIER,
    );
    expect(evaluateExecutableEdge(runtime, 'context-edge').disposition).toBe('satisfied');
    expect(contextAttachmentsForNode(runtime, 'agent-1')).toEqual([
      {
        edgeId: 'context-edge',
        sourceNodeId: 'brief-1',
        sourceType: 'note-image',
        attachmentIds: ['attachment-1'],
        required: true,
        contentDigest: 'sha256:context-attachment',
        verifierId: 'host-verifier',
      },
    ]);
    expect(evaluateExecutableEdge(runtime, 'execute-edge').disposition).toBe('waiting');
    expect(evaluateExecutableEdge(runtime, 'dependency-edge').disposition).toBe('waiting');
    expect(evaluateExecutableEdge(runtime, 'output-edge').disposition).toBe('waiting');
    expect(evaluateExecutableEdge(runtime, 'review-edge').disposition).toBe('waiting');
    expect(evaluateExecutableEdge(runtime, 'revision-edge').disposition).toBe('inactive');
    expect(() => publish(runtime, 'output-edge', 'too-early')).toThrow(
      'Output source must succeed',
    );
    expect(() =>
      recordWorkflowReview(
        runtime,
        'review-edge',
        {
          reviewerNodeId: 'reviewer-agent',
          reviewerAttempt: 1,
          reviewedNodeId: 'agent-1',
          reviewedNodeAttempt: 1,
          reviewedOutputDigest: FIRST_DIGEST,
          verdict: 'approved',
          findings: [],
        },
        HOST_VERIFIER,
      ),
    ).toThrow('Review source must succeed');

    runtime = startWorkflowNode(runtime, 'task-source', process(101), T1);
    runtime = completeWorkflowNode(runtime, 'task-source', { status: 'succeeded' }, T2);
    expect(evaluateExecutableEdge(runtime, 'dependency-edge').disposition).toBe('satisfied');
    expect(evaluateExecutableEdge(runtime, 'execute-edge').disposition).toBe(
      'waiting-for-approval',
    );
    runtime = approve(runtime, 'execute-edge');
    expect(evaluateExecutableEdge(runtime, 'execute-edge').disposition).toBe('satisfied');
    runtime = startWorkflowNode(runtime, 'agent-1', process(102), T2);
    runtime = completeWorkflowNode(runtime, 'agent-1', { status: 'succeeded' }, T3);
    expect(() =>
      publishWorkflowOutput(
        runtime,
        {
          edgeId: 'output-edge',
          runId: runtime.run.id,
          producerNodeId: 'agent-1',
          producerAttempt: 1,
          outputKind: 'diff',
          referenceIds: ['rejected-diff'],
          contentDigest: FIRST_DIGEST,
          verifiedAt: T3,
          verifierId: 'host-verifier',
        },
        { ...HOST_VERIFIER, verifyOutputPublication: () => false },
      ),
    ).toThrow('Host verifier rejected');
    runtime = startWorkflowNode(runtime, 'reviewer-agent', process(103), T3);
    runtime = completeWorkflowNode(runtime, 'reviewer-agent', { status: 'succeeded' }, T3);
    expect(evaluateExecutableEdge(runtime, 'review-edge').disposition).toBe('waiting');
    expect(() =>
      recordWorkflowReview(
        runtime,
        'review-edge',
        { ...reviewAssessment(runtime, 'review-edge'), reviewerNodeId: 'wrong-reviewer' },
        HOST_VERIFIER,
      ),
    ).toThrow('configured reviewer reviewer-agent');
    runtime = recordReview(runtime, 'review-edge');
    expect(evaluateExecutableEdge(runtime, 'review-edge').disposition).toBe('satisfied');
    expect(evaluateExecutableEdge(runtime, 'output-edge').disposition).toBe('waiting');
    expect(() =>
      publishWorkflowOutput(
        runtime,
        {
          edgeId: 'output-edge',
          runId: runtime.run.id,
          producerNodeId: 'agent-1',
          producerAttempt: 1,
          outputKind: 'diff',
          referenceIds: [],
          contentDigest: FIRST_DIGEST,
          verifiedAt: T3,
          verifierId: 'host-verifier',
        },
        HOST_VERIFIER,
      ),
    ).toThrow();
    runtime = publish(runtime, 'output-edge', 'diff-1');
    expect(evaluateExecutableEdge(runtime, 'output-edge').disposition).toBe('satisfied');
    runtime = startWorkflowNode(runtime, 'test-1', process(104), T3);
    expect(() => publish(runtime, 'output-edge', 'late-diff')).toThrow(
      'before its planned consumer starts',
    );
  });

  it('requires a dedicated human-review decision and rejects generic approval', () => {
    const graph = canvas({
      nodes: [taskNode('source'), diffReviewNode('required-review')],
      edges: [
        {
          id: 'required-human-review',
          sourceNodeId: 'source',
          targetNodeId: 'required-review',
          type: 'review',
          config: { reviewer: 'human', requireApproval: true },
          createdAt: NOW,
        },
      ],
    });
    let runtime = runtimeFor(graph);
    expect(() => getWorkflowHumanApprovalRequest(runtime, 'required-human-review')).toThrow(
      'not currently waiting',
    );
    runtime = startWorkflowNode(runtime, 'source', process(151), T1);
    runtime = completeWorkflowNode(runtime, 'source', { status: 'succeeded' }, T2);

    expect(evaluateExecutableEdge(runtime, 'required-human-review').disposition).toBe(
      'waiting-for-approval',
    );
    const request = getWorkflowHumanApprovalRequest(runtime, 'required-human-review');
    expect(() =>
      approveWorkflowHumanDecision(runtime, {
        ...request,
        evidenceFingerprint: `${request.evidenceFingerprint}:tampered`,
        approvalId: 'tampered-approval',
        approvedBy: 'human-reviewer',
        approvedAt: T3,
      }),
    ).toThrow('does not match the current workflow decision');
    expect(() =>
      approveWorkflowHumanDecision(runtime, {
        ...request,
        approvalId: 'generic-human-review-approval',
        approvedBy: 'human-reviewer',
        approvedAt: T3,
      }),
    ).toThrow('require an explicit review decision');
    runtime = decideHumanReview(runtime, 'required-human-review', 'approved');
    expect(evaluateExecutableEdge(runtime, 'required-human-review').disposition).toBe('satisfied');
    expect(runtime.run.nodeRuns['required-review']).toMatchObject({ status: 'succeeded' });
  });

  it('keeps direct agent review authoritative until a current assessment is recorded', () => {
    const graph = canvas({
      nodes: [agentNode('implementation'), agentNode('direct-reviewer'), taskNode('downstream')],
      edges: [
        {
          id: 'direct-review',
          sourceNodeId: 'implementation',
          targetNodeId: 'direct-reviewer',
          type: 'review',
          config: { reviewer: 'agent', requireApproval: true, structuredFindings: false },
          createdAt: NOW,
        },
        {
          id: 'after-review',
          sourceNodeId: 'direct-reviewer',
          targetNodeId: 'downstream',
          type: 'execute',
          config: { trigger: 'on-completion' },
          createdAt: NOW,
        },
      ],
    });
    const completeReviewer = (): WorkflowExecutionRuntime => {
      let runtime = runtimeFor(graph);
      runtime = startWorkflowNode(runtime, 'implementation', process(161), T1);
      runtime = completeWorkflowNode(runtime, 'implementation', { status: 'succeeded' }, T2);
      runtime = startWorkflowNode(runtime, 'direct-reviewer', process(162), T2);
      return completeWorkflowNode(runtime, 'direct-reviewer', { status: 'succeeded' }, T3);
    };

    let approved = completeReviewer();
    expect(approved.run.nodeRuns['direct-reviewer']).toMatchObject({
      status: 'waiting-for-approval',
    });
    expect(evaluateExecutableEdge(approved, 'direct-review').disposition).toBe('waiting');
    expect(evaluateExecutableEdge(approved, 'after-review').disposition).toBe('waiting');
    expect(getSchedulingSnapshot(approved).runnableNodeIds).not.toContain('downstream');
    approved = recordReview(approved, 'direct-review');
    expect(evaluateExecutableEdge(approved, 'direct-review').disposition).toBe('satisfied');
    expect(evaluateExecutableEdge(approved, 'after-review').disposition).toBe('satisfied');
    expect(getSchedulingSnapshot(approved).runnableNodeIds).toContain('downstream');

    let changesRequested = completeReviewer();
    changesRequested = recordReview(changesRequested, 'direct-review', 'changes-requested');
    expect(evaluateExecutableEdge(changesRequested, 'direct-review').disposition).toBe('blocked');
    expect(changesRequested.run.nodeRuns['direct-reviewer']).toMatchObject({
      status: 'failed',
      failureCode: 'REVIEW_CHANGES_REQUESTED',
    });
    expect(changesRequested.run.nodeRuns['downstream']).toMatchObject({ status: 'cancelled' });
  });
});

describe('gate execution, bounded revisions, resources, cancellation, and recovery', () => {
  function reviewGraph(maximumAttempts = 2, humanApprovalRequired = false, backoffMs = 0): Canvas {
    return canvas({
      nodes: [
        agentNode('agent-1'),
        reviewerNode(),
        testNode('test-1'),
        gateNode('gate-1', maximumAttempts, humanApprovalRequired, backoffMs),
      ],
      edges: [
        {
          id: 'output-edge',
          sourceNodeId: 'agent-1',
          targetNodeId: 'test-1',
          type: 'output',
          config: { outputKind: 'diff' },
          createdAt: NOW,
        },
        {
          id: 'review-edge',
          sourceNodeId: 'agent-1',
          targetNodeId: 'gate-1',
          type: 'review',
          config: { reviewer: 'gate' },
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
          maximumAttempts,
          stopConditions: ['review-approved', 'tests-passed', 'human-accepted'],
          humanEscapeHatch: {
            enabled: true,
            approvalRequired: true,
            instructions: 'A human must accept or cancel after bounded attempts are exhausted.',
          },
        },
      ],
    });
  }

  it('cannot start a required check producer before its host-verified input timestamp', () => {
    let runtime = runtimeFor(reviewGraph());
    runtime = startWorkflowNode(runtime, 'agent-1', process(171), T1);
    runtime = completeWorkflowNode(runtime, 'agent-1', { status: 'succeeded' }, T2);
    runtime = publishWorkflowOutput(
      runtime,
      {
        edgeId: 'output-edge',
        runId: runtime.run.id,
        producerNodeId: 'agent-1',
        producerAttempt: 1,
        outputKind: 'diff',
        referenceIds: ['future-verified-diff'],
        contentDigest: FIRST_DIGEST,
        verifiedAt: T3,
        verifierId: 'host-verifier',
      },
      HOST_VERIFIER,
    );

    expect(() => startWorkflowNode(runtime, 'test-1', process(172), T2)).toThrow(
      'cannot start before incoming evidence is verified',
    );
  });

  it('advances a human review loop and clears its attempt-scoped decision before retry', () => {
    const graph = canvas({
      nodes: [agentNode('human-implementation'), diffReviewNode('human-review')],
      edges: [
        {
          id: 'human-output',
          sourceNodeId: 'human-implementation',
          targetNodeId: 'human-review',
          type: 'output',
          config: { outputKind: 'diff' },
          createdAt: NOW,
        },
        {
          id: 'human-review-edge',
          sourceNodeId: 'human-implementation',
          targetNodeId: 'human-review',
          type: 'review',
          config: { reviewer: 'human', requireApproval: true },
          createdAt: NOW,
        },
        {
          id: 'human-revision',
          sourceNodeId: 'human-review',
          targetNodeId: 'human-implementation',
          type: 'revision',
          config: { loopId: 'human-loop' },
          createdAt: NOW,
        },
      ],
      revisionLoops: [
        {
          id: 'human-loop',
          implementationNodeId: 'human-implementation',
          reviewNodeId: 'human-review',
          reviewEdgeId: 'human-review-edge',
          revisionEdgeId: 'human-revision',
          maximumAttempts: 2,
          stopConditions: ['review-approved', 'human-accepted'],
          humanEscapeHatch: {
            enabled: true,
            approvalRequired: true,
            instructions: 'A human resolves the exhausted human review loop.',
          },
        },
      ],
    });
    let runtime = runtimeFor(graph);
    runtime = startWorkflowNode(runtime, 'human-implementation', process(181), T1);
    runtime = completeWorkflowNode(runtime, 'human-implementation', { status: 'succeeded' }, T2);
    expect(() => getWorkflowHumanApprovalRequest(runtime, 'human-review-edge')).toThrow(
      'not currently waiting',
    );
    expect(getSchedulingSnapshot(runtime).waitingNodeIds).toContain('human-review');
    runtime = publish(runtime, 'human-output', 'human-diff-1');
    runtime = decideHumanReview(runtime, 'human-review-edge', 'changes-requested');
    expect(runtime.run.nodeRuns['human-review']).toMatchObject({ status: 'failed', attempt: 1 });

    const failedReview = applyRevisionReview(runtime, 'human-loop', T3);
    expect(failedReview.disposition).toBe('revision-required');
    runtime = queueRevisionAttempt(failedReview.runtime, 'human-loop', T3);
    expect(runtime.evidence.humanReviewDecisions['human-review-edge']).toBeUndefined();
    expect(runtime.run.nodeRuns['human-review']).toMatchObject({ status: 'queued', attempt: 2 });

    runtime = startWorkflowNode(runtime, 'human-implementation', process(182), T3);
    runtime = completeWorkflowNode(runtime, 'human-implementation', { status: 'succeeded' }, T4);
    runtime = publish(runtime, 'human-output', 'human-diff-2', SECOND_DIGEST);
    runtime = decideHumanReview(runtime, 'human-review-edge', 'approved', T4);
    const approvedReview = applyRevisionReview(runtime, 'human-loop', T4);
    expect(approvedReview.disposition).toBe('satisfied');
    expect(approvedReview.runtime.run.revisionLoops['human-loop']).toMatchObject({
      status: 'satisfied',
      stopCondition: 'review-approved',
    });
  });

  it('allows an explicit human escape to accept an exhausted human review loop', () => {
    const graph = canvas({
      nodes: [agentNode('human-implementation'), diffReviewNode('human-review')],
      edges: [
        {
          id: 'human-output',
          sourceNodeId: 'human-implementation',
          targetNodeId: 'human-review',
          type: 'output',
          config: { outputKind: 'diff' },
          createdAt: NOW,
        },
        {
          id: 'human-review-edge',
          sourceNodeId: 'human-implementation',
          targetNodeId: 'human-review',
          type: 'review',
          config: { reviewer: 'human', requireApproval: true },
          createdAt: NOW,
        },
        {
          id: 'human-revision',
          sourceNodeId: 'human-review',
          targetNodeId: 'human-implementation',
          type: 'revision',
          config: { loopId: 'human-loop' },
          createdAt: NOW,
        },
      ],
      revisionLoops: [
        {
          id: 'human-loop',
          implementationNodeId: 'human-implementation',
          reviewNodeId: 'human-review',
          reviewEdgeId: 'human-review-edge',
          revisionEdgeId: 'human-revision',
          maximumAttempts: 1,
          stopConditions: ['review-approved', 'human-accepted'],
          humanEscapeHatch: {
            enabled: true,
            approvalRequired: true,
            instructions: 'A human resolves the exhausted human review loop.',
          },
        },
      ],
    });
    let runtime = runtimeFor(graph);
    runtime = startWorkflowNode(runtime, 'human-implementation', process(191), T1);
    runtime = completeWorkflowNode(runtime, 'human-implementation', { status: 'succeeded' }, T2);
    runtime = publish(runtime, 'human-output', 'human-diff-exhausted');
    runtime = decideHumanReview(runtime, 'human-review-edge', 'changes-requested');

    const exhausted = applyRevisionReview(runtime, 'human-loop', T3);
    expect(exhausted).toMatchObject({ disposition: 'waiting-human' });
    expect(exhausted.runtime.run.nodeRuns['human-review']).toMatchObject({ status: 'failed' });

    const accepted = resolveEscape(exhausted.runtime, 'human-loop', 'accept');
    expect(accepted.run.revisionLoops['human-loop']).toMatchObject({
      status: 'satisfied',
      stopCondition: 'human-accepted',
    });
    expect(accepted.run.nodeRuns['human-review']).toMatchObject({
      status: 'succeeded',
      endedAt: T4,
    });
    expect(accepted.run.status).toBe('succeeded');
  });

  it('runs a test/reviewer gate, retries once, and cannot hide a failed test behind AI approval', () => {
    let runtime = runtimeFor(reviewGraph());
    expect(getSchedulingSnapshot(runtime).runnableNodeIds).not.toContain('reviewer-agent');
    expect(getSchedulingSnapshot(runtime).runnableNodeIds).not.toContain('test-1');
    runtime = startWorkflowNode(runtime, 'agent-1', process(201), T1);
    runtime = completeWorkflowNode(runtime, 'agent-1', { status: 'succeeded' }, T2);
    expect(() => startWorkflowNode(runtime, 'test-1', process(209), T2)).toThrow(
      'Waiting for required diff publication',
    );
    runtime = publish(runtime, 'output-edge', 'diff-first');
    runtime = startWorkflowNode(runtime, 'reviewer-agent', process(207), T2);
    expect(() => recordReview(runtime, 'review-edge')).toThrow(
      'must complete its planned agent run',
    );
    runtime = completeWorkflowNode(runtime, 'reviewer-agent', { status: 'succeeded' }, T3);
    runtime = startWorkflowNode(runtime, 'test-1', process(202), T2);
    runtime = completeWorkflowNode(runtime, 'test-1', { status: 'succeeded' }, T3);
    expect(() =>
      recordWorkflowGateChecks(
        runtime,
        'gate-1',
        [{ ...check('passed'), runId: 'other-run' }],
        HOST_VERIFIER,
      ),
    ).toThrow('must belong to the current workflow run');
    expect(() =>
      recordWorkflowGateChecks(
        runtime,
        'gate-1',
        [check('passed'), check('passed')],
        HOST_VERIFIER,
      ),
    ).toThrow('check IDs must be unique');
    const unprovenCheck = check('failed');
    delete unprovenCheck.producerNodeId;
    delete unprovenCheck.producerAttempt;
    expect(() =>
      recordWorkflowGateChecks(runtime, 'gate-1', [unprovenCheck], HOST_VERIFIER),
    ).toThrow('require producer node and attempt provenance');
    expect(() =>
      recordWorkflowGateChecks(
        runtime,
        'gate-1',
        [check('failed', 1, 1, 'sha256:not-the-consumed-output')],
        HOST_VERIFIER,
      ),
    ).toThrow('host-verified output consumed from the current reviewed attempt');
    runtime = recordWorkflowGateChecks(runtime, 'gate-1', [check('failed')], HOST_VERIFIER);
    runtime = recordWorkflowReview(
      runtime,
      'review-edge',
      {
        ...reviewAssessment(runtime, 'review-edge'),
        summary: 'The change looks good to the reviewer model.',
      },
      HOST_VERIFIER,
    );
    runtime = startWorkflowNode(runtime, 'gate-1', process(203), T3);
    const failedReview = applyRevisionReview(runtime, 'loop-1', T3);
    expect(failedReview).toMatchObject({
      disposition: 'revision-required',
      gate: { status: 'failed', deterministicStatus: 'failed', reviewerStatus: 'passed' },
    });
    runtime = completeWorkflowNode(
      failedReview.runtime,
      'gate-1',
      { status: 'failed', failureCode: 'CHECK_FAILED', reason: 'Deterministic test failed' },
      T3,
    );
    runtime = queueRevisionAttempt(runtime, 'loop-1', T3);
    expect(runtime.run.revisionLoops['loop-1']).toMatchObject({
      attemptsStarted: 2,
      status: 'review-required',
    });
    expect(runtime.run.nodeRuns['agent-1']).toMatchObject({ status: 'queued', attempt: 2 });
    expect(runtime.run.nodeRuns['test-1']).toMatchObject({ status: 'queued', attempt: 2 });
    expect(runtime.run.nodeRuns['reviewer-agent']).toMatchObject({ status: 'queued', attempt: 2 });
    expect(evaluateExecutableEdge(runtime, 'revision-edge').disposition).toBe('satisfied');
    expect(runtime.evidence.outputPublications).toEqual({});
    expect(runtime.evidence.reviewerAssessments).toEqual({});
    expect(runtime.evidence.gateChecks).toEqual({});

    runtime = startWorkflowNode(runtime, 'agent-1', process(204), T3);
    runtime = completeWorkflowNode(runtime, 'agent-1', { status: 'succeeded' }, T4);
    expect(() =>
      recordWorkflowGateChecks(runtime, 'gate-1', [check('passed')], HOST_VERIFIER),
    ).toThrow('stale producer attempt 1');
    expect(() =>
      recordWorkflowGateChecks(
        runtime,
        'gate-1',
        [check('passed', 2, 2, SECOND_DIGEST)],
        HOST_VERIFIER,
      ),
    ).toThrow('does not match producer status queued');
    runtime = publish(runtime, 'output-edge', 'diff-second', SECOND_DIGEST);
    runtime = startWorkflowNode(runtime, 'reviewer-agent', process(208), T4);
    runtime = completeWorkflowNode(runtime, 'reviewer-agent', { status: 'succeeded' }, T4);
    runtime = startWorkflowNode(runtime, 'test-1', process(206), T4);
    runtime = completeWorkflowNode(runtime, 'test-1', { status: 'succeeded' }, T4);
    runtime = recordWorkflowGateChecks(
      runtime,
      'gate-1',
      [check('passed', 2, 2, SECOND_DIGEST)],
      HOST_VERIFIER,
    );
    expect(() =>
      recordWorkflowReview(
        runtime,
        'review-edge',
        {
          ...reviewAssessment(runtime, 'review-edge', 'approved', SECOND_DIGEST),
          reviewerAttempt: 1,
        },
        HOST_VERIFIER,
      ),
    ).toThrow('stale reviewer attempt 1');
    runtime = recordReview(runtime, 'review-edge', 'approved', SECOND_DIGEST);
    runtime = startWorkflowNode(runtime, 'gate-1', process(205), T4);
    runtime = completeWorkflowNode(runtime, 'gate-1', { status: 'succeeded' }, T4);
    const passedReview = applyRevisionReview(runtime, 'loop-1', T4);
    expect(passedReview.disposition).toBe('satisfied');
    expect(passedReview.runtime.run.revisionLoops['loop-1']).toMatchObject({
      attemptsStarted: 2,
      status: 'satisfied',
      stopCondition: 'review-approved',
    });
  });

  it('requeues a missing required-check producer and rejects its prior-attempt evidence', () => {
    const secondTestNode = {
      ...baseNode,
      id: 'test-2',
      type: 'test' as const,
      data: {
        command: { executable: 'pnpm', args: ['test:second'] },
        runIds: ['check-second'],
      },
    };
    const graph = canvas({
      nodes: [
        agentNode('agent-1'),
        reviewerNode(),
        testNode('test-1'),
        secondTestNode,
        {
          ...gateNode('gate-1', 2),
          data: {
            humanApprovalRequired: false,
            requiredCheckIds: ['check-test', 'check-second'],
            reviewerAgentId: 'reviewer-agent',
            retryPolicy: { maximumIterations: 2, backoffMs: 0 },
          },
        },
      ],
      edges: [
        {
          id: 'output-edge',
          sourceNodeId: 'agent-1',
          targetNodeId: 'test-1',
          type: 'output',
          config: { outputKind: 'diff' },
          createdAt: NOW,
        },
        {
          id: 'second-output-edge',
          sourceNodeId: 'agent-1',
          targetNodeId: 'test-2',
          type: 'output',
          config: { outputKind: 'diff', required: true },
          createdAt: NOW,
        },
        {
          id: 'review-edge',
          sourceNodeId: 'agent-1',
          targetNodeId: 'gate-1',
          type: 'review',
          config: { reviewer: 'gate' },
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
            instructions: 'A human resolves the exhausted deterministic review loop.',
          },
        },
      ],
    });
    const secondCheck = (
      producerAttempt: number,
      reviewedNodeAttempt: number,
      reviewedOutputDigest: string,
    ): CheckResult => ({
      id: 'check-second',
      runId: 'run-1',
      producerNodeId: 'test-2',
      producerAttempt,
      reviewedNodeId: 'agent-1',
      reviewedNodeAttempt,
      reviewedOutputDigest,
      kind: 'custom',
      command: {
        executable: 'pnpm',
        args: ['test:second'],
        environmentNames: [],
      },
      status: 'passed',
    });

    let runtime = runtimeFor(graph);
    runtime = startWorkflowNode(runtime, 'agent-1', process(221), T1);
    runtime = completeWorkflowNode(runtime, 'agent-1', { status: 'succeeded' }, T2);
    runtime = publish(runtime, 'output-edge', 'first-two-check-diff');
    runtime = publish(runtime, 'second-output-edge', 'first-second-check-diff');
    runtime = startWorkflowNode(runtime, 'reviewer-agent', process(222), T2);
    runtime = completeWorkflowNode(runtime, 'reviewer-agent', { status: 'succeeded' }, T2);
    runtime = startWorkflowNode(runtime, 'test-1', process(223), T2);
    runtime = completeWorkflowNode(runtime, 'test-1', { status: 'succeeded' }, T2);
    runtime = startWorkflowNode(runtime, 'test-2', process(224), T2);
    runtime = completeWorkflowNode(runtime, 'test-2', { status: 'succeeded' }, T2);
    runtime = recordWorkflowGateChecks(runtime, 'gate-1', [check('failed')], HOST_VERIFIER);
    runtime = recordReview(runtime, 'review-edge');
    runtime = startWorkflowNode(runtime, 'gate-1', process(225), T2);
    const failed = applyRevisionReview(runtime, 'loop-1', T3);
    runtime = completeWorkflowNode(
      failed.runtime,
      'gate-1',
      { status: 'failed', failureCode: 'CHECK_FAILED', reason: 'First required check failed' },
      T3,
    );
    runtime = queueRevisionAttempt(runtime, 'loop-1', T3);
    expect(runtime.run.nodeRuns['test-2']).toMatchObject({ status: 'queued', attempt: 2 });

    runtime = startWorkflowNode(runtime, 'agent-1', process(226), T3);
    runtime = completeWorkflowNode(runtime, 'agent-1', { status: 'succeeded' }, T4);
    runtime = publish(runtime, 'output-edge', 'second-two-check-diff', SECOND_DIGEST);
    runtime = publish(runtime, 'second-output-edge', 'second-second-check-diff', SECOND_DIGEST);
    expect(() =>
      recordWorkflowGateChecks(
        runtime,
        'gate-1',
        [secondCheck(1, 2, SECOND_DIGEST)],
        HOST_VERIFIER,
      ),
    ).toThrow('stale producer attempt 1');
  });

  it('enforces the configured revision retry backoff', () => {
    let runtime = runtimeFor(reviewGraph(2, false, 1_000));
    runtime = startWorkflowNode(runtime, 'agent-1', process(241), T1);
    runtime = completeWorkflowNode(runtime, 'agent-1', { status: 'succeeded' }, T2);
    runtime = publish(runtime, 'output-edge', 'backoff-diff');
    runtime = startWorkflowNode(runtime, 'reviewer-agent', process(242), T2);
    runtime = completeWorkflowNode(runtime, 'reviewer-agent', { status: 'succeeded' }, T2);
    runtime = startWorkflowNode(runtime, 'test-1', process(243), T2);
    runtime = completeWorkflowNode(runtime, 'test-1', { status: 'succeeded' }, T2);
    runtime = recordWorkflowGateChecks(runtime, 'gate-1', [check('failed')], HOST_VERIFIER);
    runtime = recordReview(runtime, 'review-edge');
    runtime = startWorkflowNode(runtime, 'gate-1', process(244), T2);
    const failed = applyRevisionReview(runtime, 'loop-1', T3);
    expect(failed.runtime.run.revisionLoops['loop-1']?.eligibleAt).toBe('2026-07-14T12:03:01.000Z');
    runtime = completeWorkflowNode(
      failed.runtime,
      'gate-1',
      { status: 'failed', failureCode: 'CHECK_FAILED', reason: 'Backoff test failure' },
      T3,
    );
    expect(() => queueRevisionAttempt(runtime, 'loop-1', T3)).toThrow(
      'not eligible until 2026-07-14T12:03:01.000Z',
    );
    runtime = queueRevisionAttempt(runtime, 'loop-1', '2026-07-14T12:03:01.000Z');
    expect(runtime.run.revisionLoops['loop-1']).toMatchObject({
      attemptsStarted: 2,
      status: 'review-required',
    });
    expect(runtime.run.revisionLoops['loop-1']?.eligibleAt).toBeUndefined();
  });

  it('stops at the configured attempt bound and requires an explicit human escape', () => {
    let runtime = runtimeFor(reviewGraph(1));
    runtime = startWorkflowNode(runtime, 'agent-1', process(301), T1);
    runtime = completeWorkflowNode(runtime, 'agent-1', { status: 'succeeded' }, T2);
    runtime = publish(runtime, 'output-edge', 'diff-escape');
    runtime = startWorkflowNode(runtime, 'reviewer-agent', process(304), T2);
    runtime = completeWorkflowNode(runtime, 'reviewer-agent', { status: 'succeeded' }, T2);
    runtime = startWorkflowNode(runtime, 'test-1', process(303), T2);
    runtime = completeWorkflowNode(runtime, 'test-1', { status: 'succeeded' }, T2);
    runtime = recordWorkflowGateChecks(runtime, 'gate-1', [check('failed')], HOST_VERIFIER);
    runtime = recordReview(runtime, 'review-edge');
    runtime = startWorkflowNode(runtime, 'gate-1', process(302), T2);
    const result = applyRevisionReview(runtime, 'loop-1', T3);
    expect(result.disposition).toBe('waiting-human');
    expect(result.runtime.run.revisionLoops['loop-1']?.status).toBe('waiting-human');
    expect(() => queueRevisionAttempt(result.runtime, 'loop-1', T3)).toThrow(
      'A revision attempt is not currently allowed',
    );
    const accepted = resolveEscape(result.runtime, 'loop-1', 'accept');
    expect(accepted.run.revisionLoops['loop-1']).toMatchObject({
      status: 'satisfied',
      stopCondition: 'human-accepted',
    });
    expect(accepted.run.nodeRuns['gate-1']).toMatchObject({
      status: 'failed',
      endedAt: T4,
    });
    expect(accepted.run).toMatchObject({ status: 'failed', endedAt: T4 });
  });

  it('finalizes the reviewer and workflow when a human cancels an exhausted loop', () => {
    let runtime = runtimeFor(reviewGraph(1));
    runtime = startWorkflowNode(runtime, 'agent-1', process(321), T1);
    runtime = completeWorkflowNode(runtime, 'agent-1', { status: 'succeeded' }, T2);
    runtime = publish(runtime, 'output-edge', 'diff-cancel');
    runtime = startWorkflowNode(runtime, 'reviewer-agent', process(324), T2);
    runtime = completeWorkflowNode(runtime, 'reviewer-agent', { status: 'succeeded' }, T2);
    runtime = startWorkflowNode(runtime, 'test-1', process(322), T2);
    runtime = completeWorkflowNode(runtime, 'test-1', { status: 'succeeded' }, T2);
    runtime = recordWorkflowGateChecks(runtime, 'gate-1', [check('failed')], HOST_VERIFIER);
    runtime = recordReview(runtime, 'review-edge');
    runtime = startWorkflowNode(runtime, 'gate-1', process(323), T2);
    const exhausted = applyRevisionReview(runtime, 'loop-1', T3).runtime;
    let cancelled = resolveEscape(exhausted, 'loop-1', 'cancel');

    expect(cancelled.run.revisionLoops['loop-1']?.status).toBe('cancelled');
    expect(cancelled.run.nodeRuns['gate-1']).toMatchObject({
      status: 'cancelling',
    });
    cancelled = completeWorkflowNode(
      cancelled,
      'gate-1',
      { status: 'cancelled', reason: 'Reviewer process stopped after human cancellation' },
      T4,
    );
    expect(cancelled.run).toMatchObject({ status: 'cancelled', endedAt: T4 });
    expect(cancelled.cancellationRequested).toBe(true);
  });

  it('invalidates attempt-specific human gate approval before a revision retry', () => {
    let runtime = runtimeFor(reviewGraph(2, true));
    runtime = startWorkflowNode(runtime, 'agent-1', process(311), T1);
    runtime = completeWorkflowNode(runtime, 'agent-1', { status: 'succeeded' }, T2);
    runtime = publish(runtime, 'output-edge', 'diff-human-gate');
    runtime = startWorkflowNode(runtime, 'reviewer-agent', process(314), T2);
    runtime = completeWorkflowNode(runtime, 'reviewer-agent', { status: 'succeeded' }, T2);
    runtime = startWorkflowNode(runtime, 'test-1', process(313), T2);
    runtime = completeWorkflowNode(runtime, 'test-1', { status: 'succeeded' }, T2);
    runtime = recordWorkflowGateChecks(runtime, 'gate-1', [check('passed')], HOST_VERIFIER);
    runtime = recordReview(runtime, 'review-edge');
    runtime = approve(runtime, 'gate-1');
    expect(runtime.evidence.humanApprovals['gate-1']).toBeDefined();
    runtime = recordWorkflowGateChecks(runtime, 'gate-1', [check('failed')], HOST_VERIFIER);
    runtime = startWorkflowNode(runtime, 'gate-1', process(312), T2);
    const failed = applyRevisionReview(runtime, 'loop-1', T3);
    runtime = completeWorkflowNode(
      failed.runtime,
      'gate-1',
      { status: 'failed', failureCode: 'CHECK_FAILED', reason: 'Deterministic test failed' },
      T3,
    );
    runtime = queueRevisionAttempt(runtime, 'loop-1', T3);
    expect(runtime.evidence.humanApprovals['gate-1']).toBeUndefined();
  });

  it('keeps a parallel workflow active until every sibling reaches a terminal state', () => {
    let runtime = runtimeFor(canvas({ nodes: [taskNode('parallel-a'), taskNode('parallel-b')] }));
    runtime = startWorkflowNode(runtime, 'parallel-a', process(351), T1);
    runtime = startWorkflowNode(runtime, 'parallel-b', process(352), T1);
    runtime = completeWorkflowNode(
      runtime,
      'parallel-a',
      { status: 'failed', failureCode: 'FAILED_EARLY', reason: 'First sibling failed' },
      T2,
    );
    expect(runtime.run.status).toBe('running');
    expect(runtime.run.endedAt).toBeUndefined();

    runtime = completeWorkflowNode(runtime, 'parallel-b', { status: 'succeeded' }, T3);
    expect(runtime.run).toMatchObject({ status: 'failed', endedAt: T3 });
  });

  it('settles blocked descendants while an independent parallel sibling continues', () => {
    const graph = canvas({
      nodes: [taskNode('upstream'), taskNode('blocked-child'), taskNode('independent')],
      edges: [
        {
          id: 'required-dependency',
          sourceNodeId: 'upstream',
          targetNodeId: 'blocked-child',
          type: 'dependency',
          config: {},
          createdAt: NOW,
        },
      ],
    });
    let runtime = runtimeFor(graph);
    runtime = startWorkflowNode(runtime, 'upstream', process(361), T1);
    runtime = startWorkflowNode(runtime, 'independent', process(362), T1);
    runtime = completeWorkflowNode(
      runtime,
      'upstream',
      { status: 'failed', failureCode: 'UPSTREAM_FAILED', reason: 'Authoritative source failed' },
      T2,
    );

    expect(runtime.run.nodeRuns['blocked-child']).toMatchObject({
      status: 'cancelled',
      endedAt: T2,
    });
    expect(runtime.run.status).toBe('running');
    expect(runtime.run.endedAt).toBeUndefined();

    runtime = completeWorkflowNode(runtime, 'independent', { status: 'succeeded' }, T3);
    expect(runtime.run).toMatchObject({ status: 'failed', endedAt: T3 });
  });

  it('enforces live resource reservations and integrates cancellation and identity-safe recovery', () => {
    const graph = canvas({
      nodes: [
        taskNode('task-a', { cpuUnits: 1, memoryMb: 128, exclusiveKeys: ['port:4173'] }),
        taskNode('task-b', { cpuUnits: 1, memoryMb: 128, exclusiveKeys: ['port:4173'] }),
      ],
      limits: { maximumConcurrency: 2, maximumCpuUnits: 2, maximumMemoryMb: 512 },
    });
    let runtime = runtimeFor(graph);
    expect(getSchedulingSnapshot(runtime).runnableNodeIds).toEqual(['task-a']);
    runtime = startWorkflowNode(runtime, 'task-a', process(401), T1);
    expect(getSchedulingSnapshot(runtime)).toMatchObject({
      runnableNodeIds: [],
      activeNodeIds: ['task-a'],
      reserved: { concurrency: 1, cpuUnits: 1, memoryMb: 128 },
    });
    expect(() => startWorkflowNode(runtime, 'task-b', process(402), T1)).toThrow(
      'exceeds currently available workflow resources',
    );

    const mismatched = recoverWorkflowExecution(runtime, new Map([[401, 'wrong-token']]), T2);
    expect(mismatched.lostNodeIds).toEqual(['task-a']);
    expect(mismatched.runtime.run.nodeRuns['task-a']?.status).toBe('lost');

    const cancelled = cancelWorkflowExecution(runtime, T2);
    expect(cancelled.cancellationRequested).toBe(true);
    expect(cancelled.run.nodeRuns['task-a']?.status).toBe('cancelling');
    expect(cancelled.run.nodeRuns['task-b']?.status).toBe('cancelled');
    expect(getSchedulingSnapshot(cancelled).runnableNodeIds).toEqual([]);
  });
});
