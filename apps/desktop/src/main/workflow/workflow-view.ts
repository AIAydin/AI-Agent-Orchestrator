import {
  evaluateExecutableEdge,
  getRevisionEscapeRequest,
  getWorkflowHumanApprovalRequest,
} from '@forgeboard/core';
import { JsonValueSchema } from '@forgeboard/core/domain';

import {
  WorkflowExecutionViewSchema,
  type WorkflowExecutionView,
  type WorkflowNodeRunView,
} from '../../shared/workflow-contracts.js';
import type { WorkflowHostState } from './workflow-host.js';

export function workflowHostStateToView(state: WorkflowHostState): WorkflowExecutionView {
  const approvalNodeIds = new Set(state.approvals.map((approval) => approval.nodeId));
  const plannedEdges = new Set(state.runtime.plan.executableEdgeIds);
  return WorkflowExecutionViewSchema.parse({
    schemaVersion: 1,
    id: state.execution.id,
    projectId: state.execution.projectId,
    canvasId: state.execution.canvasId,
    status: state.runtime.run.status,
    revision: state.execution.revision,
    scope: state.runtime.plan.scope,
    planNodeIds: state.runtime.plan.nodeIds,
    nodeRuns: state.runtime.plan.nodeIds.map((nodeId) => {
      const run = state.runtime.run.nodeRuns[nodeId];
      if (run === undefined) throw new Error(`Workflow view is missing planned node ${nodeId}.`);
      return nodeRunView(run, approvalNodeIds.has(nodeId));
    }),
    edges: state.runtime.canvas.edges.map((edge) => {
      if (!plannedEdges.has(edge.id)) {
        return {
          edgeId: edge.id,
          type: edge.type,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          status: 'queued' as const,
          disposition: 'inactive' as const,
          reason: 'Connection is outside the current run scope',
        };
      }
      const evaluation = evaluateExecutableEdge(state.runtime, edge);
      return {
        edgeId: edge.id,
        type: edge.type,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        status: evaluation.status,
        disposition: evaluation.disposition,
        reason: evaluation.reason,
      };
    }),
    approvals: state.approvals,
    humanDecisions: humanDecisionRequests(state),
    revisionEscapes: revisionEscapeRequests(state),
    scheduling: {
      runnableNodeIds: state.scheduling.runnableNodeIds,
      waitingNodeIds: state.scheduling.waitingNodeIds,
      waitingForApprovalNodeIds: state.scheduling.waitingForApprovalNodeIds,
      blockedNodeIds: state.scheduling.blockedNodeIds,
      activeNodeIds: state.scheduling.activeNodeIds,
    },
    cancellationRequested: state.runtime.cancellationRequested,
    createdAt: state.runtime.run.createdAt,
    updatedAt: state.runtime.run.updatedAt,
    ...(state.runtime.run.endedAt === undefined ? {} : { endedAt: state.runtime.run.endedAt }),
  });
}

function humanDecisionRequests(state: WorkflowHostState) {
  const plannedEdges = new Set(state.runtime.plan.executableEdgeIds);
  const plannedNodes = new Set(state.runtime.plan.nodeIds);
  const candidateIds = [
    ...state.runtime.canvas.edges.flatMap((edge) => {
      if (!plannedEdges.has(edge.id)) return [];
      if (edge.type === 'execute' && edge.config.approval === 'human') return [edge.id];
      if (
        edge.type === 'review' &&
        edge.config.reviewer === 'human' &&
        edge.config.requireApproval
      ) {
        return [edge.id];
      }
      return [];
    }),
    ...state.runtime.canvas.nodes.flatMap((node) =>
      plannedNodes.has(node.id) && node.type === 'review-gate' && node.data.humanApprovalRequired
        ? [node.id]
        : [],
    ),
  ];
  return candidateIds.flatMap((targetId) => {
    try {
      const request = getWorkflowHumanApprovalRequest(state.runtime, targetId);
      return [
        {
          executionId: state.execution.id,
          targetId: request.targetId,
          targetType: request.targetType,
          targetAttempt: request.targetAttempt,
          evidenceFingerprint: request.evidenceFingerprint,
          evidence: boundEvidence(request.evidenceFingerprint, 'workflow-approval-v1:'),
        },
      ];
    } catch {
      return [];
    }
  });
}

function revisionEscapeRequests(state: WorkflowHostState) {
  return Object.entries(state.runtime.run.revisionLoops).flatMap(([loopId, loop]) => {
    if (loop.status !== 'waiting-human') return [];
    const request = getRevisionEscapeRequest(state.runtime, loopId);
    return [
      {
        executionId: state.execution.id,
        loopId: request.loopId,
        attemptsStarted: request.attemptsStarted,
        evidenceFingerprint: request.evidenceFingerprint,
        evidence: boundEvidence(request.evidenceFingerprint, 'revision-escape-v1:'),
      },
    ];
  });
}

function boundEvidence(fingerprint: string, prefix: string) {
  if (!fingerprint.startsWith(prefix)) {
    throw new Error('Workflow decision evidence has an unsupported binding format.');
  }
  return JsonValueSchema.parse(JSON.parse(fingerprint.slice(prefix.length)));
}

function nodeRunView(
  run: WorkflowHostState['runtime']['run']['nodeRuns'][string],
  approvalPending: boolean,
): WorkflowNodeRunView {
  return {
    nodeId: run.nodeId,
    status: approvalPending && run.status === 'queued' ? 'waiting-for-approval' : run.status,
    attempt: run.attempt,
    queuedAt: run.queuedAt,
    resumable: run.resumable,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    ...(run.failureCode === undefined ? {} : { failureCode: run.failureCode }),
    ...(run.statusReason === undefined ? {} : { statusReason: run.statusReason }),
    ...(run.process === undefined
      ? run.internalExecution === undefined
        ? {}
        : { execution: { kind: 'internal' as const } }
      : { execution: { kind: 'process' as const, pid: run.process.pid } }),
  };
}
