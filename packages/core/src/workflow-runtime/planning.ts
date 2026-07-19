import { CanvasSchema, type Canvas, type CanvasEdge, type CanvasNode } from '../model/domain.js';
import {
  NodeRunStateSchema,
  WorkflowRunSchema,
  WorkflowValidationError,
  createRevisionLoopState,
  planWorkflow,
  validateWorkflow,
} from '../workflow/model.js';

import type {
  RuntimeCreationOptions,
  ScopedWorkflowPlan,
  WorkflowExecutionRuntime,
  WorkflowRunScope,
} from './types.js';
import { uniqueSorted } from './utils.js';

function groupNodeIds(canvas: Canvas, groupId: string): readonly string[] {
  const group = canvas.groups.find((candidate) => candidate.id === groupId);
  const frame = canvas.nodes.find(
    (candidate): candidate is Extract<CanvasNode, { type: 'group-frame' }> =>
      candidate.id === groupId && candidate.type === 'group-frame',
  );
  const initial = group?.nodeIds ?? frame?.data.childNodeIds;
  if (initial !== undefined) {
    const result = new Set<string>();
    const visiting = new Set<string>();
    const visit = (nodeId: string): void => {
      if (result.has(nodeId) || visiting.has(nodeId)) return;
      visiting.add(nodeId);
      result.add(nodeId);
      const nested = canvas.nodes.find(
        (candidate): candidate is Extract<CanvasNode, { type: 'group-frame' }> =>
          candidate.id === nodeId && candidate.type === 'group-frame',
      );
      for (const childId of nested?.data.childNodeIds ?? []) visit(childId);
      visiting.delete(nodeId);
    };
    for (const nodeId of initial) visit(nodeId);
    return uniqueSorted([...result]);
  }
  throw new WorkflowValidationError([
    { code: 'INVALID_GROUP', message: 'Run group does not exist', entityIds: [groupId] },
  ]);
}

function scopeTargets(
  canvas: Canvas,
  scope: WorkflowRunScope,
  eligibleNodeIds?: readonly string[],
): { readonly targetNodeIds?: readonly string[]; readonly includeUpstream?: boolean } {
  const eligible = eligibleNodeIds === undefined ? undefined : new Set(eligibleNodeIds);
  if (eligible !== undefined) {
    const missing = [...eligible].filter(
      (nodeId) => !canvas.nodes.some((candidate) => candidate.id === nodeId),
    );
    if (missing.length > 0) {
      throw new WorkflowValidationError([
        {
          code: 'MISSING_NODE',
          message: 'Host capability target does not exist',
          entityIds: uniqueSorted(missing),
        },
      ]);
    }
  }
  if (scope.kind === 'workflow') {
    if (eligible === undefined) return {};
    if (eligible.size === 0) throw unavailableScope('Workflow does not contain runnable nodes', []);
    return { targetNodeIds: uniqueSorted([...eligible]), includeUpstream: true };
  }
  if (scope.kind === 'node') {
    if (eligible !== undefined && !eligible.has(scope.nodeId)) {
      throw unavailableScope('Selected node is not runnable in this application', [scope.nodeId]);
    }
    return { targetNodeIds: [scope.nodeId], includeUpstream: scope.includeUpstream ?? true };
  }
  if (scope.kind === 'selection') {
    if (scope.nodeIds.length === 0) {
      throw new WorkflowValidationError([
        { code: 'MISSING_NODE', message: 'Run selection cannot be empty', entityIds: [] },
      ]);
    }
    const unavailable =
      eligible === undefined ? [] : scope.nodeIds.filter((nodeId) => !eligible.has(nodeId));
    if (unavailable.length > 0) {
      throw unavailableScope(
        'Run selection contains nodes that are not runnable in this application',
        unavailable,
      );
    }
    return {
      targetNodeIds: uniqueSorted(scope.nodeIds),
      includeUpstream: scope.includeUpstream ?? true,
    };
  }
  const nodeIds = groupNodeIds(canvas, scope.groupId).filter(
    (nodeId) => eligible === undefined || eligible.has(nodeId),
  );
  if (nodeIds.length === 0) {
    throw new WorkflowValidationError([
      {
        code: 'INVALID_GROUP',
        message: 'Run group does not contain executable nodes',
        entityIds: [scope.groupId],
      },
    ]);
  }
  return { targetNodeIds: nodeIds, includeUpstream: scope.includeUpstream ?? true };
}

function unavailableScope(message: string, entityIds: readonly string[]): WorkflowValidationError {
  return new WorkflowValidationError([
    { code: 'NODE_UNAVAILABLE', message, entityIds: uniqueSorted(entityIds) },
  ]);
}

function isAuthoritativeIncomingEdge(edge: CanvasEdge): boolean {
  if (edge.type === 'dependency' || edge.type === 'execute') return true;
  if (edge.type === 'output') return edge.config.required;
  if (edge.type === 'review') return edge.config.requireApproval;
  return false;
}

function expandMandatoryPlanNodes(canvas: Canvas, initiallySelected: readonly string[]): string[] {
  const selected = new Set(initiallySelected);
  let changed = true;
  while (changed) {
    changed = false;
    const include = (nodeId: string): void => {
      if (selected.has(nodeId)) return;
      selected.add(nodeId);
      changed = true;
    };
    for (const edge of canvas.edges) {
      if (selected.has(edge.targetNodeId) && isAuthoritativeIncomingEdge(edge)) {
        include(edge.sourceNodeId);
      }
      if (
        selected.has(edge.targetNodeId) &&
        edge.type === 'execute' &&
        edge.config.approval === 'review-gate' &&
        edge.config.approvalGateNodeId !== undefined
      ) {
        include(edge.config.approvalGateNodeId);
      }
    }
    for (const nodeId of [...selected]) {
      const node = canvas.nodes.find((candidate) => candidate.id === nodeId);
      if (node?.type !== 'review-gate') continue;
      if (node.data.reviewerAgentId !== undefined) include(node.data.reviewerAgentId);
      for (const checkId of node.data.requiredCheckIds) {
        for (const producer of canvas.nodes) {
          if (producer.type === 'test' && producer.data.runIds.includes(checkId)) {
            include(producer.id);
          }
        }
      }
      for (const edge of canvas.edges) {
        if (edge.type === 'review' && edge.targetNodeId === node.id) include(edge.sourceNodeId);
        if (
          edge.type === 'execute' &&
          edge.config.approval === 'review-gate' &&
          edge.config.approvalGateNodeId === node.id
        ) {
          include(edge.sourceNodeId);
        }
      }
    }
  }
  return uniqueSorted([...selected]);
}

/**
 * Plans node, selection, group, or full-workflow execution. Context is deliberately data-only and
 * revision is deliberately loop-only; neither creates an ordinary DAG scheduling dependency.
 */
export function planWorkflowScope(
  untrustedCanvas: unknown,
  options: Pick<RuntimeCreationOptions, 'planId' | 'scope' | 'eligibleNodeIds'>,
): ScopedWorkflowPlan {
  const canvas = CanvasSchema.parse(untrustedCanvas);
  const validation = validateWorkflow(canvas);
  if (!validation.valid) throw new WorkflowValidationError(validation.issues);
  const targets = scopeTargets(canvas, options.scope, options.eligibleNodeIds);
  const planningCanvas: Canvas = {
    ...canvas,
    edges: canvas.edges.filter((edge) => edge.type !== 'context' && edge.type !== 'revision'),
    revisionLoops: [],
  };
  const initial = planWorkflow(planningCanvas, {
    planId: options.planId,
    ...(targets.targetNodeIds === undefined ? {} : { targetNodeIds: targets.targetNodeIds }),
    ...(targets.includeUpstream === undefined ? {} : { includeUpstream: targets.includeUpstream }),
  });
  const mandatoryNodeIds = expandMandatoryPlanNodes(canvas, initial.nodeIds);
  const base =
    mandatoryNodeIds.length === initial.nodeIds.length &&
    mandatoryNodeIds.every((nodeId, index) => initial.nodeIds[index] === nodeId)
      ? initial
      : planWorkflow(planningCanvas, {
          planId: options.planId,
          targetNodeIds: mandatoryNodeIds,
          includeUpstream: false,
        });
  const selected = new Set(base.nodeIds);
  return {
    ...base,
    scope: options.scope,
    executableEdgeIds: canvas.edges
      .filter(
        (edge) =>
          selected.has(edge.targetNodeId) &&
          (selected.has(edge.sourceNodeId) || edge.type === 'context'),
      )
      .map((edge) => edge.id)
      .sort((left, right) => left.localeCompare(right)),
    revisionLoopIds: canvas.revisionLoops
      .filter((loop) => selected.has(loop.implementationNodeId) && selected.has(loop.reviewNodeId))
      .map((loop) => loop.id)
      .sort((left, right) => left.localeCompare(right)),
  };
}

export function createWorkflowExecutionRuntime(
  untrustedCanvas: unknown,
  options: RuntimeCreationOptions,
): WorkflowExecutionRuntime {
  const canvas = CanvasSchema.parse(untrustedCanvas);
  const plan = planWorkflowScope(canvas, options);
  const loops = new Map(canvas.revisionLoops.map((loop) => [loop.id, loop]));
  const revisionLoops = Object.fromEntries(
    plan.revisionLoopIds.map((loopId) => {
      const loop = loops.get(loopId);
      if (loop === undefined) throw new Error(`Planned revision loop is missing: ${loopId}`);
      return [loopId, createRevisionLoopState(loop)];
    }),
  );
  const nodeRuns = Object.fromEntries(
    plan.nodeIds.map((nodeId) => [
      nodeId,
      NodeRunStateSchema.parse({
        nodeId,
        status: 'queued',
        attempt: 1,
        queuedAt: options.occurredAt,
        resumable: false,
      }),
    ]),
  );
  return {
    canvas,
    plan,
    run: WorkflowRunSchema.parse({
      schemaVersion: 1,
      id: options.runId,
      canvasId: canvas.id,
      planId: plan.id,
      status: 'queued',
      nodeRuns,
      revisionLoops,
      createdAt: options.occurredAt,
      updatedAt: options.occurredAt,
    }),
    evidence: {
      humanApprovals: {},
      humanReviewDecisions: {},
      contextResolutions: {},
      outputPublications: {},
      nodeCompletionOutputs: {},
      reviewerAssessments: {},
      gateChecks: {},
      revisionEscapes: {},
    },
    activeRevisionLoopIds: [],
    cancellationRequested: false,
  };
}
