import {
  applyRevisionReview,
  completeWorkflowNode,
  queueRevisionAttempt,
  reviewGateEvaluation,
  type NodeCompletion,
  type ReviewGateEvaluation,
  type WorkflowExecutionRuntime,
} from '@forgeboard/core';

export interface ReviewGateLoopTransition {
  readonly loopId: string;
  readonly disposition: 'satisfied' | 'revision-required' | 'waiting-human';
}

export interface InternalReviewGateResult {
  readonly runtime: WorkflowExecutionRuntime;
  readonly evaluation: ReviewGateEvaluation;
  readonly completion: NodeCompletion;
  readonly loop?: ReviewGateLoopTransition;
}

export interface QueuedRevisionAttempt {
  readonly loopId: string;
  readonly attempt: number;
}

export interface EligibleRevisionQueueResult {
  readonly runtime: WorkflowExecutionRuntime;
  readonly queued: readonly QueuedRevisionAttempt[];
}

/**
 * Completes a host-owned review gate from its authoritative evidence. A deterministic failure is
 * never rewritten as success; when the gate owns a bounded loop, the same failure is first routed
 * into revision state so blocked-edge settlement cannot erase the retry path.
 */
export function completeInternalReviewGate(
  runtime: WorkflowExecutionRuntime,
  nodeId: string,
  occurredAt: string,
): InternalReviewGateResult {
  const evaluation = reviewGateEvaluation(runtime, nodeId);
  if (evaluation.status === 'pending' || evaluation.status === 'waiting-human') {
    throw new Error(
      `Review gate ${nodeId} is not ready for internal completion: ${evaluation.reasons.join('; ')}`,
    );
  }

  const loopId = reviewLoopId(runtime, nodeId);
  if (evaluation.status === 'passed') {
    const completion = { status: 'succeeded' } as const;
    let completed = completeWorkflowNode(runtime, nodeId, completion, occurredAt);
    if (loopId === undefined) return { runtime: completed, evaluation, completion };
    const review = applyRevisionReview(completed, loopId, occurredAt);
    if (review.disposition !== 'satisfied') {
      throw new Error(
        `Passed review gate ${nodeId} produced unexpected loop disposition ${review.disposition}.`,
      );
    }
    completed = review.runtime;
    return {
      runtime: completed,
      evaluation,
      completion,
      loop: { loopId, disposition: review.disposition },
    };
  }

  const reason =
    evaluation.reasons.join('; ') || 'Review gate rejected the current authoritative evidence.';
  const completion = {
    status: 'failed',
    failureCode: 'REVIEW_GATE_FAILED',
    reason,
  } as const;
  if (loopId === undefined) {
    return {
      runtime: completeWorkflowNode(runtime, nodeId, completion, occurredAt),
      evaluation,
      completion,
    };
  }

  const review = applyRevisionReview(runtime, loopId, occurredAt);
  if (review.disposition !== 'revision-required' && review.disposition !== 'waiting-human') {
    throw new Error(
      `Failed review gate ${nodeId} produced unexpected loop disposition ${review.disposition}.`,
    );
  }
  return {
    runtime: completeWorkflowNode(review.runtime, nodeId, completion, occurredAt),
    evaluation,
    completion,
    loop: { loopId, disposition: review.disposition },
  };
}

/** Queues every due bounded revision after its failed reviewer has reached a terminal state. */
export function queueEligibleRevisionAttempts(
  initial: WorkflowExecutionRuntime,
  occurredAt: string,
): EligibleRevisionQueueResult {
  let runtime = initial;
  const queued: QueuedRevisionAttempt[] = [];
  for (const [loopId, state] of Object.entries(runtime.run.revisionLoops).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      state.status !== 'revision-required' ||
      (state.eligibleAt !== undefined && Date.parse(state.eligibleAt) > Date.parse(occurredAt))
    ) {
      continue;
    }
    const loop = runtime.canvas.revisionLoops.find((candidate) => candidate.id === loopId);
    if (loop === undefined) throw new Error(`Revision loop is missing: ${loopId}`);
    const reviewRun = runtime.run.nodeRuns[loop.reviewNodeId];
    if (
      reviewRun === undefined ||
      !['failed', 'succeeded', 'cancelled', 'lost'].includes(reviewRun.status)
    ) {
      continue;
    }
    runtime = queueRevisionAttempt(runtime, loopId, occurredAt);
    queued.push({ loopId, attempt: runtime.run.revisionLoops[loopId]?.attemptsStarted ?? 1 });
  }
  return { runtime, queued };
}

function reviewLoopId(runtime: WorkflowExecutionRuntime, nodeId: string): string | undefined {
  const matching = runtime.plan.revisionLoopIds.filter((loopId) => {
    const loop = runtime.canvas.revisionLoops.find((candidate) => candidate.id === loopId);
    const state = runtime.run.revisionLoops[loopId];
    return loop?.reviewNodeId === nodeId && state?.status === 'review-required';
  });
  if (matching.length > 1) {
    throw new Error(`Review gate ${nodeId} cannot complete multiple bounded loops at once.`);
  }
  return matching[0];
}
