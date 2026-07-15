import type { CanvasEdge, CanvasNode, CheckResult, RunStatus } from '../model/domain.js';
import {
  evaluateReviewGate,
  type ReviewGateEvaluation,
  type ReviewerAssessment,
} from '../workflow/gates.js';
import { isTerminalRunStatus } from '../workflow/model.js';

import { WorkflowHumanApprovalRequestSchema } from './schemas.js';
import type {
  OutputPublication,
  WorkflowExecutionRuntime,
  WorkflowHumanApprovalRequest,
  WorkflowHumanReviewDecision,
} from './types.js';
import { uniqueSorted } from './utils.js';

export function nodeById(runtime: WorkflowExecutionRuntime, nodeId: string): CanvasNode {
  const node = runtime.canvas.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Error(`Workflow node does not exist: ${nodeId}`);
  return node;
}

export function edgeById(runtime: WorkflowExecutionRuntime, edgeId: string): CanvasEdge {
  const edge = runtime.canvas.edges.find((candidate) => candidate.id === edgeId);
  if (edge === undefined) throw new Error(`Workflow edge does not exist: ${edgeId}`);
  return edge;
}

export function assertPlannedEdge(runtime: WorkflowExecutionRuntime, edge: CanvasEdge): void {
  if (!runtime.plan.executableEdgeIds.includes(edge.id)) {
    throw new Error(`Edge is outside the current scoped plan: ${edge.id}`);
  }
}

export function canvasNodeStatus(runtime: WorkflowExecutionRuntime, nodeId: string): RunStatus {
  const runStatus = runtime.run.nodeRuns[nodeId]?.status;
  if (runStatus !== undefined) {
    if (runStatus === 'succeeded') {
      const directReviews = runtime.canvas.edges.filter(
        (edge): edge is Extract<CanvasEdge, { type: 'review' }> =>
          edge.type === 'review' &&
          edge.config.reviewer === 'agent' &&
          edge.targetNodeId === nodeId &&
          runtime.plan.executableEdgeIds.includes(edge.id),
      );
      if (directReviews.length > 0) {
        const assessments = directReviews.map((edge) =>
          currentReviewerAssessmentForEdge(runtime, edge),
        );
        if (assessments.some((assessment) => assessment?.verdict === 'changes-requested')) {
          return 'failed';
        }
        if (assessments.some((assessment) => assessment?.verdict !== 'approved')) {
          return 'running';
        }
      }
    }
    return runStatus;
  }
  const status = nodeById(runtime, nodeId).status;
  if (status === 'draft' || status === 'ready') return 'queued';
  if (status === 'blocked') return 'failed';
  return status;
}

export function currentOutputPublicationsForNode(
  runtime: WorkflowExecutionRuntime,
  nodeId: string,
): readonly OutputPublication[] {
  const attempt = runtime.run.nodeRuns[nodeId]?.attempt;
  if (attempt === undefined) return [];
  return Object.values(runtime.evidence.outputPublications)
    .filter(
      (publication) =>
        publication.runId === runtime.run.id &&
        publication.producerNodeId === nodeId &&
        publication.producerAttempt === attempt,
    )
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

export function reviewedSourceIdsForGate(
  runtime: WorkflowExecutionRuntime,
  gateNodeId: string,
): readonly string[] {
  const sourceIds = new Set<string>();
  for (const edge of runtime.canvas.edges) {
    if (edge.type === 'review' && edge.targetNodeId === gateNodeId) {
      sourceIds.add(edge.sourceNodeId);
    }
    if (
      edge.type === 'execute' &&
      edge.config.approval === 'review-gate' &&
      edge.config.approvalGateNodeId === gateNodeId
    ) {
      sourceIds.add(edge.sourceNodeId);
    }
  }
  for (const loop of runtime.canvas.revisionLoops) {
    if (loop.reviewNodeId === gateNodeId) sourceIds.add(loop.implementationNodeId);
  }
  return uniqueSorted([...sourceIds]);
}

export function reviewedSourceForGate(
  runtime: WorkflowExecutionRuntime,
  gateNodeId: string,
): string {
  const sources = reviewedSourceIdsForGate(runtime, gateNodeId);
  if (sources.length !== 1) {
    throw new Error(`Review gate ${gateNodeId} does not have exactly one reviewed source`);
  }
  return sources[0]!;
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function approvalRequestUnchecked(
  runtime: WorkflowExecutionRuntime,
  targetId: string,
): WorkflowHumanApprovalRequest {
  const edge = runtime.canvas.edges.find((candidate) => candidate.id === targetId);
  const gate = runtime.canvas.nodes.find((candidate) => candidate.id === targetId);
  let targetType: WorkflowHumanApprovalRequest['targetType'];
  let targetNodeId: string;
  let reviewedNodeIds: readonly string[];
  if (edge?.type === 'execute' && edge.config.approval === 'human') {
    targetType = 'execute-edge';
    targetNodeId = edge.targetNodeId;
    reviewedNodeIds = [edge.sourceNodeId];
  } else if (
    edge?.type === 'review' &&
    edge.config.reviewer === 'human' &&
    edge.config.requireApproval
  ) {
    targetType = 'human-review';
    targetNodeId = edge.targetNodeId;
    reviewedNodeIds = [edge.sourceNodeId];
  } else if (gate?.type === 'review-gate' && gate.data.humanApprovalRequired) {
    targetType = 'review-gate';
    targetNodeId = gate.id;
    reviewedNodeIds = reviewedSourceIdsForGate(runtime, gate.id);
  } else {
    throw new Error(`No human approval is configured for ${targetId}`);
  }
  const targetRun = runtime.run.nodeRuns[targetNodeId];
  if (targetRun === undefined) {
    throw new Error(`Human approval target is outside the current scoped plan: ${targetId}`);
  }
  const reviewedRuns = Object.fromEntries(
    reviewedNodeIds.map((nodeId) => {
      const nodeRun = runtime.run.nodeRuns[nodeId];
      return [
        nodeId,
        nodeRun === undefined
          ? null
          : { attempt: nodeRun.attempt, status: nodeRun.status, endedAt: nodeRun.endedAt ?? null },
      ];
    }),
  );
  const relevantOutputs = Object.fromEntries(
    Object.entries(runtime.evidence.outputPublications).filter(([, publication]) => {
      const producerRun = runtime.run.nodeRuns[publication.producerNodeId];
      return (
        publication.runId === runtime.run.id &&
        reviewedNodeIds.includes(publication.producerNodeId) &&
        publication.producerAttempt === producerRun?.attempt
      );
    }),
  );
  const relevantContexts = Object.fromEntries(
    Object.entries(runtime.evidence.contextResolutions).filter(
      ([, resolution]) => resolution.targetNodeId === targetNodeId,
    ),
  );
  const relevantChecks = gate?.type === 'review-gate' ? currentGateChecks(runtime, gate.id) : [];
  const relevantAssessments = Object.fromEntries(
    runtime.canvas.edges.flatMap((reviewEdge) => {
      if (reviewEdge.type !== 'review' || !reviewedNodeIds.includes(reviewEdge.sourceNodeId)) {
        return [];
      }
      const assessment = currentReviewerAssessmentForEdge(runtime, reviewEdge);
      return assessment === undefined ? [] : [[reviewEdge.id, assessment] as const];
    }),
  );
  const evidenceFingerprint = `workflow-approval-v1:${JSON.stringify(
    stableValue({
      runId: runtime.run.id,
      targetId,
      targetType,
      targetAttempt: targetRun.attempt,
      reviewedRuns,
      relevantOutputs,
      relevantContexts,
      relevantChecks,
      relevantAssessments,
    }),
  )}`;
  return WorkflowHumanApprovalRequestSchema.parse({
    runId: runtime.run.id,
    targetId,
    targetType,
    targetAttempt: targetRun.attempt,
    evidenceFingerprint,
  });
}

export function hasCurrentHumanApproval(
  runtime: WorkflowExecutionRuntime,
  targetId: string,
): boolean {
  const approval = runtime.evidence.humanApprovals[targetId];
  if (approval === undefined) return false;
  try {
    const expected = approvalRequestUnchecked(runtime, targetId);
    return (
      approval.runId === expected.runId &&
      approval.targetId === expected.targetId &&
      approval.targetType === expected.targetType &&
      approval.targetAttempt === expected.targetAttempt &&
      approval.evidenceFingerprint === expected.evidenceFingerprint
    );
  } catch {
    return false;
  }
}

export function currentHumanReviewDecision(
  runtime: WorkflowExecutionRuntime,
  edgeId: string,
): WorkflowHumanReviewDecision | undefined {
  const decision = runtime.evidence.humanReviewDecisions[edgeId];
  if (decision === undefined) return undefined;
  try {
    const expected = approvalRequestUnchecked(runtime, edgeId);
    return decision.runId === expected.runId &&
      decision.targetType === 'human-review' &&
      decision.targetAttempt === expected.targetAttempt &&
      decision.evidenceFingerprint === expected.evidenceFingerprint
      ? decision
      : undefined;
  } catch {
    return undefined;
  }
}

export function currentReviewerAssessmentForEdge(
  runtime: WorkflowExecutionRuntime,
  edge: Extract<CanvasEdge, { type: 'review' }>,
): ReviewerAssessment | undefined {
  const assessment = runtime.evidence.reviewerAssessments[edge.id];
  if (assessment === undefined || edge.config.reviewer === 'human') return undefined;
  const target = nodeById(runtime, edge.targetNodeId);
  const expectedReviewerId =
    edge.config.reviewer === 'agent'
      ? edge.targetNodeId
      : target.type === 'review-gate'
        ? target.data.reviewerAgentId
        : undefined;
  const reviewerRun =
    expectedReviewerId === undefined ? undefined : runtime.run.nodeRuns[expectedReviewerId];
  const reviewedRun = runtime.run.nodeRuns[edge.sourceNodeId];
  if (
    expectedReviewerId === undefined ||
    assessment.reviewerNodeId !== expectedReviewerId ||
    (reviewerRun?.status !== 'succeeded' &&
      reviewerRun?.status !== 'waiting-for-approval' &&
      !(
        reviewerRun?.status === 'failed' && reviewerRun.failureCode === 'REVIEW_CHANGES_REQUESTED'
      )) ||
    assessment.reviewerAttempt !== reviewerRun.attempt ||
    reviewedRun?.status !== 'succeeded' ||
    canvasNodeStatus(runtime, edge.sourceNodeId) !== 'succeeded' ||
    assessment.reviewedNodeId !== edge.sourceNodeId ||
    assessment.reviewedNodeAttempt !== reviewedRun.attempt
  ) {
    return undefined;
  }
  const currentDigests = currentOutputPublicationsForNode(runtime, edge.sourceNodeId).map(
    (publication) => publication.contentDigest,
  );
  return currentDigests.length === 0 || currentDigests.includes(assessment.reviewedOutputDigest)
    ? assessment
    : undefined;
}

export function currentCausalCheckPublications(
  runtime: WorkflowExecutionRuntime,
  reviewedNodeId: string,
  producerNodeId: string,
): readonly OutputPublication[] {
  const reviewedAttempt = runtime.run.nodeRuns[reviewedNodeId]?.attempt;
  return runtime.canvas.edges.flatMap((edge) => {
    if (
      edge.type !== 'output' ||
      !edge.config.required ||
      edge.sourceNodeId !== reviewedNodeId ||
      edge.targetNodeId !== producerNodeId ||
      !runtime.plan.executableEdgeIds.includes(edge.id)
    ) {
      return [];
    }
    const publication = runtime.evidence.outputPublications[edge.id];
    return publication?.runId === runtime.run.id &&
      publication.producerNodeId === reviewedNodeId &&
      publication.producerAttempt === reviewedAttempt &&
      publication.outputKind === edge.config.outputKind
      ? [publication]
      : [];
  });
}

export function currentGateChecks(
  runtime: WorkflowExecutionRuntime,
  gateNodeId: string,
): readonly CheckResult[] {
  const gate = nodeById(runtime, gateNodeId);
  if (gate.type !== 'review-gate') throw new Error(`Node is not a review gate: ${gateNodeId}`);
  if (
    gate.data.requiredCheckIds.length === 0 &&
    !gate.data.testsRequired &&
    !gate.data.lintRequired
  ) {
    return [];
  }
  const reviewedNodeId = reviewedSourceForGate(runtime, gateNodeId);
  const reviewedRun = runtime.run.nodeRuns[reviewedNodeId];
  if (
    reviewedRun?.status !== 'succeeded' ||
    canvasNodeStatus(runtime, reviewedNodeId) !== 'succeeded'
  ) {
    return [];
  }
  const expectedProducerStatuses: Readonly<Record<CheckResult['status'], readonly RunStatus[]>> = {
    queued: ['queued'],
    running: ['running'],
    passed: ['succeeded'],
    failed: ['succeeded', 'failed'],
    cancelled: ['cancelled'],
    lost: ['lost'],
  };
  return (runtime.evidence.gateChecks[gateNodeId] ?? []).filter((check) => {
    const producerRun =
      check.producerNodeId === undefined ? undefined : runtime.run.nodeRuns[check.producerNodeId];
    const causalPublications =
      check.producerNodeId === undefined
        ? []
        : currentCausalCheckPublications(runtime, reviewedNodeId, check.producerNodeId);
    return (
      check.runId === runtime.run.id &&
      producerRun !== undefined &&
      check.producerAttempt === producerRun.attempt &&
      expectedProducerStatuses[check.status].includes(producerRun.status) &&
      check.reviewedNodeId === reviewedNodeId &&
      check.reviewedNodeAttempt === reviewedRun.attempt &&
      check.reviewedOutputDigest !== undefined &&
      causalPublications.some(
        (publication) =>
          publication.contentDigest === check.reviewedOutputDigest &&
          (producerRun.startedAt === undefined ||
            Date.parse(publication.verifiedAt) <= Date.parse(producerRun.startedAt)),
      )
    );
  });
}

export function reviewGateEvaluation(
  runtime: WorkflowExecutionRuntime,
  gateNodeId: string,
): ReviewGateEvaluation {
  const gate = nodeById(runtime, gateNodeId);
  if (gate.type !== 'review-gate') throw new Error(`Node is not a review gate: ${gateNodeId}`);
  const reviewerAssessment = runtime.canvas.edges
    .flatMap((edge) =>
      edge.type === 'review' && edge.targetNodeId === gateNodeId
        ? [currentReviewerAssessmentForEdge(runtime, edge)]
        : [],
    )
    .find((assessment) => assessment?.reviewerNodeId === gate.data.reviewerAgentId);
  return evaluateReviewGate(gate, {
    checks: currentGateChecks(runtime, gateNodeId),
    ...(reviewerAssessment === undefined ? {} : { reviewerAssessment }),
    humanApproved: hasCurrentHumanApproval(runtime, gateNodeId),
  });
}

export function completed(status: RunStatus): boolean {
  return isTerminalRunStatus(status);
}
