import type { CanvasEdge, CanvasNode } from '../model/domain.js';
import { isTerminalRunStatus } from '../workflow/model.js';

import {
  assertPlannedEdge,
  canvasNodeStatus,
  completed,
  currentHumanReviewDecision,
  currentReviewerAssessmentForEdge,
  edgeById,
  hasCurrentHumanApproval,
  nodeById,
  reviewedSourceIdsForGate,
  reviewGateEvaluation,
} from './evidence-state.js';
import type { EdgeEvaluation, NodeReadiness, WorkflowExecutionRuntime } from './types.js';
import { uniqueSorted } from './utils.js';

export function evaluateExecutableEdge(
  runtime: WorkflowExecutionRuntime,
  edgeOrId: CanvasEdge | string,
): EdgeEvaluation {
  const edge = typeof edgeOrId === 'string' ? edgeById(runtime, edgeOrId) : edgeOrId;
  assertPlannedEdge(runtime, edge);
  const sourceStatus = canvasNodeStatus(runtime, edge.sourceNodeId);
  if (edge.type === 'context') {
    if (edge.config.required && edge.config.attachmentIds.length === 0) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'blocked',
        status: 'failed',
        reason: 'This required context link has no attachments selected',
      };
    }
    if (edge.config.attachmentIds.length === 0) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'satisfied',
        status: 'succeeded',
        reason: 'This optional context link has no attachments selected',
      };
    }
    const resolution = runtime.evidence.contextResolutions[edge.id];
    if (resolution === undefined) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'waiting',
        status: 'queued',
        reason: 'The selected attachments are waiting to be verified',
      };
    }
    const targetAttempt = runtime.run.nodeRuns[edge.targetNodeId]?.attempt;
    const expectedAttachments = uniqueSorted(edge.config.attachmentIds);
    if (
      resolution.runId !== runtime.run.id ||
      resolution.sourceNodeId !== edge.sourceNodeId ||
      resolution.targetNodeId !== edge.targetNodeId ||
      resolution.targetAttempt !== targetAttempt ||
      JSON.stringify(uniqueSorted(resolution.attachmentIds)) !== JSON.stringify(expectedAttachments)
    ) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'blocked',
        status: 'failed',
        reason: 'The verified context is out of date for the current attempt',
      };
    }
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'satisfied',
      status: 'succeeded',
      reason: 'The selected attachments were verified for this attempt',
    };
  }
  if (edge.type === 'dependency') {
    if (sourceStatus === 'succeeded') {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'satisfied',
        status: 'succeeded',
        reason: 'The required earlier task succeeded',
      };
    }
    if (completed(sourceStatus)) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'blocked',
        status: 'failed',
        reason: `The required earlier task ended as ${sourceStatus}`,
      };
    }
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'waiting',
      status: sourceStatus === 'running' ? 'running' : 'queued',
      reason: 'The required earlier task has not succeeded',
    };
  }
  if (edge.type === 'execute') {
    const sourceRun = runtime.run.nodeRuns[edge.sourceNodeId];
    if (sourceRun?.failureCode === 'REVIEW_CHANGES_REQUESTED') {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'blocked',
        status: 'failed',
        reason: 'The reviewer requested changes, so later steps cannot run',
      };
    }
    const triggerSatisfied =
      edge.config.trigger === 'on-success' ? sourceStatus === 'succeeded' : completed(sourceStatus);
    if (!triggerSatisfied) {
      const blocked = edge.config.trigger === 'on-success' && completed(sourceStatus);
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: blocked ? 'blocked' : 'waiting',
        status: blocked ? 'failed' : sourceStatus === 'running' ? 'running' : 'queued',
        reason: blocked
          ? `This step runs only after success, but the earlier step ended as ${sourceStatus}`
          : edge.config.trigger === 'on-success'
            ? 'Waiting for the earlier step to succeed'
            : 'Waiting for the earlier step to finish',
      };
    }
    if (edge.config.approval === 'human' && !hasCurrentHumanApproval(runtime, edge.id)) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'waiting-for-approval',
        status: 'waiting-for-approval',
        reason: 'This step needs your approval before it can run',
      };
    }
    if (edge.config.approval === 'review-gate') {
      const gateNodeId = edge.config.approvalGateNodeId;
      if (gateNodeId === undefined) throw new Error('Validated review-gate edge lost its gate id');
      const gate = reviewGateEvaluation(runtime, gateNodeId);
      const gateRunStatus = runtime.run.nodeRuns[gateNodeId]?.status;
      if (
        gate.status === 'failed' ||
        (gateRunStatus !== undefined && completed(gateRunStatus) && gateRunStatus !== 'succeeded')
      ) {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'blocked',
          status: 'failed',
          reason: gate.reasons.join('; ') || 'Review gate failed',
          gate,
        };
      }
      if (gate.status === 'waiting-human') {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'waiting-for-approval',
          status: 'waiting-for-approval',
          reason: gate.reasons.join('; '),
          gate,
        };
      }
      if (
        gate.status !== 'passed' ||
        (gateRunStatus !== undefined && gateRunStatus !== 'succeeded')
      ) {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'waiting',
          status: gateRunStatus === 'running' ? 'running' : 'queued',
          reason: gate.reasons.join('; ') || 'Review gate has not completed',
          gate,
        };
      }
    }
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'satisfied',
      status: 'succeeded',
      reason: 'Everything needed for this step to run is ready',
    };
  }
  if (edge.type === 'output') {
    const recordedPublication = runtime.evidence.outputPublications[edge.id];
    const sourceAttempt = runtime.run.nodeRuns[edge.sourceNodeId]?.attempt;
    const publication =
      recordedPublication?.runId === runtime.run.id &&
      recordedPublication.producerNodeId === edge.sourceNodeId &&
      recordedPublication.producerAttempt === sourceAttempt &&
      recordedPublication.outputKind === edge.config.outputKind
        ? recordedPublication
        : undefined;
    if (publication !== undefined) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'satisfied',
        status: 'succeeded',
        reason: `The ${publication.outputKind} output was shared`,
      };
    }
    if (completed(sourceStatus) && sourceStatus !== 'succeeded') {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: edge.config.required ? 'blocked' : 'satisfied',
        status: edge.config.required ? 'failed' : 'succeeded',
        reason: edge.config.required
          ? `The required output was not shared before the earlier step ended as ${sourceStatus}`
          : 'No optional output was shared',
      };
    }
    if (sourceStatus === 'succeeded' && !edge.config.required) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'satisfied',
        status: 'succeeded',
        reason: 'No optional output was shared',
      };
    }
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'waiting',
      status: sourceStatus === 'running' ? 'running' : 'queued',
      reason: `Waiting for the required ${edge.config.outputKind} output`,
    };
  }
  if (edge.type === 'review') {
    if (sourceStatus !== 'succeeded') {
      const blocked = completed(sourceStatus);
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: blocked ? 'blocked' : 'waiting',
        status: blocked ? 'failed' : sourceStatus === 'running' ? 'running' : 'queued',
        reason: blocked
          ? `The step under review ended as ${sourceStatus}`
          : 'The review waits for the earlier step to succeed',
      };
    }
    const assessment = currentReviewerAssessmentForEdge(runtime, edge);
    if (assessment?.verdict === 'changes-requested' && edge.config.reviewer !== 'agent') {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'satisfied',
        status: 'failed',
        reason: 'The review finished with changes requested',
      };
    }
    if (edge.config.reviewer === 'human') {
      const decision = currentHumanReviewDecision(runtime, edge.id);
      if (decision?.decision === 'changes-requested') {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'satisfied',
          status: 'failed',
          reason: 'You finished the review with changes requested',
        };
      }
      if (decision?.decision === 'approved') {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'satisfied',
          status: 'succeeded',
          reason: 'You approved the reviewed result',
        };
      }
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'waiting-for-approval',
        status: 'waiting-for-approval',
        reason: 'Waiting for you to approve or request changes',
      };
    }
    const target = nodeById(runtime, edge.targetNodeId);
    const configuredGateReviewer =
      edge.config.reviewer === 'gate' && target.type === 'review-gate'
        ? target.data.reviewerAgentId
        : undefined;
    // Direct reviewer-agent edges are scheduling dependencies: the reviewer must run before it can
    // publish an assessment. Gate edges consume the completed configured reviewer assessment.
    if (edge.config.reviewer === 'agent') {
      const reviewerRun = runtime.run.nodeRuns[edge.targetNodeId];
      if (assessment?.verdict === 'approved') {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'satisfied',
          status: 'succeeded',
          reason: 'The reviewer approved this attempt',
        };
      }
      if (assessment?.verdict === 'changes-requested') {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'blocked',
          status: 'failed',
          reason: 'The reviewer requested changes',
        };
      }
      if (
        reviewerRun !== undefined &&
        isTerminalRunStatus(reviewerRun.status) &&
        reviewerRun.status !== 'succeeded'
      ) {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'blocked',
          status: 'failed',
          reason: `The reviewer agent ended as ${reviewerRun.status} without approving`,
        };
      }
      if (reviewerRun?.status === 'succeeded' || reviewerRun?.status === 'waiting-for-approval') {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'waiting',
          status: 'running',
          reason: 'The reviewer finished and still needs to record its review',
        };
      }
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'satisfied',
        status: 'succeeded',
        reason: 'The step under review succeeded; the reviewer agent can run now',
      };
    }
    const assessmentRequired = edge.config.requireApproval && configuredGateReviewer !== undefined;
    if (assessmentRequired && assessment === undefined) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'waiting',
        status: 'queued',
        reason: 'Waiting for the configured reviewer to finish its review',
      };
    }
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'satisfied',
      status: 'succeeded',
      reason:
        assessment === undefined
          ? 'The review gate can decide without a separate reviewer'
          : 'The review found nothing that blocks the run',
    };
  }

  if (edge.config.loopId === undefined) {
    throw new Error(`Revision edge is not configured: ${edge.id}`);
  }
  const loop = runtime.run.revisionLoops[edge.config.loopId];
  if (loop === undefined) throw new Error(`Revision loop state is missing: ${edge.config.loopId}`);
  if (runtime.activeRevisionLoopIds.includes(loop.loopId)) {
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'satisfied',
      status: canvasNodeStatus(runtime, edge.targetNodeId),
      reason: 'The review asked for changes, so the loop is trying again',
    };
  }
  if (loop.status === 'waiting-human') {
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'waiting-for-approval',
      status: 'waiting-for-approval',
      reason: 'The loop reached its limit and needs your decision',
    };
  }
  if (loop.status === 'satisfied') {
    const reason =
      loop.stopCondition === 'review-approved'
        ? 'The loop finished because the review approved the result'
        : loop.stopCondition === 'tests-passed'
          ? 'The loop finished because the checks passed'
          : loop.stopCondition === 'human-accepted'
            ? 'The loop finished because you accepted the result'
            : 'The loop finished';
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'satisfied',
      status: 'succeeded',
      reason,
    };
  }
  if (loop.status === 'cancelled') {
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'inactive',
      status: 'cancelled',
      reason: 'You cancelled the loop',
    };
  }
  return {
    edgeId: edge.id,
    type: edge.type,
    disposition: 'inactive',
    status: 'queued',
    reason: 'This step runs only after a failed review',
  };
}

export function contextAttachmentsForNode(
  runtime: WorkflowExecutionRuntime,
  nodeId: string,
): readonly {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly sourceType: CanvasNode['type'];
  readonly attachmentIds: readonly string[];
  readonly required: boolean;
  readonly contentDigest: string;
  readonly verifierId: string;
}[] {
  if (runtime.run.nodeRuns[nodeId] === undefined) return [];
  const target = nodeById(runtime, nodeId);
  if (target.type !== 'agent' && target.type !== 'task') return [];
  return runtime.canvas.edges
    .filter(
      (edge): edge is Extract<CanvasEdge, { type: 'context' }> =>
        edge.type === 'context' &&
        edge.targetNodeId === nodeId &&
        runtime.plan.executableEdgeIds.includes(edge.id),
    )
    .flatMap((edge) => {
      if (edge.config.attachmentIds.length === 0) return [];
      const resolution = runtime.evidence.contextResolutions[edge.id];
      if (resolution === undefined) {
        throw new Error(`This context link has not been verified yet: ${edge.id}`);
      }
      const targetAttempt = runtime.run.nodeRuns[edge.targetNodeId]?.attempt;
      if (
        resolution.runId !== runtime.run.id ||
        resolution.sourceNodeId !== edge.sourceNodeId ||
        resolution.targetNodeId !== edge.targetNodeId ||
        resolution.targetAttempt !== targetAttempt ||
        JSON.stringify(resolution.attachmentIds) !== JSON.stringify(edge.config.attachmentIds)
      ) {
        throw new Error(`This context link is out of date for the current attempt: ${edge.id}`);
      }
      return [
        {
          edgeId: edge.id,
          sourceNodeId: edge.sourceNodeId,
          sourceType: nodeById(runtime, edge.sourceNodeId).type,
          attachmentIds: [...edge.config.attachmentIds],
          required: edge.config.required,
          contentDigest: resolution.contentDigest,
          verifierId: resolution.verifierId,
        },
      ];
    });
}

export function evaluateNodeReadiness(
  runtime: WorkflowExecutionRuntime,
  nodeId: string,
): NodeReadiness {
  const nodeRun = runtime.run.nodeRuns[nodeId];
  if (nodeRun === undefined) {
    return {
      nodeId,
      disposition: 'not-runnable',
      edgeEvaluations: [],
      reasons: ['This step is outside the current run'],
    };
  }
  if (runtime.cancellationRequested || isTerminalRunStatus(runtime.run.status)) {
    return {
      nodeId,
      disposition: 'not-runnable',
      edgeEvaluations: [],
      reasons: [
        runtime.cancellationRequested ? 'The workflow was cancelled' : 'The workflow ended',
      ],
    };
  }
  if (nodeRun.status !== 'queued' && nodeRun.status !== 'waiting-for-approval') {
    return {
      nodeId,
      disposition: 'not-runnable',
      edgeEvaluations: [],
      reasons: [`Node is already ${nodeRun.status}`],
    };
  }
  const incoming = runtime.canvas.edges.filter(
    (edge) =>
      edge.targetNodeId === nodeId &&
      edge.type !== 'revision' &&
      runtime.plan.executableEdgeIds.includes(edge.id),
  );
  const edgeEvaluations = incoming.map((edge) => evaluateExecutableEdge(runtime, edge));
  const blocked = edgeEvaluations.filter((evaluation) => evaluation.disposition === 'blocked');
  const approvals = edgeEvaluations.filter(
    (evaluation) => evaluation.disposition === 'waiting-for-approval',
  );
  const waiting = edgeEvaluations.filter((evaluation) => evaluation.disposition === 'waiting');
  if (blocked.length > 0) {
    return {
      nodeId,
      disposition: 'blocked',
      edgeEvaluations,
      reasons: blocked.map((evaluation) => evaluation.reason),
    };
  }
  if (waiting.length > 0) {
    return {
      nodeId,
      disposition: 'waiting',
      edgeEvaluations,
      reasons: waiting.map((evaluation) => evaluation.reason),
    };
  }
  if (approvals.length > 0) {
    return {
      nodeId,
      disposition: 'waiting-for-approval',
      edgeEvaluations,
      reasons: approvals.map((evaluation) => evaluation.reason),
    };
  }
  const node = nodeById(runtime, nodeId);
  if (node.type === 'agent') {
    const assignedSourceIds = uniqueSorted(
      runtime.canvas.nodes.flatMap((candidate) => {
        if (
          candidate.type !== 'review-gate' ||
          candidate.data.reviewerAgentId !== nodeId ||
          runtime.run.nodeRuns[candidate.id] === undefined
        ) {
          return [];
        }
        return reviewedSourceIdsForGate(runtime, candidate.id);
      }),
    );
    const failedSources = assignedSourceIds.filter((sourceId) => {
      const status = canvasNodeStatus(runtime, sourceId);
      return isTerminalRunStatus(status) && status !== 'succeeded';
    });
    if (failedSources.length > 0) {
      return {
        nodeId,
        disposition: 'blocked',
        edgeEvaluations,
        reasons: [`The step under review did not succeed: ${failedSources.join(', ')}`],
      };
    }
    const pendingSources = assignedSourceIds.filter(
      (sourceId) => canvasNodeStatus(runtime, sourceId) !== 'succeeded',
    );
    if (pendingSources.length > 0) {
      return {
        nodeId,
        disposition: 'waiting',
        edgeEvaluations,
        reasons: [`The reviewer is waiting for these steps: ${pendingSources.join(', ')}`],
      };
    }
  }
  if (node.type === 'review-gate') {
    const gate = reviewGateEvaluation(runtime, node.id);
    if (gate.status === 'pending') {
      return {
        nodeId,
        disposition: 'waiting',
        edgeEvaluations,
        reasons: gate.reasons,
      };
    }
    if (gate.status === 'waiting-human') {
      return {
        nodeId,
        disposition: 'waiting-for-approval',
        edgeEvaluations,
        reasons: gate.reasons,
      };
    }
  }
  return { nodeId, disposition: 'ready', edgeEvaluations, reasons: [] };
}
