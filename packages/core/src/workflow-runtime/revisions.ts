import type { ReviewGateEvaluation, ReviewerAssessment } from '../workflow-gates.js';
import {
  NodeRunStateSchema,
  WorkflowRunSchema,
  advanceRevisionLoop,
  isTerminalRunStatus,
  requestWorkflowCancellation,
  transitionNodeRun,
  type NodeRunState,
  type RevisionLoopState,
} from '../workflow.js';

import {
  currentHumanReviewDecision,
  currentOutputPublicationsForNode,
  currentReviewerAssessmentForEdge,
  edgeById,
  nodeById,
  reviewGateEvaluation,
  stableValue,
} from './evidence-state.js';
import { RevisionEscapeRequestSchema, RevisionEscapeResolutionSchema } from './schemas.js';
import { replaceRunState, settleBlockedWorkflowNodes } from './scheduling.js';
import type {
  RevisionEscapeRequest,
  RevisionEscapeResolution,
  WorkflowExecutionRuntime,
} from './types.js';
import { uniqueSorted } from './utils.js';

function replaceRevisionLoopState(
  runtime: WorkflowExecutionRuntime,
  loopId: string,
  state: RevisionLoopState,
  occurredAt: string,
): WorkflowExecutionRuntime {
  return {
    ...runtime,
    run: WorkflowRunSchema.parse({
      ...runtime.run,
      revisionLoops: { ...runtime.run.revisionLoops, [loopId]: state },
      updatedAt: occurredAt,
    }),
  };
}

export interface RevisionReviewResult {
  readonly runtime: WorkflowExecutionRuntime;
  readonly disposition: 'pending' | 'satisfied' | 'revision-required' | 'waiting-human';
  readonly gate?: ReviewGateEvaluation;
}

function actionableReviewFeedback(
  assessment: ReviewerAssessment | undefined,
  gate: ReviewGateEvaluation | undefined,
): string {
  const findingText =
    assessment?.findings
      .filter((finding) => finding.blocking || finding.severity === 'error')
      .map((finding) => finding.message)
      .join('\n') ?? '';
  const feedback = [findingText, ...(gate?.reasons ?? [])]
    .filter((value) => value.trim().length > 0)
    .join('\n');
  return feedback || assessment?.summary || 'Review did not satisfy the configured gate.';
}

/** Applies a completed review to its bounded loop, with deterministic gate failures authoritative. */
export function applyRevisionReview(
  runtime: WorkflowExecutionRuntime,
  loopId: string,
  occurredAt: string,
): RevisionReviewResult {
  const loop = runtime.canvas.revisionLoops.find((candidate) => candidate.id === loopId);
  const state = runtime.run.revisionLoops[loopId];
  if (loop === undefined || state === undefined)
    throw new Error(`Revision loop is missing: ${loopId}`);
  if (state.status !== 'review-required')
    throw new Error('Revision review is not currently expected');
  const implementationRun = runtime.run.nodeRuns[loop.implementationNodeId];
  const reviewRun = runtime.run.nodeRuns[loop.reviewNodeId];
  if (implementationRun?.status !== 'succeeded') {
    throw new Error('Revision review requires the current implementation attempt to succeed');
  }
  if (reviewRun === undefined) {
    throw new Error('Revision review requires the reviewer node to start');
  }
  const reviewNode = nodeById(runtime, loop.reviewNodeId);
  const reviewEdge = edgeById(runtime, loop.reviewEdgeId);
  if (reviewEdge.type !== 'review') throw new Error('Revision loop review edge is invalid');
  const assessment = currentReviewerAssessmentForEdge(runtime, reviewEdge);
  const gate =
    reviewNode.type === 'review-gate' ? reviewGateEvaluation(runtime, reviewNode.id) : undefined;
  const humanDecision =
    reviewEdge.config.reviewer === 'human'
      ? currentHumanReviewDecision(runtime, reviewEdge.id)
      : undefined;
  if (
    (gate === undefined &&
      reviewRun.status !== 'succeeded' &&
      !(
        reviewRun.status === 'failed' &&
        (humanDecision?.decision === 'changes-requested' ||
          assessment?.verdict === 'changes-requested')
      )) ||
    (gate !== undefined && reviewRun.status !== 'running' && !isTerminalRunStatus(reviewRun.status))
  ) {
    throw new Error('Revision review requires the configured reviewer to complete');
  }
  if (gate?.status === 'pending' || gate?.status === 'waiting-human') {
    return {
      runtime,
      disposition: gate.status === 'waiting-human' ? 'waiting-human' : 'pending',
      gate,
    };
  }
  const humanApproved =
    reviewEdge.config.reviewer === 'human' && humanDecision?.decision === 'approved';
  if (
    assessment === undefined &&
    gate === undefined &&
    !humanApproved &&
    humanDecision === undefined
  ) {
    return { runtime, disposition: 'pending' };
  }
  const approved = gate?.status === 'passed' || humanApproved || assessment?.verdict === 'approved';
  const deterministicPassed = gate === undefined || gate.status === 'passed';
  const stopCondition = !deterministicPassed
    ? undefined
    : approved && loop.stopConditions.includes('review-approved')
      ? ('review-approved' as const)
      : assessment?.verdict !== 'changes-requested' &&
          loop.stopConditions.includes('tests-passed') &&
          gate?.deterministicStatus === 'passed'
        ? ('tests-passed' as const)
        : undefined;
  if (stopCondition !== undefined) {
    const next = advanceRevisionLoop(loop, state, {
      type: 'stop-condition-met',
      condition: stopCondition,
    });
    return {
      runtime: replaceRevisionLoopState(runtime, loopId, next, occurredAt),
      disposition: 'satisfied',
      ...(gate === undefined ? {} : { gate }),
    };
  }
  if (approved && deterministicPassed) {
    throw new Error('Review passed, but no automatic stop condition is configured');
  }
  const next = advanceRevisionLoop(loop, state, {
    type: 'review-failed',
    feedback: humanDecision?.feedback ?? actionableReviewFeedback(assessment, gate),
  });
  const backoffMs = reviewNode.type === 'review-gate' ? reviewNode.data.retryPolicy.backoffMs : 0;
  const nextWithEligibility =
    next.status === 'revision-required' && backoffMs > 0
      ? {
          ...next,
          eligibleAt: new Date(Date.parse(occurredAt) + backoffMs).toISOString(),
        }
      : next;
  return {
    runtime: replaceRevisionLoopState(runtime, loopId, nextWithEligibility, occurredAt),
    disposition:
      nextWithEligibility.status === 'waiting-human' ? 'waiting-human' : 'revision-required',
    ...(gate === undefined ? {} : { gate }),
  };
}

function requeueRevisionNode(nodeRun: NodeRunState, occurredAt: string): NodeRunState {
  if (!isTerminalRunStatus(nodeRun.status)) {
    throw new Error(`Revision node ${nodeRun.nodeId} is not in a completed state`);
  }
  return NodeRunStateSchema.parse({
    nodeId: nodeRun.nodeId,
    status: 'queued',
    attempt: nodeRun.attempt + 1,
    queuedAt: occurredAt,
    resumable: nodeRun.resumable,
    statusReason: 'Queued for bounded revision after actionable review feedback',
  });
}

function requiredCheckProducerIds(
  runtime: WorkflowExecutionRuntime,
  reviewNodeId: string,
): readonly string[] {
  const reviewNode = nodeById(runtime, reviewNodeId);
  if (reviewNode.type !== 'review-gate') return [];
  return uniqueSorted(
    reviewNode.data.requiredCheckIds.flatMap((checkId) =>
      runtime.canvas.nodes.flatMap((node) =>
        node.type === 'test' && node.data.runIds.includes(checkId) ? [node.id] : [],
      ),
    ),
  );
}

/** Starts exactly one additional bounded attempt and requeues both implementation and reviewer. */
export function queueRevisionAttempt(
  runtime: WorkflowExecutionRuntime,
  loopId: string,
  occurredAt: string,
): WorkflowExecutionRuntime {
  const loop = runtime.canvas.revisionLoops.find((candidate) => candidate.id === loopId);
  const state = runtime.run.revisionLoops[loopId];
  if (loop === undefined || state === undefined)
    throw new Error(`Revision loop is missing: ${loopId}`);
  if (state.status !== 'revision-required')
    throw new Error('A revision attempt is not currently allowed');
  if (state.eligibleAt !== undefined && Date.parse(occurredAt) < Date.parse(state.eligibleAt)) {
    throw new Error(`Revision retry is not eligible until ${state.eligibleAt}`);
  }
  const implementation = runtime.run.nodeRuns[loop.implementationNodeId];
  const reviewer = runtime.run.nodeRuns[loop.reviewNodeId];
  if (implementation === undefined || reviewer === undefined) {
    throw new Error('Both revision-loop nodes must belong to the scoped plan');
  }
  const nextLoop = advanceRevisionLoop(loop, state, { type: 'revision-completed' });
  const producerIds = requiredCheckProducerIds(runtime, loop.reviewNodeId);
  const reviewNode = nodeById(runtime, loop.reviewNodeId);
  const reviewerAgentId =
    reviewNode.type === 'review-gate' ? reviewNode.data.reviewerAgentId : undefined;
  const requeuedNodeIds = new Set([
    loop.implementationNodeId,
    loop.reviewNodeId,
    ...producerIds,
    ...(reviewerAgentId === undefined ? [] : [reviewerAgentId]),
  ]);
  const nodeRuns = { ...runtime.run.nodeRuns };
  for (const nodeId of requeuedNodeIds) {
    const nodeRun = nodeRuns[nodeId];
    if (nodeRun === undefined)
      throw new Error(`Revision retry node is outside the plan: ${nodeId}`);
    nodeRuns[nodeId] = requeueRevisionNode(nodeRun, occurredAt);
  }
  const reopened = replaceRunState(runtime, nodeRuns, occurredAt);
  const outputPublications = Object.fromEntries(
    Object.entries(runtime.evidence.outputPublications).filter(([edgeId]) => {
      const edge = runtime.canvas.edges.find((candidate) => candidate.id === edgeId);
      return edge === undefined || !requeuedNodeIds.has(edge.sourceNodeId);
    }),
  );
  const reviewerAssessments = Object.fromEntries(
    Object.entries(runtime.evidence.reviewerAssessments).filter(
      ([edgeId, assessment]) =>
        edgeId !== loop.reviewEdgeId &&
        !requeuedNodeIds.has(assessment.reviewerNodeId) &&
        !requeuedNodeIds.has(assessment.reviewedNodeId),
    ),
  );
  const gateChecks = Object.fromEntries(
    Object.entries(runtime.evidence.gateChecks).filter(
      ([gateNodeId, checks]) =>
        gateNodeId !== loop.reviewNodeId &&
        !checks.some(
          (check) =>
            (check.producerNodeId !== undefined && requeuedNodeIds.has(check.producerNodeId)) ||
            (check.reviewedNodeId !== undefined && requeuedNodeIds.has(check.reviewedNodeId)),
        ),
    ),
  );
  const contextResolutions = Object.fromEntries(
    Object.entries(runtime.evidence.contextResolutions).filter(
      ([, resolution]) => !requeuedNodeIds.has(resolution.targetNodeId),
    ),
  );
  const humanApprovals = Object.fromEntries(
    Object.entries(runtime.evidence.humanApprovals).filter(([targetId]) => {
      if (targetId === loop.reviewNodeId || targetId === loop.reviewEdgeId) return false;
      const edge = runtime.canvas.edges.find((candidate) => candidate.id === targetId);
      return edge === undefined || !requeuedNodeIds.has(edge.targetNodeId);
    }),
  );
  const humanReviewDecisions = Object.fromEntries(
    Object.entries(runtime.evidence.humanReviewDecisions).filter(
      ([targetId]) => targetId !== loop.reviewEdgeId,
    ),
  );
  return {
    ...reopened,
    run: WorkflowRunSchema.parse({
      ...reopened.run,
      revisionLoops: { ...reopened.run.revisionLoops, [loopId]: nextLoop },
    }),
    evidence: {
      ...runtime.evidence,
      contextResolutions,
      outputPublications,
      reviewerAssessments,
      gateChecks,
      humanApprovals,
      humanReviewDecisions,
    },
    activeRevisionLoopIds: uniqueSorted([...runtime.activeRevisionLoopIds, loopId]),
  };
}

export function getRevisionEscapeRequest(
  runtime: WorkflowExecutionRuntime,
  loopId: string,
): RevisionEscapeRequest {
  const loop = runtime.canvas.revisionLoops.find((candidate) => candidate.id === loopId);
  const state = runtime.run.revisionLoops[loopId];
  if (loop === undefined || state === undefined)
    throw new Error(`Revision loop is missing: ${loopId}`);
  if (state.status !== 'waiting-human') throw new Error('Human escape is not currently required');
  const evidenceFingerprint = `revision-escape-v1:${JSON.stringify(
    stableValue({
      runId: runtime.run.id,
      loopId,
      state,
      implementationRun: runtime.run.nodeRuns[loop.implementationNodeId],
      reviewRun: runtime.run.nodeRuns[loop.reviewNodeId],
      assessment: runtime.evidence.reviewerAssessments[loop.reviewEdgeId] ?? null,
      gateChecks: runtime.evidence.gateChecks[loop.reviewNodeId] ?? [],
      outputs: currentOutputPublicationsForNode(runtime, loop.implementationNodeId),
    }),
  )}`;
  return RevisionEscapeRequestSchema.parse({
    runId: runtime.run.id,
    loopId,
    attemptsStarted: state.attemptsStarted,
    evidenceFingerprint,
  });
}

export function resolveRevisionEscape(
  runtime: WorkflowExecutionRuntime,
  untrustedResolution: RevisionEscapeResolution,
): WorkflowExecutionRuntime {
  const resolution = RevisionEscapeResolutionSchema.parse(untrustedResolution);
  const expected = getRevisionEscapeRequest(runtime, resolution.loopId);
  if (
    resolution.runId !== expected.runId ||
    resolution.attemptsStarted !== expected.attemptsStarted ||
    resolution.evidenceFingerprint !== expected.evidenceFingerprint
  ) {
    throw new Error('Revision escape decision does not match the exhausted loop evidence');
  }
  const loopId = resolution.loopId;
  const loop = runtime.canvas.revisionLoops.find((candidate) => candidate.id === loopId)!;
  const state = runtime.run.revisionLoops[loopId]!;
  const reviewRun = runtime.run.nodeRuns[loop.reviewNodeId];
  if (reviewRun === undefined) throw new Error('Revision reviewer is outside the scoped plan');
  if (resolution.decision === 'cancel') {
    const withCancelledLoop = replaceRevisionLoopState(
      runtime,
      loopId,
      advanceRevisionLoop(loop, state, { type: 'human-aborted' }),
      resolution.decidedAt,
    );
    const cancellationRequested = requestWorkflowCancellation(
      withCancelledLoop.run,
      resolution.decidedAt,
    );
    const normalizedRuns = Object.fromEntries(
      Object.entries(cancellationRequested.nodeRuns).map(([nodeId, nodeRun]) => {
        if (nodeRun.status !== 'failed' && nodeRun.status !== 'lost') return [nodeId, nodeRun];
        return [
          nodeId,
          NodeRunStateSchema.parse({
            nodeId,
            status: 'cancelled',
            attempt: nodeRun.attempt,
            queuedAt: nodeRun.queuedAt,
            ...(nodeRun.startedAt === undefined ? {} : { startedAt: nodeRun.startedAt }),
            endedAt: resolution.decidedAt,
            resumable: nodeRun.resumable,
            ...(nodeRun.failureCode === undefined ? {} : { failureCode: nodeRun.failureCode }),
            statusReason: `Human cancelled the exhausted revision loop after ${nodeRun.status}`,
          }),
        ];
      }),
    );
    const cancelledRuntime = replaceRunState(
      { ...withCancelledLoop, run: cancellationRequested },
      normalizedRuns,
      resolution.decidedAt,
    );
    return {
      ...cancelledRuntime,
      evidence: {
        ...cancelledRuntime.evidence,
        revisionEscapes: {
          ...cancelledRuntime.evidence.revisionEscapes,
          [loopId]: resolution,
        },
      },
      cancellationRequested: true,
      activeRevisionLoopIds: withCancelledLoop.activeRevisionLoopIds.filter(
        (candidate) => candidate !== loopId,
      ),
    };
  }
  if (!loop.stopConditions.includes('human-accepted')) {
    throw new Error('Human acceptance is not a configured stop condition');
  }
  const reviewNode = nodeById(runtime, loop.reviewNodeId);
  let acceptedRuntime = runtime;
  if (reviewNode.type === 'review-gate') {
    const failedReviewer =
      reviewRun.status === 'running' || reviewRun.status === 'cancelling'
        ? transitionNodeRun(reviewRun, {
            status: 'failed',
            occurredAt: resolution.decidedAt,
            failureCode: 'HUMAN_ACCEPTED_FAILED_GATE',
            reason:
              'Human accepted the exhausted loop; deterministic gate failure remained authoritative',
          })
        : reviewRun;
    if (failedReviewer.status === 'succeeded') {
      throw new Error('A succeeded deterministic gate cannot require a failed-review escape');
    }
    acceptedRuntime = replaceRunState(
      runtime,
      { ...runtime.run.nodeRuns, [loop.reviewNodeId]: failedReviewer },
      resolution.decidedAt,
    );
  } else if (reviewRun.status !== 'succeeded') {
    const reviewEdge = edgeById(runtime, loop.reviewEdgeId);
    const canOverrideHumanReview =
      reviewEdge.type === 'review' &&
      reviewEdge.config.reviewer === 'human' &&
      reviewRun.status === 'failed';
    if (!canOverrideHumanReview) {
      throw new Error('Human acceptance requires the non-gate reviewer to complete');
    }
    const acceptedReviewer = NodeRunStateSchema.parse({
      nodeId: reviewRun.nodeId,
      status: 'succeeded',
      attempt: reviewRun.attempt,
      queuedAt: reviewRun.queuedAt,
      ...(reviewRun.startedAt === undefined ? {} : { startedAt: reviewRun.startedAt }),
      endedAt: resolution.decidedAt,
      resumable: reviewRun.resumable,
      statusReason: 'Human accepted the exhausted non-deterministic review loop',
    });
    acceptedRuntime = replaceRunState(
      runtime,
      { ...runtime.run.nodeRuns, [loop.reviewNodeId]: acceptedReviewer },
      resolution.decidedAt,
    );
  }
  const resolved = replaceRevisionLoopState(
    acceptedRuntime,
    loopId,
    advanceRevisionLoop(loop, state, {
      type: 'stop-condition-met',
      condition: 'human-accepted',
    }),
    resolution.decidedAt,
  );
  return settleBlockedWorkflowNodes(
    {
      ...resolved,
      evidence: {
        ...resolved.evidence,
        revisionEscapes: {
          ...resolved.evidence.revisionEscapes,
          [loopId]: resolution,
        },
      },
      activeRevisionLoopIds: resolved.activeRevisionLoopIds.filter(
        (candidate) => candidate !== loopId,
      ),
    },
    resolution.decidedAt,
  );
}
