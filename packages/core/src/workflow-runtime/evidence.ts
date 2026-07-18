import {
  CheckResultSchema,
  type CanvasEdge,
  type CheckResult,
  type RunStatus,
} from '../model/domain.js';
import { ReviewerAssessmentSchema, type ReviewerAssessment } from '../workflow/gates.js';
import { NodeRunStateSchema } from '../workflow/model.js';

import {
  approvalRequestUnchecked,
  assertPlannedEdge,
  canvasNodeStatus,
  currentCausalCheckPublications,
  currentOutputPublicationsForNode,
  currentReviewerAssessmentForEdge,
  edgeById,
  hasCurrentHumanApproval,
  nodeById,
  reviewedSourceForGate,
  reviewGateEvaluation,
} from './evidence-state.js';
import { evaluateExecutableEdge } from './evaluation.js';
import {
  ContextResolutionSchema,
  OutputPublicationSchema,
  WorkflowHumanApprovalSchema,
  WorkflowHumanReviewDecisionSchema,
} from './schemas.js';
import { replaceRunState, settleBlockedWorkflowNodes } from './scheduling.js';
import type {
  ContextResolution,
  OutputPublication,
  WorkflowEvidenceVerifier,
  WorkflowExecutionRuntime,
  WorkflowHumanApproval,
  WorkflowHumanApprovalRequest,
  WorkflowHumanReviewDecision,
} from './types.js';
import { uniqueSorted } from './utils.js';

export function getWorkflowHumanApprovalRequest(
  runtime: WorkflowExecutionRuntime,
  targetId: string,
): WorkflowHumanApprovalRequest {
  const edge = runtime.canvas.edges.find((candidate) => candidate.id === targetId);
  const gate = runtime.canvas.nodes.find((candidate) => candidate.id === targetId);
  if (edge !== undefined && !runtime.plan.executableEdgeIds.includes(edge.id)) {
    throw new Error(`Human approval target is outside the current scoped plan: ${targetId}`);
  }
  if (hasCurrentHumanApproval(runtime, targetId)) {
    throw new Error(`Human approval target is not currently waiting: ${targetId}`);
  }
  const waiting =
    edge !== undefined
      ? evaluateExecutableEdge(runtime, edge).disposition === 'waiting-for-approval' &&
        runtime.canvas.edges
          .filter(
            (candidate) =>
              candidate.id !== edge.id &&
              candidate.targetNodeId === edge.targetNodeId &&
              candidate.type !== 'revision' &&
              runtime.plan.executableEdgeIds.includes(candidate.id),
          )
          .map((candidate) => evaluateExecutableEdge(runtime, candidate))
          .every(
            (evaluation) =>
              evaluation.disposition !== 'waiting' &&
              evaluation.disposition !== 'blocked' &&
              evaluation.status !== 'failed' &&
              evaluation.status !== 'lost' &&
              evaluation.status !== 'cancelled',
          )
      : gate?.type === 'review-gate' &&
        runtime.run.nodeRuns[gate.id] !== undefined &&
        reviewGateEvaluation(runtime, gate.id).status === 'waiting-human';
  if (!waiting) throw new Error(`Human approval target is not currently waiting: ${targetId}`);
  return approvalRequestUnchecked(runtime, targetId);
}

export function approveWorkflowHumanDecision(
  runtime: WorkflowExecutionRuntime,
  untrustedApproval: WorkflowHumanApproval,
): WorkflowExecutionRuntime {
  const approval = WorkflowHumanApprovalSchema.parse(untrustedApproval);
  const expected = getWorkflowHumanApprovalRequest(runtime, approval.targetId);
  if (
    approval.runId !== expected.runId ||
    approval.targetType !== expected.targetType ||
    approval.targetAttempt !== expected.targetAttempt ||
    approval.evidenceFingerprint !== expected.evidenceFingerprint
  ) {
    throw new Error('Human approval does not match the current workflow decision');
  }
  if (expected.targetType === 'human-review') {
    throw new Error('Human review edges require an explicit review decision');
  }
  return {
    ...runtime,
    evidence: {
      ...runtime.evidence,
      humanApprovals: {
        ...runtime.evidence.humanApprovals,
        [approval.targetId]: approval,
      },
    },
  };
}

export function recordWorkflowHumanReviewDecision(
  runtime: WorkflowExecutionRuntime,
  untrustedDecision: WorkflowHumanReviewDecision,
): WorkflowExecutionRuntime {
  const decision = WorkflowHumanReviewDecisionSchema.parse(untrustedDecision);
  const expected = getWorkflowHumanApprovalRequest(runtime, decision.targetId);
  if (
    expected.targetType !== 'human-review' ||
    decision.runId !== expected.runId ||
    decision.targetAttempt !== expected.targetAttempt ||
    decision.evidenceFingerprint !== expected.evidenceFingerprint
  ) {
    throw new Error('Human review decision does not match the current reviewed evidence');
  }
  const edge = edgeById(runtime, decision.targetId);
  if (edge.type !== 'review' || edge.config.reviewer !== 'human') {
    throw new Error('Human review decision target is not a human review edge');
  }
  const current = runtime.run.nodeRuns[edge.targetNodeId];
  if (
    current === undefined ||
    (current.status !== 'queued' && current.status !== 'waiting-for-approval')
  ) {
    throw new Error('Human review target is not awaiting a decision');
  }
  const completedReview = NodeRunStateSchema.parse({
    nodeId: current.nodeId,
    status: decision.decision === 'approved' ? 'succeeded' : 'failed',
    attempt: current.attempt,
    queuedAt: current.queuedAt,
    endedAt: decision.decidedAt,
    resumable: current.resumable,
    ...(decision.decision === 'changes-requested'
      ? { failureCode: 'HUMAN_CHANGES_REQUESTED' }
      : {}),
    statusReason:
      decision.decision === 'approved' ? 'You approved the reviewed result' : decision.feedback,
  });
  const decidedRuntime = replaceRunState(
    runtime,
    { ...runtime.run.nodeRuns, [edge.targetNodeId]: completedReview },
    decision.decidedAt,
  );
  return settleBlockedWorkflowNodes(
    {
      ...decidedRuntime,
      evidence: {
        ...decidedRuntime.evidence,
        humanReviewDecisions: {
          ...decidedRuntime.evidence.humanReviewDecisions,
          [edge.id]: decision,
        },
      },
    },
    decision.decidedAt,
  );
}

export function recordWorkflowContextResolution(
  runtime: WorkflowExecutionRuntime,
  untrustedResolution: ContextResolution,
  verifier: WorkflowEvidenceVerifier,
): WorkflowExecutionRuntime {
  const resolution = ContextResolutionSchema.parse(untrustedResolution);
  const edge = edgeById(runtime, resolution.edgeId);
  if (edge.type !== 'context') throw new Error(`Edge is not a context edge: ${resolution.edgeId}`);
  assertPlannedEdge(runtime, edge);
  const targetRun = runtime.run.nodeRuns[edge.targetNodeId];
  if (targetRun === undefined) throw new Error('Context target is outside the scoped plan');
  if (targetRun.status !== 'queued' && targetRun.status !== 'waiting-for-approval') {
    throw new Error('Context must be verified before the target starts');
  }
  if (
    resolution.runId !== runtime.run.id ||
    resolution.sourceNodeId !== edge.sourceNodeId ||
    resolution.targetNodeId !== edge.targetNodeId ||
    resolution.targetAttempt !== targetRun.attempt ||
    JSON.stringify(uniqueSorted(resolution.attachmentIds)) !==
      JSON.stringify(uniqueSorted(edge.config.attachmentIds))
  ) {
    throw new Error(
      'Context resolution does not match the current planned edge and target attempt',
    );
  }
  if (!verifier.verifyContextResolution(resolution)) {
    throw new Error('Host verifier rejected the context resolution');
  }
  return {
    ...runtime,
    evidence: {
      ...runtime.evidence,
      contextResolutions: {
        ...runtime.evidence.contextResolutions,
        [edge.id]: resolution,
      },
    },
  };
}

export function recordWorkflowGateChecks(
  runtime: WorkflowExecutionRuntime,
  gateNodeId: string,
  checks: readonly CheckResult[],
  verifier: WorkflowEvidenceVerifier,
): WorkflowExecutionRuntime {
  const gate = nodeById(runtime, gateNodeId);
  if (gate.type !== 'review-gate') throw new Error(`Node is not a review gate: ${gateNodeId}`);
  const gateRun = runtime.run.nodeRuns[gateNodeId];
  if (gateRun === undefined) {
    throw new Error(`Review gate is outside the current scoped plan: ${gateNodeId}`);
  }
  if (gateRun.status !== 'queued' && gateRun.status !== 'waiting-for-approval') {
    throw new Error('Review-gate checks must be recorded before the gate starts');
  }
  const parsedChecks = checks.map((check) => CheckResultSchema.parse(check));
  if (parsedChecks.some((check) => check.runId !== runtime.run.id)) {
    throw new Error('Review-gate checks must belong to the current workflow run');
  }
  if (new Set(parsedChecks.map((check) => check.id)).size !== parsedChecks.length) {
    throw new Error('Review-gate check IDs must be unique');
  }
  const reviewedNodeId = reviewedSourceForGate(runtime, gateNodeId);
  const reviewedRun = runtime.run.nodeRuns[reviewedNodeId];
  if (
    reviewedRun?.status !== 'succeeded' ||
    canvasNodeStatus(runtime, reviewedNodeId) !== 'succeeded'
  ) {
    throw new Error('Review-gate checks require the current reviewed source attempt to succeed');
  }
  for (const check of parsedChecks) {
    if (!gate.data.requiredCheckIds.includes(check.id)) {
      throw new Error(`Check ${check.id} is not configured as required by gate ${gateNodeId}`);
    }
    if (check.producerNodeId === undefined || check.producerAttempt === undefined) {
      throw new Error('Review-gate checks require producer node and attempt provenance');
    }
    const producerNode = nodeById(runtime, check.producerNodeId);
    const producerRun = runtime.run.nodeRuns[check.producerNodeId];
    if (producerNode.type !== 'test' || producerRun === undefined) {
      throw new Error(`Check producer must be a planned test node: ${check.producerNodeId}`);
    }
    if (!producerNode.data.runIds.includes(check.id)) {
      throw new Error(`Check ${check.id} is not registered to producer ${check.producerNodeId}`);
    }
    if (producerRun.attempt !== check.producerAttempt) {
      throw new Error(
        `Check ${check.id} belongs to stale producer attempt ${String(check.producerAttempt)}; current attempt is ${String(producerRun.attempt)}`,
      );
    }
    if (
      check.reviewedNodeId !== reviewedNodeId ||
      check.reviewedNodeAttempt !== reviewedRun.attempt ||
      check.reviewedOutputDigest === undefined
    ) {
      throw new Error(
        `Check ${check.id} is not bound to reviewed source ${reviewedNodeId} attempt ${String(reviewedRun.attempt)}`,
      );
    }
    const expectedProducerStatuses: Readonly<Record<CheckResult['status'], readonly RunStatus[]>> =
      {
        queued: ['queued'],
        running: ['running'],
        passed: ['succeeded'],
        // A test runner may exit normally while reporting failed assertions as structured evidence.
        failed: ['succeeded', 'failed'],
        cancelled: ['cancelled'],
        lost: ['lost'],
      };
    if (!expectedProducerStatuses[check.status].includes(producerRun.status)) {
      throw new Error(
        `Check ${check.id} status ${check.status} does not match producer status ${producerRun.status}`,
      );
    }
    const causalPublication = currentCausalCheckPublications(
      runtime,
      reviewedNodeId,
      check.producerNodeId,
    ).find((publication) => publication.contentDigest === check.reviewedOutputDigest);
    if (causalPublication === undefined) {
      throw new Error(
        `Check ${check.id} does not match a host-verified output consumed from the current reviewed attempt`,
      );
    }
    if (
      producerRun.startedAt !== undefined &&
      Date.parse(causalPublication.verifiedAt) > Date.parse(producerRun.startedAt)
    ) {
      throw new Error(`Check ${check.id} producer started before its reviewed output was verified`);
    }
    if (JSON.stringify(check.command) !== JSON.stringify(producerNode.data.command)) {
      throw new Error(`Check ${check.id} command does not match its configured producer`);
    }
    if (!verifier.verifyCheckResult(check)) {
      throw new Error(`Host verifier rejected check ${check.id}`);
    }
  }
  return {
    ...runtime,
    evidence: {
      ...runtime.evidence,
      gateChecks: { ...runtime.evidence.gateChecks, [gateNodeId]: parsedChecks },
    },
  };
}

export function publishWorkflowOutput(
  runtime: WorkflowExecutionRuntime,
  untrustedPublication: OutputPublication,
  verifier: WorkflowEvidenceVerifier,
): WorkflowExecutionRuntime {
  const publication = OutputPublicationSchema.parse(untrustedPublication);
  const edge = edgeById(runtime, publication.edgeId);
  if (edge.type !== 'output') throw new Error(`Edge is not an output edge: ${publication.edgeId}`);
  assertPlannedEdge(runtime, edge);
  if (canvasNodeStatus(runtime, edge.sourceNodeId) !== 'succeeded') {
    throw new Error(`Output source must succeed before publication: ${edge.sourceNodeId}`);
  }
  const targetRun = runtime.run.nodeRuns[edge.targetNodeId];
  if (
    targetRun === undefined ||
    (targetRun.status !== 'queued' && targetRun.status !== 'waiting-for-approval')
  ) {
    throw new Error('Output must be verified before its planned consumer starts');
  }
  const sourceRun = runtime.run.nodeRuns[edge.sourceNodeId]!;
  if (
    publication.runId !== runtime.run.id ||
    publication.producerNodeId !== edge.sourceNodeId ||
    publication.producerAttempt !== sourceRun.attempt
  ) {
    throw new Error('Output publication is not bound to the current source attempt');
  }
  if (edge.config.outputKind !== publication.outputKind) {
    throw new Error(
      `Output kind mismatch for ${edge.id}: expected ${edge.config.outputKind}, received ${publication.outputKind}`,
    );
  }
  if (!verifier.verifyOutputPublication(publication)) {
    throw new Error(`Host verifier rejected output publication ${publication.edgeId}`);
  }
  return {
    ...runtime,
    evidence: {
      ...runtime.evidence,
      outputPublications: {
        ...runtime.evidence.outputPublications,
        [edge.id]: publication,
      },
    },
  };
}

export function recordWorkflowReview(
  runtime: WorkflowExecutionRuntime,
  reviewEdgeId: string,
  untrustedAssessment: ReviewerAssessment,
  verifier: WorkflowEvidenceVerifier,
): WorkflowExecutionRuntime {
  const edge = edgeById(runtime, reviewEdgeId);
  if (edge.type !== 'review') throw new Error(`Edge is not a review edge: ${reviewEdgeId}`);
  assertPlannedEdge(runtime, edge);
  const sourceRun = runtime.run.nodeRuns[edge.sourceNodeId];
  if (
    sourceRun?.status !== 'succeeded' ||
    canvasNodeStatus(runtime, edge.sourceNodeId) !== 'succeeded'
  ) {
    throw new Error(`Review source must succeed before assessment: ${edge.sourceNodeId}`);
  }
  const assessment = ReviewerAssessmentSchema.parse(untrustedAssessment);
  if (edge.config.reviewer === 'human') {
    throw new Error('Human review decisions must use the explicit human approval action');
  }
  const target = nodeById(runtime, edge.targetNodeId);
  const targetRun = runtime.run.nodeRuns[edge.targetNodeId];
  if (
    target.type === 'review-gate' &&
    targetRun?.status !== 'queued' &&
    targetRun?.status !== 'waiting-for-approval'
  ) {
    throw new Error('Gate reviewer assessment must be recorded before the gate starts');
  }
  const expectedReviewerId =
    edge.config.reviewer === 'agent'
      ? edge.targetNodeId
      : target.type === 'review-gate'
        ? target.data.reviewerAgentId
        : undefined;
  if (expectedReviewerId === undefined) {
    throw new Error(`Review edge ${reviewEdgeId} has no configured agent reviewer`);
  }
  if (assessment.reviewerNodeId !== expectedReviewerId) {
    throw new Error(`Review assessment must come from configured reviewer ${expectedReviewerId}`);
  }
  const reviewerNode = nodeById(runtime, expectedReviewerId);
  const reviewerRun = runtime.run.nodeRuns[expectedReviewerId];
  const reviewerProcessCompleted =
    edge.config.reviewer === 'agent'
      ? reviewerRun?.status === 'waiting-for-approval' || reviewerRun?.status === 'succeeded'
      : reviewerRun?.status === 'succeeded' &&
        canvasNodeStatus(runtime, expectedReviewerId) === 'succeeded';
  if (reviewerNode.type !== 'agent' || reviewerRun === undefined || !reviewerProcessCompleted) {
    throw new Error(
      `Configured reviewer ${expectedReviewerId} must complete its planned agent run`,
    );
  }
  if (assessment.reviewerAttempt !== reviewerRun.attempt) {
    throw new Error(
      `Review assessment belongs to stale reviewer attempt ${String(assessment.reviewerAttempt)}; current attempt is ${String(reviewerRun.attempt)}`,
    );
  }
  if (
    assessment.reviewedNodeId !== edge.sourceNodeId ||
    assessment.reviewedNodeAttempt !== sourceRun.attempt
  ) {
    throw new Error('Review assessment is not bound to the current reviewed source attempt');
  }
  const currentDigests = currentOutputPublicationsForNode(runtime, edge.sourceNodeId).map(
    (publication) => publication.contentDigest,
  );
  if (currentDigests.length > 0 && !currentDigests.includes(assessment.reviewedOutputDigest)) {
    throw new Error('Review assessment does not match a current reviewed output digest');
  }
  if (
    edge.config.structuredFindings &&
    assessment.findings.length === 0 &&
    assessment.verdict === 'changes-requested'
  ) {
    throw new Error('A structured review requesting changes must include actionable findings');
  }
  if (!verifier.verifyReviewerAssessment(assessment)) {
    throw new Error(`Host verifier rejected review assessment for ${reviewEdgeId}`);
  }
  let reviewedRuntime: WorkflowExecutionRuntime = {
    ...runtime,
    evidence: {
      ...runtime.evidence,
      reviewerAssessments: {
        ...runtime.evidence.reviewerAssessments,
        [reviewEdgeId]: assessment,
      },
    },
  };
  if (edge.config.reviewer === 'agent') {
    const directReviews = runtime.canvas.edges.filter(
      (candidate): candidate is Extract<CanvasEdge, { type: 'review' }> =>
        candidate.type === 'review' &&
        candidate.config.reviewer === 'agent' &&
        candidate.targetNodeId === expectedReviewerId &&
        runtime.plan.executableEdgeIds.includes(candidate.id),
    );
    const assessments = directReviews.map((candidate) =>
      currentReviewerAssessmentForEdge(reviewedRuntime, candidate),
    );
    const terminalStatus = assessments.some(
      (candidate) => candidate?.verdict === 'changes-requested',
    )
      ? ('failed' as const)
      : assessments.every((candidate) => candidate?.verdict === 'approved')
        ? ('succeeded' as const)
        : undefined;
    if (terminalStatus !== undefined) {
      const finalizedReviewer = NodeRunStateSchema.parse({
        nodeId: reviewerRun.nodeId,
        status: terminalStatus,
        attempt: reviewerRun.attempt,
        queuedAt: reviewerRun.queuedAt,
        ...(reviewerRun.startedAt === undefined ? {} : { startedAt: reviewerRun.startedAt }),
        endedAt: reviewerRun.endedAt ?? runtime.run.updatedAt,
        resumable: reviewerRun.resumable,
        ...(terminalStatus === 'failed'
          ? {
              failureCode: 'REVIEW_CHANGES_REQUESTED',
              statusReason: 'The reviewer requested changes',
            }
          : { statusReason: 'All reviewers approved the result' }),
      });
      reviewedRuntime = replaceRunState(
        reviewedRuntime,
        { ...reviewedRuntime.run.nodeRuns, [expectedReviewerId]: finalizedReviewer },
        reviewerRun.endedAt ?? runtime.run.updatedAt,
      );
    }
  }
  return settleBlockedWorkflowNodes(reviewedRuntime, reviewerRun.endedAt ?? runtime.run.updatedAt);
}
