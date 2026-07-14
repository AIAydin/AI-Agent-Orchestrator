import type { CanvasNode } from '../domain.js';
import {
  WorkflowRunSchema,
  aggregateWorkflowStatus,
  isTerminalRunStatus,
  recoverInterruptedRun,
  requestWorkflowCancellation,
  transitionNodeRun,
  type NodeRunState,
  type ProcessReference,
} from '../workflow.js';

import { nodeById, reviewGateEvaluation } from './evidence-state.js';
import { evaluateNodeReadiness } from './evaluation.js';
import type { EdgeEvaluation, SchedulingSnapshot, WorkflowExecutionRuntime } from './types.js';

interface ResourceReservation {
  concurrency: number;
  cpuUnits: number;
  memoryMb: number;
  exclusiveKeys: Set<string>;
}

function activeReservation(runtime: WorkflowExecutionRuntime): ResourceReservation {
  const active = Object.values(runtime.run.nodeRuns).filter(
    (nodeRun) => nodeRun.status === 'running' || nodeRun.status === 'cancelling',
  );
  const nodes = active.map((nodeRun) => nodeById(runtime, nodeRun.nodeId));
  return {
    concurrency: nodes.length,
    cpuUnits: nodes.reduce((total, node) => total + node.resources.cpuUnits, 0),
    memoryMb: nodes.reduce((total, node) => total + node.resources.memoryMb, 0),
    exclusiveKeys: new Set(nodes.flatMap((node) => node.resources.exclusiveKeys)),
  };
}

function fitsReservation(
  runtime: WorkflowExecutionRuntime,
  reservation: ResourceReservation,
  node: CanvasNode,
): boolean {
  const limits = runtime.canvas.workflowLimits;
  return (
    reservation.concurrency + 1 <= limits.maximumConcurrency &&
    reservation.cpuUnits + node.resources.cpuUnits <= limits.maximumCpuUnits &&
    reservation.memoryMb + node.resources.memoryMb <= limits.maximumMemoryMb &&
    !node.resources.exclusiveKeys.some((key) => reservation.exclusiveKeys.has(key))
  );
}

function reserve(reservation: ResourceReservation, node: CanvasNode): void {
  reservation.concurrency += 1;
  reservation.cpuUnits += node.resources.cpuUnits;
  reservation.memoryMb += node.resources.memoryMb;
  node.resources.exclusiveKeys.forEach((key) => reservation.exclusiveKeys.add(key));
}

export function getSchedulingSnapshot(runtime: WorkflowExecutionRuntime): SchedulingSnapshot {
  const reservation = activeReservation(runtime);
  const initiallyReserved = {
    concurrency: reservation.concurrency,
    cpuUnits: reservation.cpuUnits,
    memoryMb: reservation.memoryMb,
    exclusiveKeys: [...reservation.exclusiveKeys].sort((left, right) => left.localeCompare(right)),
  };
  const order = runtime.plan.stages.flatMap((stage) => stage.nodeIds);
  const readiness = order.map((nodeId) => evaluateNodeReadiness(runtime, nodeId));
  const runnableNodeIds: string[] = [];
  for (const entry of readiness) {
    if (entry.disposition !== 'ready') continue;
    const node = nodeById(runtime, entry.nodeId);
    if (!fitsReservation(runtime, reservation, node)) continue;
    runnableNodeIds.push(node.id);
    reserve(reservation, node);
  }
  return {
    runnableNodeIds,
    waitingNodeIds: readiness
      .filter((entry) => entry.disposition === 'waiting')
      .map((entry) => entry.nodeId),
    waitingForApprovalNodeIds: readiness
      .filter((entry) => entry.disposition === 'waiting-for-approval')
      .map((entry) => entry.nodeId),
    blockedNodeIds: readiness
      .filter((entry) => entry.disposition === 'blocked')
      .map((entry) => entry.nodeId),
    activeNodeIds: Object.values(runtime.run.nodeRuns)
      .filter((nodeRun) => nodeRun.status === 'running' || nodeRun.status === 'cancelling')
      .map((nodeRun) => nodeRun.nodeId)
      .sort((left, right) => left.localeCompare(right)),
    reserved: initiallyReserved,
  };
}

export function replaceRunState(
  runtime: WorkflowExecutionRuntime,
  nodeRuns: Readonly<Record<string, NodeRunState>>,
  occurredAt: string,
): WorkflowExecutionRuntime {
  const status = aggregateWorkflowStatus(nodeRuns);
  return {
    ...runtime,
    run: WorkflowRunSchema.parse({
      schemaVersion: runtime.run.schemaVersion,
      id: runtime.run.id,
      canvasId: runtime.run.canvasId,
      planId: runtime.run.planId,
      status,
      nodeRuns,
      revisionLoops: runtime.run.revisionLoops,
      createdAt: runtime.run.createdAt,
      updatedAt: occurredAt,
      ...(isTerminalRunStatus(status) ? { endedAt: occurredAt } : {}),
    }),
  };
}

function blockIsDeferredByRevisionLoop(
  runtime: WorkflowExecutionRuntime,
  evaluation: EdgeEvaluation,
): boolean {
  const edge = runtime.canvas.edges.find((candidate) => candidate.id === evaluation.edgeId);
  return runtime.canvas.revisionLoops.some((loop) => {
    const state = runtime.run.revisionLoops[loop.id];
    const unresolved =
      state?.status === 'review-required' ||
      state?.status === 'revision-required' ||
      state?.status === 'waiting-human';
    if (!unresolved || edge === undefined) return false;
    if (edge.sourceNodeId === loop.reviewNodeId) return true;
    return (
      edge.type === 'execute' &&
      edge.config.approval === 'review-gate' &&
      edge.config.approvalGateNodeId === loop.reviewNodeId
    );
  });
}

/** Cancels definitively blocked descendants while leaving independent runnable/active siblings alone. */
export function settleBlockedWorkflowNodes(
  runtime: WorkflowExecutionRuntime,
  occurredAt: string,
): WorkflowExecutionRuntime {
  let settled = runtime;
  while (!isTerminalRunStatus(settled.run.status)) {
    const nodeRuns = { ...settled.run.nodeRuns };
    let changed = false;
    for (const [nodeId, nodeRun] of Object.entries(settled.run.nodeRuns)) {
      if (nodeRun.status !== 'queued' && nodeRun.status !== 'waiting-for-approval') continue;
      const readiness = evaluateNodeReadiness(settled, nodeId);
      if (readiness.disposition !== 'blocked') continue;
      const blockedEdges = readiness.edgeEvaluations.filter(
        (evaluation) => evaluation.disposition === 'blocked',
      );
      if (
        blockedEdges.length > 0 &&
        blockedEdges.every((evaluation) => blockIsDeferredByRevisionLoop(settled, evaluation))
      ) {
        continue;
      }
      nodeRuns[nodeId] = transitionNodeRun(nodeRun, {
        status: 'cancelled',
        occurredAt,
        reason: `Workflow node was blocked by authoritative upstream state: ${readiness.reasons.join('; ')}`,
      });
      changed = true;
    }
    if (!changed) return settled;
    settled = replaceRunState(settled, nodeRuns, occurredAt);
  }
  return settled;
}

export function markWaitingForApprovals(
  runtime: WorkflowExecutionRuntime,
  occurredAt: string,
): WorkflowExecutionRuntime {
  let changed = false;
  const nodeRuns = Object.fromEntries(
    Object.entries(runtime.run.nodeRuns).map(([nodeId, nodeRun]) => {
      if (
        nodeRun.status === 'queued' &&
        evaluateNodeReadiness(runtime, nodeId).disposition === 'waiting-for-approval'
      ) {
        changed = true;
        return [
          nodeId,
          transitionNodeRun(nodeRun, {
            status: 'waiting-for-approval',
            occurredAt,
            reason: 'A human decision is required before execution',
          }),
        ];
      }
      return [nodeId, nodeRun];
    }),
  );
  return changed ? replaceRunState(runtime, nodeRuns, occurredAt) : runtime;
}

export function startWorkflowNode(
  runtime: WorkflowExecutionRuntime,
  nodeId: string,
  process: ProcessReference,
  occurredAt: string,
): WorkflowExecutionRuntime {
  const readiness = evaluateNodeReadiness(runtime, nodeId);
  if (readiness.disposition !== 'ready') {
    throw new Error(
      `Node ${nodeId} is not runnable: ${readiness.reasons.join('; ') || readiness.disposition}`,
    );
  }
  const futureEvidence = runtime.canvas.edges.flatMap((edge) => {
    if (edge.targetNodeId !== nodeId || !runtime.plan.executableEdgeIds.includes(edge.id)) {
      return [];
    }
    const verifiedAt =
      edge.type === 'output'
        ? runtime.evidence.outputPublications[edge.id]?.verifiedAt
        : edge.type === 'context'
          ? runtime.evidence.contextResolutions[edge.id]?.verifiedAt
          : undefined;
    return verifiedAt !== undefined && Date.parse(verifiedAt) > Date.parse(occurredAt)
      ? [edge.id]
      : [];
  });
  if (futureEvidence.length > 0) {
    throw new Error(
      `Node ${nodeId} cannot start before incoming evidence is verified: ${futureEvidence.join(', ')}`,
    );
  }
  const reservation = activeReservation(runtime);
  const node = nodeById(runtime, nodeId);
  if (!fitsReservation(runtime, reservation, node)) {
    throw new Error(`Node ${nodeId} exceeds currently available workflow resources`);
  }
  const current = runtime.run.nodeRuns[nodeId];
  if (current === undefined) throw new Error(`Node is outside the current plan: ${nodeId}`);
  const next = transitionNodeRun(current, { status: 'running', occurredAt, process });
  return replaceRunState(runtime, { ...runtime.run.nodeRuns, [nodeId]: next }, occurredAt);
}

export type NodeCompletion =
  | { readonly status: 'succeeded' }
  | { readonly status: 'failed'; readonly failureCode: string; readonly reason: string }
  | { readonly status: 'lost'; readonly failureCode: string; readonly reason: string }
  | { readonly status: 'cancelled'; readonly reason: string };

export function completeWorkflowNode(
  runtime: WorkflowExecutionRuntime,
  nodeId: string,
  completion: NodeCompletion,
  occurredAt: string,
): WorkflowExecutionRuntime {
  const current = runtime.run.nodeRuns[nodeId];
  if (current === undefined) throw new Error(`Node is outside the current plan: ${nodeId}`);
  const node = nodeById(runtime, nodeId);
  if (completion.status === 'succeeded' && node.type === 'review-gate') {
    const gate = reviewGateEvaluation(runtime, nodeId);
    if (gate.status !== 'passed') {
      throw new Error(`Review gate ${nodeId} cannot succeed: ${gate.reasons.join('; ')}`);
    }
  }
  const directAgentReviews = runtime.canvas.edges.filter(
    (edge) =>
      edge.type === 'review' &&
      edge.config.reviewer === 'agent' &&
      edge.targetNodeId === nodeId &&
      runtime.plan.executableEdgeIds.includes(edge.id),
  );
  if (completion.status === 'succeeded' && directAgentReviews.length > 0) {
    const awaitingAssessment = transitionNodeRun(current, {
      status: 'waiting-for-approval',
      occurredAt,
      reason: 'Reviewer process completed and is awaiting current assessments',
    });
    return replaceRunState(
      runtime,
      { ...runtime.run.nodeRuns, [nodeId]: awaitingAssessment },
      occurredAt,
    );
  }
  let transitioned = current;
  if (completion.status === 'cancelled' && current.status === 'running') {
    transitioned = transitionNodeRun(current, {
      status: 'cancelling',
      occurredAt,
      reason: completion.reason,
    });
  }
  const next = transitionNodeRun(transitioned, {
    status: completion.status,
    occurredAt,
    ...(completion.status === 'failed' || completion.status === 'lost'
      ? { failureCode: completion.failureCode, reason: completion.reason }
      : completion.status === 'cancelled'
        ? { reason: completion.reason }
        : {}),
  });
  const updated = replaceRunState(runtime, { ...runtime.run.nodeRuns, [nodeId]: next }, occurredAt);
  const activeLoop = runtime.canvas.revisionLoops.find(
    (loop) =>
      loop.implementationNodeId === nodeId && runtime.activeRevisionLoopIds.includes(loop.id),
  );
  const completedRuntime =
    activeLoop === undefined || completion.status !== 'succeeded'
      ? updated
      : {
          ...updated,
          activeRevisionLoopIds: updated.activeRevisionLoopIds.filter((id) => id !== activeLoop.id),
        };
  return settleBlockedWorkflowNodes(completedRuntime, occurredAt);
}

export function cancelWorkflowExecution(
  runtime: WorkflowExecutionRuntime,
  occurredAt: string,
): WorkflowExecutionRuntime {
  return {
    ...runtime,
    run: requestWorkflowCancellation(runtime.run, occurredAt),
    cancellationRequested: true,
    activeRevisionLoopIds: [],
  };
}

export interface RuntimeRecoveryResult {
  readonly runtime: WorkflowExecutionRuntime;
  readonly lostNodeIds: readonly string[];
}

export function recoverWorkflowExecution(
  runtime: WorkflowExecutionRuntime,
  liveProcesses: ReadonlyMap<number, string>,
  occurredAt: string,
): RuntimeRecoveryResult {
  const recovered = recoverInterruptedRun(runtime.run, liveProcesses, occurredAt);
  const recoveredRuntime = settleBlockedWorkflowNodes(
    { ...runtime, run: recovered.run, activeRevisionLoopIds: [] },
    occurredAt,
  );
  return {
    runtime: recoveredRuntime,
    lostNodeIds: recovered.lostNodeIds,
  };
}
