import { z } from 'zod';

import {
  CURRENT_SCHEMA_VERSION,
  CanvasSchema,
  EntityIdSchema,
  JsonValueSchema,
  RunStatusSchema,
  TimestampSchema,
  type Canvas,
  type CanvasEdge,
  type RevisionLoop,
  type RunStatus,
} from './domain.js';

export const ProcessReferenceSchema = z
  .object({
    pid: z.number().int().positive(),
    startedAt: TimestampSchema,
    identityToken: z.string().min(8).max(512),
  })
  .strict();
export type ProcessReference = z.infer<typeof ProcessReferenceSchema>;

export const NodeRunStateSchema = z
  .object({
    nodeId: EntityIdSchema,
    status: RunStatusSchema,
    attempt: z.number().int().positive(),
    queuedAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    endedAt: TimestampSchema.optional(),
    process: ProcessReferenceSchema.optional(),
    resumable: z.boolean().default(false),
    failureCode: z.string().min(1).max(300).optional(),
    statusReason: z.string().min(1).max(20_000).optional(),
  })
  .strict()
  .superRefine((run, context) => {
    if ((run.status === 'running' || run.status === 'cancelling') && run.process === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['process'],
        message: `${run.status} runs require a live process reference`,
      });
    }
    if (isTerminalRunStatus(run.status) && run.endedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: 'Terminal runs require an end timestamp',
      });
    }
  });
export type NodeRunState = z.infer<typeof NodeRunStateSchema>;

export const WorkflowRunSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    canvasId: EntityIdSchema,
    planId: EntityIdSchema,
    status: RunStatusSchema,
    nodeRuns: z.record(NodeRunStateSchema),
    revisionLoops: z.record(
      z
        .object({
          loopId: EntityIdSchema,
          attemptsStarted: z.number().int().positive(),
          status: z.enum([
            'review-required',
            'revision-required',
            'waiting-human',
            'satisfied',
            'cancelled',
          ]),
          lastFeedback: z.string().max(200_000).optional(),
          stopCondition: z.enum(['review-approved', 'tests-passed', 'human-accepted']).optional(),
          eligibleAt: TimestampSchema.optional(),
        })
        .strict(),
    ),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    endedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    for (const [nodeId, nodeRun] of Object.entries(run.nodeRuns)) {
      if (nodeRun.nodeId !== nodeId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodeRuns', nodeId, 'nodeId'],
          message: 'Node-run map keys must match their embedded node id',
        });
      }
    }
    if (isTerminalRunStatus(run.status) && run.endedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: 'Terminal workflow runs require an end timestamp',
      });
    }
    if (
      isTerminalRunStatus(run.status) &&
      Object.values(run.nodeRuns).some((nodeRun) => !isTerminalRunStatus(nodeRun.status))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'A workflow cannot be terminal while any node run is still active or queued',
      });
    }
  });
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type RevisionLoopState = WorkflowRun['revisionLoops'][string];

export const RunEventSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    runId: EntityIdSchema,
    nodeId: EntityIdSchema.optional(),
    sequence: z.number().int().nonnegative(),
    type: z.enum([
      'queued',
      'started',
      'output',
      'approval-requested',
      'approved',
      'paused',
      'cancel-requested',
      'cancelled',
      'failed',
      'succeeded',
      'retry',
      'recovered',
      'lost',
    ]),
    occurredAt: TimestampSchema,
    payload: JsonValueSchema,
  })
  .strict();
export type RunEvent = z.infer<typeof RunEventSchema>;

export const TranscriptRecordSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    id: EntityIdSchema,
    runId: EntityIdSchema,
    sessionId: EntityIdSchema,
    storageReference: z.string().min(1).max(4096),
    byteLength: z.number().int().nonnegative(),
    contentHash: z.string().min(8).max(256),
    truncated: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type TranscriptRecord = z.infer<typeof TranscriptRecordSchema>;

export interface WorkflowValidationIssue {
  readonly code:
    | 'DUPLICATE_ID'
    | 'MISSING_NODE'
    | 'SELF_EDGE'
    | 'INVALID_EDGE_TARGET'
    | 'INVALID_EDGE_SOURCE'
    | 'CYCLE'
    | 'UNREGISTERED_REVISION_EDGE'
    | 'INVALID_REVISION_LOOP'
    | 'DUPLICATE_LOOP_EDGE'
    | 'MISSING_REQUIRED_CONTEXT'
    | 'INVALID_REVIEWER'
    | 'INVALID_REVIEW_TARGET'
    | 'MISSING_CHECK_PRODUCER'
    | 'MISSING_CHECK_INPUT'
    | 'AMBIGUOUS_CHECK_PRODUCER'
    | 'INVALID_GATE_SOURCE'
    | 'RETRY_POLICY_MISMATCH'
    | 'UNACHIEVABLE_STOP_CONDITION'
    | 'INVALID_GROUP'
    | 'RESOURCE_LIMIT'
    | 'MISSING_NODE_CONFIGURATION'
    | 'MISSING_EDGE_CONFIGURATION'
    | 'NODE_UNAVAILABLE';
  readonly message: string;
  readonly entityIds: readonly string[];
}

export interface WorkflowValidationResult {
  readonly valid: boolean;
  readonly issues: readonly WorkflowValidationIssue[];
  readonly topologicalOrder: readonly string[];
}

function orderingEdges(edges: readonly CanvasEdge[]): readonly CanvasEdge[] {
  return edges.filter((edge) => edge.type !== 'revision');
}

function sortedInsert(values: string[], value: string): void {
  const index = values.findIndex((candidate) => candidate.localeCompare(value) > 0);
  if (index === -1) values.push(value);
  else values.splice(index, 0, value);
}

function deterministicTopologicalOrder(
  nodeIds: readonly string[],
  edges: readonly CanvasEdge[],
): { order: readonly string[]; remaining: readonly string[] } {
  const selected = new Set(nodeIds);
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (!selected.has(edge.sourceNodeId) || !selected.has(edge.targetNodeId)) continue;
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
    outgoing.get(edge.sourceNodeId)?.push(edge.targetNodeId);
  }
  for (const targets of outgoing.values()) targets.sort((left, right) => left.localeCompare(right));

  const ready = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right));
  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    order.push(current);
    for (const target of outgoing.get(current) ?? []) {
      const degree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, degree);
      if (degree === 0) sortedInsert(ready, target);
    }
  }
  return {
    order,
    remaining: nodeIds
      .filter((id) => !order.includes(id))
      .sort((left, right) => left.localeCompare(right)),
  };
}

function pushIssue(
  issues: WorkflowValidationIssue[],
  code: WorkflowValidationIssue['code'],
  message: string,
  ...entityIds: string[]
): void {
  issues.push({ code, message, entityIds });
}

function missingNodeConfiguration(node: Canvas['nodes'][number]): readonly string[] {
  switch (node.type) {
    case 'agent':
      return [
        ...(node.data.adapterId === undefined ? ['agent adapter'] : []),
        ...(node.data.permissionProfileId === undefined ? ['permission profile'] : []),
      ];
    case 'file':
      return node.data.file === undefined ? ['project file'] : [];
    case 'diff-review':
      return [
        ...(node.data.baseRef === undefined ? ['base ref'] : []),
        ...(node.data.headRef === undefined ? ['head ref'] : []),
        ...(node.data.worktreeId === undefined ? ['worktree'] : []),
      ];
    case 'terminal':
      return node.data.permissionProfileId === undefined ? ['permission profile'] : [];
    case 'web-preview':
      return node.data.worktreeId === undefined ? ['worktree'] : [];
    case 'mobile-preview':
      return [
        ...(node.data.worktreeId === undefined ? ['worktree'] : []),
        ...(node.data.viewports.length === 0 ? ['preview viewport'] : []),
      ];
    case 'test':
      return node.data.command === undefined ? ['check command'] : [];
    case 'git-pr':
      return [
        ...(node.data.worktreeId === undefined ? ['worktree'] : []),
        ...(node.data.branch === undefined ? ['branch'] : []),
        ...(node.data.baseBranch === undefined ? ['base branch'] : []),
      ];
    default:
      return [];
  }
}

/**
 * Validates only the operational fields needed to execute the requested nodes. Draft canvases stay
 * schema-valid without fabricated paths, worktrees, commands, or branches; execution remains
 * fail-closed once a plan selects one of those drafts.
 */
export function validateWorkflowExecutionConfiguration(
  untrustedCanvas: unknown,
  nodeIds?: readonly string[],
): readonly WorkflowValidationIssue[] {
  const canvas = CanvasSchema.parse(untrustedCanvas);
  const selected = nodeIds === undefined ? undefined : new Set(nodeIds);
  const issues: WorkflowValidationIssue[] = [];
  for (const node of canvas.nodes) {
    if (selected !== undefined && !selected.has(node.id)) continue;
    const missing = missingNodeConfiguration(node);
    if (missing.length > 0) {
      pushIssue(
        issues,
        'MISSING_NODE_CONFIGURATION',
        `${node.title} requires ${missing.join(', ')} before it can run`,
        node.id,
      );
    }
    if (node.type === 'extension' && node.data.availability !== 'active') {
      pushIssue(
        issues,
        'NODE_UNAVAILABLE',
        `${node.title} cannot run while its extension is ${node.data.availability}`,
        node.id,
      );
    }
  }
  for (const edge of canvas.edges) {
    if (
      selected !== undefined &&
      (!selected.has(edge.sourceNodeId) || !selected.has(edge.targetNodeId))
    ) {
      continue;
    }
    if (edge.type === 'revision' && edge.config.loopId === undefined) {
      pushIssue(
        issues,
        'MISSING_EDGE_CONFIGURATION',
        'Revision edge requires a bounded loop before it can run',
        edge.id,
      );
    }
  }
  return issues;
}

export function validateWorkflow(untrustedCanvas: unknown): WorkflowValidationResult {
  const canvas = CanvasSchema.parse(untrustedCanvas);
  const issues: WorkflowValidationIssue[] = [];
  const nodeById = new Map<string, Canvas['nodes'][number]>();
  const edgeById = new Map<string, CanvasEdge>();
  const allIds = new Set<string>();

  for (const node of canvas.nodes) {
    if (allIds.has(node.id))
      pushIssue(issues, 'DUPLICATE_ID', `Duplicate node id: ${node.id}`, node.id);
    allIds.add(node.id);
    nodeById.set(node.id, node);
  }
  for (const edge of canvas.edges) {
    if (allIds.has(edge.id))
      pushIssue(issues, 'DUPLICATE_ID', `Duplicate edge id: ${edge.id}`, edge.id);
    allIds.add(edge.id);
    edgeById.set(edge.id, edge);
    const source = nodeById.get(edge.sourceNodeId);
    const target = nodeById.get(edge.targetNodeId);
    if (source === undefined)
      pushIssue(issues, 'MISSING_NODE', 'Edge source does not exist', edge.id, edge.sourceNodeId);
    if (target === undefined)
      pushIssue(issues, 'MISSING_NODE', 'Edge target does not exist', edge.id, edge.targetNodeId);
    if (edge.sourceNodeId === edge.targetNodeId)
      pushIssue(issues, 'SELF_EDGE', 'Self edges are not executable', edge.id);

    if (edge.type === 'context' && target?.type !== 'agent') {
      pushIssue(
        issues,
        'INVALID_EDGE_TARGET',
        'Context edges must target an agent node',
        edge.id,
        edge.targetNodeId,
      );
    }
    if (edge.type === 'context' && edge.config.required && edge.config.attachmentIds.length === 0) {
      pushIssue(
        issues,
        'MISSING_REQUIRED_CONTEXT',
        'Required context edges must select at least one explicit attachment',
        edge.id,
      );
    }
    if (edge.type === 'review' && edge.config.reviewer === 'agent' && target?.type !== 'agent') {
      pushIssue(
        issues,
        'INVALID_REVIEWER',
        'Agent review edges must target the configured reviewer agent',
        edge.id,
        edge.targetNodeId,
      );
    }
    if (
      edge.type === 'review' &&
      edge.config.reviewer === 'gate' &&
      target?.type !== 'review-gate'
    ) {
      pushIssue(
        issues,
        'INVALID_REVIEWER',
        'Gate review edges must target a review-gate node',
        edge.id,
        edge.targetNodeId,
      );
    }
    if (edge.type === 'review' && edge.config.reviewer === 'human') {
      if (target?.type !== 'diff-review') {
        pushIssue(
          issues,
          'INVALID_REVIEW_TARGET',
          'Human review edges must target a dedicated diff-review node',
          edge.id,
          edge.targetNodeId,
        );
      }
      if (!edge.config.requireApproval) {
        pushIssue(
          issues,
          'INVALID_REVIEW_TARGET',
          'Human review edges must require an explicit decision',
          edge.id,
          edge.targetNodeId,
        );
      }
    }
    if (edge.type === 'dependency' && source?.type !== 'task') {
      pushIssue(
        issues,
        'INVALID_EDGE_SOURCE',
        'Dependency edges must start at task nodes',
        edge.id,
        edge.sourceNodeId,
      );
    }
    if (edge.type === 'dependency' && target?.type !== 'task') {
      pushIssue(
        issues,
        'INVALID_EDGE_TARGET',
        'Dependency edges must target task nodes',
        edge.id,
        edge.targetNodeId,
      );
    }
    if (edge.type === 'execute' && edge.config.approval === 'review-gate') {
      const gate = nodeById.get(edge.config.approvalGateNodeId ?? '');
      if (gate?.type !== 'review-gate') {
        pushIssue(
          issues,
          'INVALID_EDGE_TARGET',
          'Execute approval references a missing or invalid review gate',
          edge.id,
        );
      }
    }
  }

  const humanReviewTargetIds = new Set(
    canvas.edges.flatMap((edge) =>
      edge.type === 'review' && edge.config.reviewer === 'human' ? [edge.targetNodeId] : [],
    ),
  );
  for (const targetNodeId of humanReviewTargetIds) {
    const incomingReviews = canvas.edges.filter(
      (edge): edge is Extract<CanvasEdge, { type: 'review' }> =>
        edge.type === 'review' && edge.targetNodeId === targetNodeId,
    );
    if (incomingReviews.length !== 1) {
      pushIssue(
        issues,
        'INVALID_REVIEW_TARGET',
        'A dedicated human review node must own exactly one incoming review decision',
        targetNodeId,
        ...incomingReviews.map((edge) => edge.id),
      );
    }
    const humanReview = incomingReviews.find((edge) => edge.config.reviewer === 'human');
    const conflictingInputs = canvas.edges.filter(
      (edge) =>
        edge.targetNodeId === targetNodeId &&
        edge.id !== humanReview?.id &&
        !(
          edge.type === 'output' &&
          humanReview !== undefined &&
          edge.sourceNodeId === humanReview.sourceNodeId
        ),
    );
    if (incomingReviews.length === 1 && conflictingInputs.length > 0) {
      pushIssue(
        issues,
        'INVALID_REVIEW_TARGET',
        'A dedicated human review node cannot share unrelated incoming controls or evidence',
        targetNodeId,
        ...conflictingInputs.map((edge) => edge.id),
      );
    }
  }

  for (const gate of canvas.nodes.filter(
    (node): node is Extract<Canvas['nodes'][number], { type: 'review-gate' }> =>
      node.type === 'review-gate',
  )) {
    const reviewerId = gate.data.reviewerAgentId;
    if (reviewerId !== undefined) {
      const reviewer = nodeById.get(reviewerId);
      if (reviewer?.type !== 'agent') {
        pushIssue(
          issues,
          'INVALID_REVIEWER',
          'A review-gate reviewer must reference an existing agent node',
          gate.id,
          reviewerId,
        );
      }
      if (!canvas.edges.some((edge) => edge.type === 'review' && edge.targetNodeId === gate.id)) {
        pushIssue(
          issues,
          'INVALID_REVIEWER',
          'A review-gate reviewer requires an explicit review edge for its assessment',
          gate.id,
          reviewerId,
        );
      }
    }

    if (
      (gate.data.testsRequired || gate.data.lintRequired) &&
      gate.data.requiredCheckIds.length === 0
    ) {
      pushIssue(
        issues,
        'MISSING_CHECK_PRODUCER',
        'Kind-level deterministic gates must name at least one required check producer',
        gate.id,
      );
    }
    for (const checkId of gate.data.requiredCheckIds) {
      const producers = canvas.nodes.filter(
        (node) => node.type === 'test' && node.data.runIds.includes(checkId),
      );
      if (producers.length === 0) {
        pushIssue(
          issues,
          'MISSING_CHECK_PRODUCER',
          'Every required check must map to a planned test node',
          gate.id,
          checkId,
        );
      } else if (producers.length > 1) {
        pushIssue(
          issues,
          'AMBIGUOUS_CHECK_PRODUCER',
          'A required check id can belong to only one test node',
          gate.id,
          checkId,
          ...producers.map((producer) => producer.id),
        );
      }
    }

    const reviewedSourceIds = new Set<string>();
    for (const edge of canvas.edges) {
      if (edge.type === 'review' && edge.targetNodeId === gate.id) {
        reviewedSourceIds.add(edge.sourceNodeId);
      }
      if (
        edge.type === 'execute' &&
        edge.config.approval === 'review-gate' &&
        edge.config.approvalGateNodeId === gate.id
      ) {
        reviewedSourceIds.add(edge.sourceNodeId);
      }
    }
    for (const loop of canvas.revisionLoops) {
      if (loop.reviewNodeId === gate.id) reviewedSourceIds.add(loop.implementationNodeId);
    }
    const requiresReviewedSource =
      gate.data.requiredCheckIds.length > 0 ||
      gate.data.testsRequired ||
      gate.data.lintRequired ||
      reviewerId !== undefined ||
      gate.data.humanApprovalRequired;
    if (requiresReviewedSource && reviewedSourceIds.size !== 1) {
      pushIssue(
        issues,
        'INVALID_GATE_SOURCE',
        'A nontrivial review gate must resolve to exactly one reviewed source node',
        gate.id,
        ...reviewedSourceIds,
      );
    }
    if (reviewedSourceIds.size === 1) {
      const reviewedSourceId = [...reviewedSourceIds][0]!;
      for (const checkId of gate.data.requiredCheckIds) {
        const producers = canvas.nodes.filter(
          (node) => node.type === 'test' && node.data.runIds.includes(checkId),
        );
        if (
          producers.length === 1 &&
          !canvas.edges.some(
            (edge) =>
              edge.type === 'output' &&
              edge.config.required &&
              edge.sourceNodeId === reviewedSourceId &&
              edge.targetNodeId === producers[0]!.id,
          )
        ) {
          pushIssue(
            issues,
            'MISSING_CHECK_INPUT',
            'A required check producer must consume a required verified output from the reviewed source',
            gate.id,
            checkId,
            reviewedSourceId,
            producers[0]!.id,
          );
        }
      }
    }
    if (reviewerId !== undefined && reviewedSourceIds.has(reviewerId)) {
      pushIssue(
        issues,
        'INVALID_REVIEWER',
        'A review-gate reviewer must be different from the reviewed source node',
        gate.id,
        reviewerId,
      );
    }
  }

  const revisionEdgeOwners = new Map<string, string>();
  const reviewEdgeOwners = new Map<string, string>();
  for (const loop of canvas.revisionLoops) {
    if (allIds.has(loop.id))
      pushIssue(issues, 'DUPLICATE_ID', `Duplicate revision-loop id: ${loop.id}`, loop.id);
    allIds.add(loop.id);
    const reviewEdge = edgeById.get(loop.reviewEdgeId);
    const revisionEdge = edgeById.get(loop.revisionEdgeId);
    const existingReviewOwner = reviewEdgeOwners.get(loop.reviewEdgeId);
    if (existingReviewOwner !== undefined) {
      pushIssue(
        issues,
        'DUPLICATE_LOOP_EDGE',
        'A review edge can belong to only one bounded loop',
        loop.id,
        existingReviewOwner,
        loop.reviewEdgeId,
      );
    }
    reviewEdgeOwners.set(loop.reviewEdgeId, loop.id);
    const existingOwner = revisionEdgeOwners.get(loop.revisionEdgeId);
    if (existingOwner !== undefined) {
      pushIssue(
        issues,
        'DUPLICATE_LOOP_EDGE',
        'A revision edge can belong to only one bounded loop',
        loop.id,
        existingOwner,
        loop.revisionEdgeId,
      );
    }
    revisionEdgeOwners.set(loop.revisionEdgeId, loop.id);
    const validReview =
      reviewEdge?.type === 'review' &&
      reviewEdge.config.requireApproval &&
      reviewEdge.sourceNodeId === loop.implementationNodeId &&
      reviewEdge.targetNodeId === loop.reviewNodeId;
    const validRevision =
      revisionEdge?.type === 'revision' &&
      revisionEdge.config.loopId === loop.id &&
      revisionEdge.sourceNodeId === loop.reviewNodeId &&
      revisionEdge.targetNodeId === loop.implementationNodeId;
    if (!validReview || !validRevision) {
      pushIssue(
        issues,
        'INVALID_REVISION_LOOP',
        'Bounded loop edges must form implementation -> review -> implementation',
        loop.id,
      );
    }
    const reviewNode = nodeById.get(loop.reviewNodeId);
    if (
      reviewNode?.type === 'review-gate' &&
      reviewNode.data.retryPolicy.maximumIterations !== loop.maximumAttempts
    ) {
      pushIssue(
        issues,
        'RETRY_POLICY_MISMATCH',
        'Review-gate retry iterations must equal the bounded revision-loop attempt limit',
        loop.id,
        reviewNode.id,
      );
    }
    const deterministicTestStopAchievable =
      reviewNode?.type === 'review-gate' &&
      (reviewNode.data.requiredCheckIds.length > 0 ||
        reviewNode.data.testsRequired ||
        reviewNode.data.lintRequired);
    if (loop.stopConditions.includes('tests-passed') && !deterministicTestStopAchievable) {
      pushIssue(
        issues,
        'UNACHIEVABLE_STOP_CONDITION',
        'The tests-passed stop condition requires a deterministic review gate',
        loop.id,
        loop.reviewNodeId,
      );
    }
    if (
      !loop.stopConditions.includes('review-approved') &&
      !(loop.stopConditions.includes('tests-passed') && deterministicTestStopAchievable)
    ) {
      pushIssue(
        issues,
        'UNACHIEVABLE_STOP_CONDITION',
        'A revision loop requires an automatic success stop condition before human escape',
        loop.id,
        ...loop.stopConditions,
      );
    }
  }
  for (const edge of canvas.edges) {
    if (
      edge.type === 'revision' &&
      edge.config.loopId !== undefined &&
      !revisionEdgeOwners.has(edge.id)
    ) {
      pushIssue(
        issues,
        'UNREGISTERED_REVISION_EDGE',
        'Revision edges are valid only inside an explicit bounded loop',
        edge.id,
      );
    }
  }

  const groupIds = new Set(canvas.groups.map((group) => group.id));
  for (const group of canvas.groups) {
    if (allIds.has(group.id))
      pushIssue(issues, 'DUPLICATE_ID', `Duplicate group id: ${group.id}`, group.id);
    allIds.add(group.id);
    for (const nodeId of group.nodeIds) {
      if (!nodeById.has(nodeId))
        pushIssue(issues, 'INVALID_GROUP', 'Group references a missing node', group.id, nodeId);
    }
  }
  for (const node of canvas.nodes) {
    if (node.groupId !== undefined && !groupIds.has(node.groupId)) {
      pushIssue(issues, 'INVALID_GROUP', 'Node references a missing group', node.id, node.groupId);
    }
    if (
      node.resources.cpuUnits > canvas.workflowLimits.maximumCpuUnits ||
      node.resources.memoryMb > canvas.workflowLimits.maximumMemoryMb
    ) {
      pushIssue(issues, 'RESOURCE_LIMIT', 'Node requirements exceed workflow capacity', node.id);
    }
  }

  const nodeIds = canvas.nodes.map((node) => node.id);
  const topology = deterministicTopologicalOrder(nodeIds, orderingEdges(canvas.edges));
  if (topology.remaining.length > 0) {
    pushIssue(issues, 'CYCLE', 'Workflow contains an unbounded cycle', ...topology.remaining);
  }
  return { valid: issues.length === 0, issues, topologicalOrder: topology.order };
}

export class WorkflowValidationError extends Error {
  public readonly issues: readonly WorkflowValidationIssue[];

  public constructor(issues: readonly WorkflowValidationIssue[]) {
    super(
      `Workflow validation failed with ${issues.length} issue${issues.length === 1 ? '' : 's'}`,
    );
    this.name = 'WorkflowValidationError';
    this.issues = issues;
  }
}

export const WorkflowPlanStageSchema = z
  .object({
    index: z.number().int().nonnegative(),
    nodeIds: z.array(EntityIdSchema).min(1),
    cpuUnits: z.number().int().positive(),
    memoryMb: z.number().int().positive(),
  })
  .strict();
export type WorkflowPlanStage = z.infer<typeof WorkflowPlanStageSchema>;

export const WorkflowPlanSchema = z
  .object({
    id: EntityIdSchema,
    canvasId: EntityIdSchema,
    nodeIds: z.array(EntityIdSchema),
    stages: z.array(WorkflowPlanStageSchema),
    dependencies: z.record(z.array(EntityIdSchema)),
    revisionLoopIds: z.array(EntityIdSchema),
  })
  .strict()
  .superRefine((plan, context) => {
    plan.stages.forEach((stage, index) => {
      if (stage.index !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', index, 'index'],
          message: 'Workflow stage indexes must be contiguous and deterministic',
        });
      }
    });
  });
export type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;

export interface WorkflowPlanOptions {
  readonly planId: string;
  readonly targetNodeIds?: readonly string[];
  readonly includeUpstream?: boolean;
}

function collectSelectedNodeIds(canvas: Canvas, options: WorkflowPlanOptions): Set<string> {
  if (options.targetNodeIds === undefined) return new Set(canvas.nodes.map((node) => node.id));
  const selected = new Set(options.targetNodeIds);
  if (options.includeUpstream === false) return selected;
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of orderingEdges(canvas.edges)) {
      if (selected.has(edge.targetNodeId) && !selected.has(edge.sourceNodeId)) {
        selected.add(edge.sourceNodeId);
        changed = true;
      }
    }
  }
  return selected;
}

export function planWorkflow(untrustedCanvas: unknown, options: WorkflowPlanOptions): WorkflowPlan {
  const canvas = CanvasSchema.parse(untrustedCanvas);
  const validation = validateWorkflow(canvas);
  const nodeById = new Map(canvas.nodes.map((node) => [node.id, node]));
  if (options.targetNodeIds?.some((id) => !nodeById.has(id)) === true) {
    const missing = options.targetNodeIds.filter((id) => !nodeById.has(id));
    throw new WorkflowValidationError([
      { code: 'MISSING_NODE', message: 'Plan target does not exist', entityIds: missing },
    ]);
  }
  if (!validation.valid) throw new WorkflowValidationError(validation.issues);

  const selected = collectSelectedNodeIds(canvas, options);
  const selectedIds = [...selected].sort((left, right) => left.localeCompare(right));
  const configurationIssues = validateWorkflowExecutionConfiguration(canvas, selectedIds);
  if (configurationIssues.length > 0) throw new WorkflowValidationError(configurationIssues);
  const selectedEdges = orderingEdges(canvas.edges).filter(
    (edge) => selected.has(edge.sourceNodeId) && selected.has(edge.targetNodeId),
  );
  const dependencies = Object.fromEntries(
    selectedIds.map((id) => [
      id,
      selectedEdges
        .filter((edge) => edge.targetNodeId === id)
        .map((edge) => edge.sourceNodeId)
        .sort((left, right) => left.localeCompare(right)),
    ]),
  );

  const remaining = new Set(selectedIds);
  const completed = new Set<string>();
  const stages: WorkflowPlanStage[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => dependencies[id]?.every((dependency) => completed.has(dependency)) === true)
      .sort((left, right) => left.localeCompare(right));
    if (ready.length === 0) {
      throw new WorkflowValidationError([
        { code: 'CYCLE', message: 'No nodes can be scheduled', entityIds: [...remaining] },
      ]);
    }

    const stageNodes: string[] = [];
    const exclusiveKeys = new Set<string>();
    let cpuUnits = 0;
    let memoryMb = 0;
    for (const id of ready) {
      const node = nodeById.get(id);
      if (node === undefined) continue;
      const conflicts = node.resources.exclusiveKeys.some((key) => exclusiveKeys.has(key));
      const fits =
        stageNodes.length < canvas.workflowLimits.maximumConcurrency &&
        cpuUnits + node.resources.cpuUnits <= canvas.workflowLimits.maximumCpuUnits &&
        memoryMb + node.resources.memoryMb <= canvas.workflowLimits.maximumMemoryMb &&
        !conflicts;
      if (!fits) continue;
      stageNodes.push(id);
      cpuUnits += node.resources.cpuUnits;
      memoryMb += node.resources.memoryMb;
      node.resources.exclusiveKeys.forEach((key) => exclusiveKeys.add(key));
    }
    if (stageNodes.length === 0) {
      throw new WorkflowValidationError([
        {
          code: 'RESOURCE_LIMIT',
          message: 'Ready nodes cannot fit resource limits',
          entityIds: ready,
        },
      ]);
    }
    stages.push({ index: stages.length, nodeIds: stageNodes, cpuUnits, memoryMb });
    for (const id of stageNodes) {
      remaining.delete(id);
      completed.add(id);
    }
  }

  return WorkflowPlanSchema.parse({
    id: options.planId,
    canvasId: canvas.id,
    nodeIds: selectedIds,
    stages,
    dependencies,
    revisionLoopIds: canvas.revisionLoops
      .filter((loop) => selected.has(loop.implementationNodeId) || selected.has(loop.reviewNodeId))
      .map((loop) => loop.id)
      .sort((left, right) => left.localeCompare(right)),
  });
}

const TERMINAL_RUN_STATUSES = new Set<RunStatus>(['failed', 'succeeded', 'cancelled', 'lost']);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  queued: new Set(['running', 'waiting-for-approval', 'cancelled']),
  running: new Set(['waiting-for-approval', 'paused', 'cancelling', 'failed', 'succeeded', 'lost']),
  'waiting-for-approval': new Set(['queued', 'running', 'cancelled']),
  paused: new Set(['running', 'cancelled', 'lost']),
  cancelling: new Set(['cancelled', 'failed', 'lost']),
  failed: new Set(['queued']),
  succeeded: new Set(),
  cancelled: new Set(),
  lost: new Set(['queued', 'paused']),
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export interface NodeRunTransition {
  readonly status: RunStatus;
  readonly occurredAt: string;
  readonly process?: ProcessReference;
  readonly reason?: string;
  readonly failureCode?: string;
}

export function transitionNodeRun(
  current: NodeRunState,
  transition: NodeRunTransition,
): NodeRunState {
  if (!canTransitionRun(current.status, transition.status)) {
    throw new Error(`Invalid run transition: ${current.status} -> ${transition.status}`);
  }
  const terminal = isTerminalRunStatus(transition.status);
  const process =
    transition.status === 'running' || transition.status === 'cancelling'
      ? (transition.process ?? current.process)
      : undefined;
  const retrying =
    transition.status === 'queued' && (current.status === 'failed' || current.status === 'lost');
  const next = {
    nodeId: current.nodeId,
    status: transition.status,
    attempt: retrying ? current.attempt + 1 : current.attempt,
    queuedAt: transition.status === 'queued' ? transition.occurredAt : current.queuedAt,
    ...(!retrying && current.startedAt === undefined && transition.status === 'running'
      ? { startedAt: transition.occurredAt }
      : retrying || current.startedAt === undefined
        ? {}
        : { startedAt: current.startedAt }),
    ...(terminal ? { endedAt: transition.occurredAt } : {}),
    ...(process === undefined ? {} : { process }),
    resumable: current.resumable,
    ...(transition.failureCode === undefined ? {} : { failureCode: transition.failureCode }),
    ...(transition.reason === undefined ? {} : { statusReason: transition.reason }),
  };
  return NodeRunStateSchema.parse(next);
}

export function aggregateWorkflowStatus(
  nodeRuns: Readonly<Record<string, NodeRunState>>,
): RunStatus {
  const statuses = Object.values(nodeRuns).map((run) => run.status);
  if (statuses.length === 0) return 'queued';

  // A failed parallel sibling must not make the aggregate terminal while other work can still
  // finish or be cancelled. Terminal precedence applies only after every node is terminal.
  if (statuses.some((status) => status === 'cancelling')) return 'cancelling';
  if (statuses.some((status) => status === 'running')) return 'running';
  if (statuses.some((status) => status === 'waiting-for-approval')) return 'waiting-for-approval';
  if (statuses.some((status) => status === 'paused')) return 'paused';
  if (statuses.some((status) => status === 'queued')) return 'queued';

  if (statuses.some((status) => status === 'lost')) return 'lost';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.every((status) => status === 'succeeded')) return 'succeeded';
  if (statuses.every((status) => status === 'cancelled' || status === 'succeeded'))
    return 'cancelled';
  return 'queued';
}

export function requestWorkflowCancellation(run: WorkflowRun, occurredAt: string): WorkflowRun {
  const nodeRuns = Object.fromEntries(
    Object.entries(run.nodeRuns).map(([nodeId, nodeRun]) => {
      if (isTerminalRunStatus(nodeRun.status) || nodeRun.status === 'cancelling')
        return [nodeId, nodeRun];
      const status: RunStatus = nodeRun.status === 'running' ? 'cancelling' : 'cancelled';
      return [
        nodeId,
        transitionNodeRun(nodeRun, {
          status,
          occurredAt,
          ...(nodeRun.process === undefined ? {} : { process: nodeRun.process }),
          reason: 'Workflow cancellation requested by the user',
        }),
      ];
    }),
  );
  const status = aggregateWorkflowStatus(nodeRuns);
  return WorkflowRunSchema.parse({
    ...run,
    nodeRuns,
    status,
    updatedAt: occurredAt,
    ...(isTerminalRunStatus(status) ? { endedAt: occurredAt } : {}),
  });
}

export interface RecoveryResult {
  readonly run: WorkflowRun;
  readonly lostNodeIds: readonly string[];
}

/** Marks persisted active states as lost unless the caller proves the exact process identity is live. */
export function recoverInterruptedRun(
  run: WorkflowRun,
  liveProcesses: ReadonlyMap<number, string>,
  occurredAt: string,
): RecoveryResult {
  const lostNodeIds: string[] = [];
  const nodeRuns = Object.fromEntries(
    Object.entries(run.nodeRuns).map(([nodeId, nodeRun]) => {
      if (nodeRun.status !== 'running' && nodeRun.status !== 'cancelling') return [nodeId, nodeRun];
      const liveIdentity =
        nodeRun.process === undefined ? undefined : liveProcesses.get(nodeRun.process.pid);
      if (liveIdentity === nodeRun.process?.identityToken) return [nodeId, nodeRun];
      lostNodeIds.push(nodeId);
      return [
        nodeId,
        transitionNodeRun(nodeRun, {
          status: 'lost',
          occurredAt,
          failureCode: 'PROCESS_NOT_RECOVERED',
          reason: 'The persisted process identity was not alive after restart',
        }),
      ];
    }),
  );
  const status = aggregateWorkflowStatus(nodeRuns);
  return {
    run: WorkflowRunSchema.parse({
      ...run,
      nodeRuns,
      status,
      updatedAt: occurredAt,
      ...(isTerminalRunStatus(status) ? { endedAt: occurredAt } : {}),
    }),
    lostNodeIds: lostNodeIds.sort((left, right) => left.localeCompare(right)),
  };
}

export function createRevisionLoopState(loop: RevisionLoop): RevisionLoopState {
  return { loopId: loop.id, attemptsStarted: 1, status: 'review-required' };
}

export type RevisionLoopEvent =
  | { readonly type: 'review-failed'; readonly feedback: string }
  | { readonly type: 'revision-completed' }
  | {
      readonly type: 'stop-condition-met';
      readonly condition: 'review-approved' | 'tests-passed' | 'human-accepted';
    }
  | { readonly type: 'human-aborted' };

/** Advances only within maximumAttempts; exhaustion always hands control to the human escape hatch. */
export function advanceRevisionLoop(
  loop: RevisionLoop,
  state: RevisionLoopState,
  event: RevisionLoopEvent,
): RevisionLoopState {
  if (state.loopId !== loop.id) throw new Error('Revision loop state belongs to a different loop');
  if (state.status === 'satisfied' || state.status === 'cancelled') {
    throw new Error(`Revision loop is already ${state.status}`);
  }
  const withoutEligibility = (): Omit<RevisionLoopState, 'eligibleAt'> => ({
    loopId: state.loopId,
    attemptsStarted: state.attemptsStarted,
    status: state.status,
    ...(state.lastFeedback === undefined ? {} : { lastFeedback: state.lastFeedback }),
    ...(state.stopCondition === undefined ? {} : { stopCondition: state.stopCondition }),
  });
  if (event.type === 'human-aborted') return { ...withoutEligibility(), status: 'cancelled' };
  if (event.type === 'stop-condition-met') {
    if (!loop.stopConditions.includes(event.condition)) {
      throw new Error(`Stop condition is not configured: ${event.condition}`);
    }
    return { ...withoutEligibility(), status: 'satisfied', stopCondition: event.condition };
  }
  if (event.type === 'review-failed') {
    if (state.status !== 'review-required')
      throw new Error('Review feedback is not currently expected');
    if (event.feedback.trim().length === 0) throw new Error('Revision feedback must be actionable');
    return {
      ...state,
      status: state.attemptsStarted >= loop.maximumAttempts ? 'waiting-human' : 'revision-required',
      lastFeedback: event.feedback,
    };
  }
  if (state.status !== 'revision-required') throw new Error('A revision is not currently expected');
  if (state.attemptsStarted >= loop.maximumAttempts) {
    return { ...state, status: 'waiting-human' };
  }
  return {
    ...withoutEligibility(),
    attemptsStarted: state.attemptsStarted + 1,
    status: 'review-required',
  };
}
