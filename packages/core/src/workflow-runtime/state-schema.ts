import { z } from 'zod';

import { CanvasSchema, CheckResultSchema, EntityIdSchema } from '../model/domain.js';
import { ReviewerAssessmentSchema } from '../workflow/gates.js';
import {
  WorkflowPlanSchema,
  WorkflowPlanStageSchema,
  WorkflowRunSchema,
} from '../workflow/model.js';
import {
  ContextResolutionSchema,
  NodeCompletionOutputSchema,
  OutputPublicationSchema,
  RevisionEscapeResolutionSchema,
  WorkflowHumanApprovalSchema,
  WorkflowHumanReviewDecisionSchema,
} from './schemas.js';
import type { WorkflowExecutionRuntime } from './types.js';

const MAX_RUNTIME_ENTITIES = 100_000;

export const WorkflowRunScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('node'),
      nodeId: EntityIdSchema,
      includeUpstream: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('selection'),
      nodeIds: z.array(EntityIdSchema).min(1).max(MAX_RUNTIME_ENTITIES),
      includeUpstream: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('group'),
      groupId: EntityIdSchema,
      includeUpstream: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('workflow') }).strict(),
]);

export const ScopedWorkflowPlanSchema = z
  .object({
    id: EntityIdSchema,
    canvasId: EntityIdSchema,
    nodeIds: z.array(EntityIdSchema).max(MAX_RUNTIME_ENTITIES),
    stages: z.array(WorkflowPlanStageSchema).max(MAX_RUNTIME_ENTITIES),
    dependencies: z.record(z.array(EntityIdSchema).max(MAX_RUNTIME_ENTITIES)),
    revisionLoopIds: z.array(EntityIdSchema).max(MAX_RUNTIME_ENTITIES),
    scope: WorkflowRunScopeSchema,
    executableEdgeIds: z.array(EntityIdSchema).max(MAX_RUNTIME_ENTITIES),
  })
  .strict()
  .superRefine((plan, context) => {
    addDuplicateIssue(plan.nodeIds, context, ['nodeIds'], 'Planned node IDs must be unique');
    addDuplicateIssue(
      plan.revisionLoopIds,
      context,
      ['revisionLoopIds'],
      'Planned revision-loop IDs must be unique',
    );
    addDuplicateIssue(
      plan.executableEdgeIds,
      context,
      ['executableEdgeIds'],
      'Executable edge IDs must be unique',
    );
    const dependencyKeys = Object.keys(plan.dependencies);
    if (dependencyKeys.length > MAX_RUNTIME_ENTITIES) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: MAX_RUNTIME_ENTITIES,
        inclusive: true,
        type: 'array',
        path: ['dependencies'],
        message: 'Workflow dependency map is too large',
      });
    }
    const planned = new Set(plan.nodeIds);
    const stagedNodeIds = plan.stages.flatMap((stage) => stage.nodeIds);
    if (
      new Set(stagedNodeIds).size !== stagedNodeIds.length ||
      stagedNodeIds.length !== planned.size ||
      stagedNodeIds.some((nodeId) => !planned.has(nodeId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages'],
        message: 'Workflow stages must contain every planned node exactly once',
      });
    }
    const keys = new Set(dependencyKeys);
    if (
      plan.nodeIds.some((nodeId) => !keys.has(nodeId)) ||
      dependencyKeys.some((id) => !planned.has(id))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dependencies'],
        message: 'Workflow dependencies must have exactly one entry for every planned node',
      });
    }
    for (const [nodeId, dependencies] of Object.entries(plan.dependencies)) {
      addDuplicateIssue(
        dependencies,
        context,
        ['dependencies', nodeId],
        'Node dependencies must be unique',
      );
      if (dependencies.some((dependencyId) => !planned.has(dependencyId))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dependencies', nodeId],
          message: 'Node dependencies must remain inside the scoped plan',
        });
      }
    }
    const basePlan = WorkflowPlanSchema.safeParse({
      id: plan.id,
      canvasId: plan.canvasId,
      nodeIds: plan.nodeIds,
      stages: plan.stages,
      dependencies: plan.dependencies,
      revisionLoopIds: plan.revisionLoopIds,
    });
    if (!basePlan.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Scoped workflow plan does not satisfy the deterministic plan schema',
      });
    }
  });

export const WorkflowExecutionEvidenceSchema = z
  .object({
    humanApprovals: z.record(WorkflowHumanApprovalSchema),
    humanReviewDecisions: z.record(WorkflowHumanReviewDecisionSchema),
    contextResolutions: z.record(ContextResolutionSchema),
    outputPublications: z.record(OutputPublicationSchema),
    nodeCompletionOutputs: z.record(NodeCompletionOutputSchema).default({}),
    reviewerAssessments: z.record(ReviewerAssessmentSchema),
    gateChecks: z.record(z.array(CheckResultSchema).max(MAX_RUNTIME_ENTITIES)),
    revisionEscapes: z.record(RevisionEscapeResolutionSchema),
  })
  .strict()
  .superRefine((evidence, context) => {
    for (const [name, values] of Object.entries(evidence)) {
      if (Object.keys(values).length > MAX_RUNTIME_ENTITIES) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: 'Workflow evidence map is too large',
        });
      }
    }
    const artifactBytes = Object.values(evidence.nodeCompletionOutputs).reduce(
      (total, output) => total + new TextEncoder().encode(output.artifactContent).byteLength,
      0,
    );
    if (artifactBytes > 32 * 1024 * 1024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodeCompletionOutputs'],
        message: 'Persisted reviewer artifacts exceed the 32 MiB aggregate limit',
      });
    }
    validateEmbeddedMapIds(evidence.humanApprovals, 'targetId', 'humanApprovals', context);
    validateEmbeddedMapIds(
      evidence.humanReviewDecisions,
      'targetId',
      'humanReviewDecisions',
      context,
    );
    validateEmbeddedMapIds(evidence.contextResolutions, 'edgeId', 'contextResolutions', context);
    validateEmbeddedMapIds(evidence.outputPublications, 'edgeId', 'outputPublications', context);
    validateEmbeddedMapIds(
      evidence.nodeCompletionOutputs,
      'nodeId',
      'nodeCompletionOutputs',
      context,
    );
    validateEmbeddedMapIds(evidence.revisionEscapes, 'loopId', 'revisionEscapes', context);
  });

export const WorkflowExecutionRuntimeSchema = z
  .object({
    canvas: CanvasSchema,
    plan: ScopedWorkflowPlanSchema,
    run: WorkflowRunSchema,
    evidence: WorkflowExecutionEvidenceSchema,
    activeRevisionLoopIds: z.array(EntityIdSchema).max(MAX_RUNTIME_ENTITIES),
    cancellationRequested: z.boolean(),
  })
  .strict()
  .superRefine((runtime, context) => {
    if (runtime.plan.canvasId !== runtime.canvas.id || runtime.run.canvasId !== runtime.canvas.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['run', 'canvasId'],
        message: 'Canvas, plan, and workflow run IDs must identify the same canvas',
      });
    }
    if (runtime.run.planId !== runtime.plan.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['run', 'planId'],
        message: 'Workflow run must reference the persisted scoped plan',
      });
    }

    const canvasNodeIds = new Set(runtime.canvas.nodes.map((node) => node.id));
    const plannedNodeIds = new Set(runtime.plan.nodeIds);
    const runNodeIds = Object.keys(runtime.run.nodeRuns);
    if (
      runtime.plan.nodeIds.some((nodeId) => !canvasNodeIds.has(nodeId)) ||
      runNodeIds.length !== plannedNodeIds.size ||
      runNodeIds.some((nodeId) => !plannedNodeIds.has(nodeId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['run', 'nodeRuns'],
        message: 'Persisted node runs must exactly match nodes in the scoped plan and canvas',
      });
    }

    const canvasEdgeIds = new Set(runtime.canvas.edges.map((edge) => edge.id));
    if (runtime.plan.executableEdgeIds.some((edgeId) => !canvasEdgeIds.has(edgeId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plan', 'executableEdgeIds'],
        message: 'Executable edges must exist in the persisted canvas snapshot',
      });
    }
    const canvasLoopIds = new Set(runtime.canvas.revisionLoops.map((loop) => loop.id));
    const runLoopIds = Object.keys(runtime.run.revisionLoops);
    if (
      runtime.plan.revisionLoopIds.some((loopId) => !canvasLoopIds.has(loopId)) ||
      runLoopIds.length !== runtime.plan.revisionLoopIds.length ||
      runLoopIds.some((loopId) => !runtime.plan.revisionLoopIds.includes(loopId)) ||
      runtime.activeRevisionLoopIds.some((loopId) => !runtime.plan.revisionLoopIds.includes(loopId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activeRevisionLoopIds'],
        message: 'Active revision loops must exist in the persisted scoped plan',
      });
    }
    addDuplicateIssue(
      runtime.activeRevisionLoopIds,
      context,
      ['activeRevisionLoopIds'],
      'Active revision-loop IDs must be unique',
    );
    validateEvidenceBindings(runtime as unknown as WorkflowExecutionRuntime, context);
  });

export function parseWorkflowExecutionRuntime(untrustedRuntime: unknown): WorkflowExecutionRuntime {
  return WorkflowExecutionRuntimeSchema.parse(untrustedRuntime) as WorkflowExecutionRuntime;
}

function validateEvidenceBindings(
  runtime: WorkflowExecutionRuntime,
  context: z.RefinementCtx,
): void {
  const runIdEvidence = [
    ...Object.entries(runtime.evidence.humanApprovals),
    ...Object.entries(runtime.evidence.humanReviewDecisions),
    ...Object.entries(runtime.evidence.contextResolutions),
    ...Object.entries(runtime.evidence.outputPublications),
    ...Object.entries(runtime.evidence.nodeCompletionOutputs),
    ...Object.entries(runtime.evidence.revisionEscapes),
  ];
  for (const [key, record] of runIdEvidence) {
    if (record.runId !== runtime.run.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', key],
        message: 'Workflow evidence must belong to the persisted workflow run',
      });
    }
  }
  for (const [nodeId, output] of Object.entries(runtime.evidence.nodeCompletionOutputs)) {
    if (
      nodeId !== output.nodeId ||
      !runtime.plan.nodeIds.includes(nodeId) ||
      output.nodeAttempt !== runtime.run.nodeRuns[nodeId]?.attempt
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', 'nodeCompletionOutputs', nodeId],
        message: 'Node completion output must target the current planned node attempt',
      });
    }
  }
  for (const [gateNodeId, checks] of Object.entries(runtime.evidence.gateChecks)) {
    const gate = runtime.canvas.nodes.find((node) => node.id === gateNodeId);
    if (
      gate?.type !== 'review-gate' ||
      !runtime.plan.nodeIds.includes(gateNodeId) ||
      checks.some((check) => check.runId !== runtime.run.id)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', 'gateChecks', gateNodeId],
        message: 'Gate-check evidence must target a planned gate in the same workflow run',
      });
    }
  }
  for (const edgeId of Object.keys(runtime.evidence.reviewerAssessments)) {
    const edge = runtime.canvas.edges.find((candidate) => candidate.id === edgeId);
    if (edge?.type !== 'review' || !runtime.plan.executableEdgeIds.includes(edgeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', 'reviewerAssessments', edgeId],
        message: 'Reviewer evidence must target a planned review edge',
      });
    }
  }
}

function addDuplicateIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  }
}

function validateEmbeddedMapIds<TRecord extends object>(
  values: Readonly<Record<string, TRecord>>,
  idField: string,
  path: string,
  context: z.RefinementCtx,
): void {
  for (const [key, value] of Object.entries(values)) {
    if ((value as Record<string, unknown>)[idField] !== key) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, key, String(idField)],
        message: 'Evidence map key must match its embedded entity ID',
      });
    }
  }
}
