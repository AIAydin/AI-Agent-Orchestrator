import type { CanvasEdge, CanvasNode } from '../domain.js';
import { isTerminalRunStatus } from '../workflow.js';

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
        reason: 'Required context has no explicitly selected attachments',
      };
    }
    if (edge.config.attachmentIds.length === 0) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'satisfied',
        status: 'succeeded',
        reason: 'Optional context has no selected attachments',
      };
    }
    const resolution = runtime.evidence.contextResolutions[edge.id];
    if (resolution === undefined) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'waiting',
        status: 'queued',
        reason: 'Selected context is waiting for host verification',
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
        reason: 'Verified context does not match the current target attempt',
      };
    }
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'satisfied',
      status: 'succeeded',
      reason: 'Explicit source context and configured attachments were verified by the host',
    };
  }
  if (edge.type === 'dependency') {
    if (sourceStatus === 'succeeded') {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'satisfied',
        status: 'succeeded',
        reason: 'Required upstream task succeeded',
      };
    }
    if (completed(sourceStatus)) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'blocked',
        status: 'failed',
        reason: `Required upstream task ended as ${sourceStatus}`,
      };
    }
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'waiting',
      status: sourceStatus === 'running' ? 'running' : 'queued',
      reason: 'Required upstream task has not succeeded',
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
        reason: 'Authoritative reviewer changes block downstream execution',
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
          ? `Success trigger cannot run after source ended as ${sourceStatus}`
          : `Waiting for source ${edge.config.trigger}`,
      };
    }
    if (edge.config.approval === 'human' && !hasCurrentHumanApproval(runtime, edge.id)) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'waiting-for-approval',
        status: 'waiting-for-approval',
        reason: 'Execute edge requires human approval',
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
      reason: 'Execution trigger and approval rules are satisfied',
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
        reason: `${publication.outputKind} output was explicitly published`,
      };
    }
    if (completed(sourceStatus) && sourceStatus !== 'succeeded') {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: edge.config.required ? 'blocked' : 'satisfied',
        status: edge.config.required ? 'failed' : 'succeeded',
        reason: edge.config.required
          ? `Required output was not published before source ended as ${sourceStatus}`
          : 'Optional output is absent',
      };
    }
    if (sourceStatus === 'succeeded' && !edge.config.required) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'satisfied',
        status: 'succeeded',
        reason: 'Optional output is absent',
      };
    }
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'waiting',
      status: sourceStatus === 'running' ? 'running' : 'queued',
      reason: `Waiting for required ${edge.config.outputKind} publication`,
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
          ? `Review source ended as ${sourceStatus}`
          : 'Review waits for successful source output',
      };
    }
    const assessment = currentReviewerAssessmentForEdge(runtime, edge);
    if (assessment?.verdict === 'changes-requested' && edge.config.reviewer !== 'agent') {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'satisfied',
        status: 'failed',
        reason: 'Review completed with actionable changes requested',
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
          reason: 'Human review completed with actionable changes requested',
        };
      }
      if (decision?.decision === 'approved') {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'satisfied',
          status: 'succeeded',
          reason: 'Human approved the reviewed source and evidence fingerprint',
        };
      }
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'waiting-for-approval',
        status: 'waiting-for-approval',
        reason: 'Human review requires an explicit approve-or-request-changes decision',
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
          reason: 'Current reviewer assessment approved the reviewed source attempt',
        };
      }
      if (assessment?.verdict === 'changes-requested') {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'blocked',
          status: 'failed',
          reason: 'Current reviewer assessment requested authoritative changes',
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
          reason: `Reviewer agent ended as ${reviewerRun.status} without an approved assessment`,
        };
      }
      if (reviewerRun?.status === 'succeeded' || reviewerRun?.status === 'waiting-for-approval') {
        return {
          edgeId: edge.id,
          type: edge.type,
          disposition: 'waiting',
          status: 'running',
          reason: 'Reviewer process completed and must publish a current assessment',
        };
      }
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'satisfied',
        status: 'succeeded',
        reason: 'Reviewed source succeeded; configured reviewer agent may run',
      };
    }
    const assessmentRequired = edge.config.requireApproval && configuredGateReviewer !== undefined;
    if (assessmentRequired && assessment === undefined) {
      return {
        edgeId: edge.id,
        type: edge.type,
        disposition: 'waiting',
        status: 'queued',
        reason: 'Review edge requires an assessment from its configured reviewer',
      };
    }
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'satisfied',
      status: 'succeeded',
      reason:
        assessment === undefined
          ? 'Gate review can proceed without a separate reviewer assessment'
          : 'Review completed without blocking findings',
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
      reason: 'Actionable review feedback activated a bounded revision attempt',
    };
  }
  if (loop.status === 'waiting-human') {
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'waiting-for-approval',
      status: 'waiting-for-approval',
      reason: 'Maximum revision attempts were exhausted; human escape is required',
    };
  }
  if (loop.status === 'satisfied') {
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'satisfied',
      status: 'succeeded',
      reason: `Revision loop satisfied by ${loop.stopCondition ?? 'configured stop condition'}`,
    };
  }
  if (loop.status === 'cancelled') {
    return {
      edgeId: edge.id,
      type: edge.type,
      disposition: 'inactive',
      status: 'cancelled',
      reason: 'Revision loop was cancelled by a human',
    };
  }
  return {
    edgeId: edge.id,
    type: edge.type,
    disposition: 'inactive',
    status: 'queued',
    reason: 'Revision edge activates only after a failed review',
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
  if (target.type !== 'agent') return [];
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
        throw new Error(`Context edge has not been verified by the host: ${edge.id}`);
      }
      const targetAttempt = runtime.run.nodeRuns[edge.targetNodeId]?.attempt;
      if (
        resolution.runId !== runtime.run.id ||
        resolution.sourceNodeId !== edge.sourceNodeId ||
        resolution.targetNodeId !== edge.targetNodeId ||
        resolution.targetAttempt !== targetAttempt ||
        JSON.stringify(uniqueSorted(resolution.attachmentIds)) !==
          JSON.stringify(uniqueSorted(edge.config.attachmentIds))
      ) {
        throw new Error(`Context edge is stale for the current target attempt: ${edge.id}`);
      }
      return [
        {
          edgeId: edge.id,
          sourceNodeId: edge.sourceNodeId,
          sourceType: nodeById(runtime, edge.sourceNodeId).type,
          attachmentIds: uniqueSorted(edge.config.attachmentIds),
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
      reasons: ['Node is outside the current scoped plan'],
    };
  }
  if (runtime.cancellationRequested || isTerminalRunStatus(runtime.run.status)) {
    return {
      nodeId,
      disposition: 'not-runnable',
      edgeEvaluations: [],
      reasons: [
        runtime.cancellationRequested ? 'Workflow cancellation was requested' : 'Workflow ended',
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
        reasons: [`Reviewed source did not succeed: ${failedSources.join(', ')}`],
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
        reasons: [`Reviewer waits for source: ${pendingSources.join(', ')}`],
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
