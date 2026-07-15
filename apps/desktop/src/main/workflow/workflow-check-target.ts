import type { CanvasEdge, CanvasNode } from '@forgeboard/core/domain';
import { z } from 'zod';

import { ExactCheckTargetSchema, type ExactCheckTarget } from './exact-check-contracts.js';
import { WORKFLOW_EVIDENCE_VERIFIER_ID } from './workflow-evidence-contracts.js';
import type { WorkflowExecutorContext } from './workflow-host-contracts.js';

const AgentRunReferenceSchema = z
  .string()
  .regex(/^agent-run:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

/**
 * Resolves an exact-check target from verified, required agent output edges.
 *
 * A Test node without such an edge intentionally targets the primary checkout. Once a required
 * branch/diff edge is present, Forgeboard fails closed unless its current verified publication
 * identifies one unambiguous managed agent run.
 */
export function workflowCheckTarget(context: WorkflowExecutorContext): ExactCheckTarget {
  const candidates = requiredAgentOutputs(context);
  if (candidates.length === 0) {
    return ExactCheckTargetSchema.parse({
      kind: 'primary-project',
      projectId: context.projectId,
    });
  }

  const runIds = new Set(candidates.map((edge) => agentRunId(context, edge)));
  if (runIds.size !== 1) {
    throw new Error(
      `Test node "${context.node.title}" receives required outputs from multiple agent worktrees. Select one exact upstream agent output.`,
    );
  }
  return ExactCheckTargetSchema.parse({
    kind: 'managed-worktree',
    projectId: context.projectId,
    runId: [...runIds][0],
  });
}

function requiredAgentOutputs(
  context: WorkflowExecutorContext,
): Array<Extract<CanvasEdge, { type: 'output' }>> {
  const nodes = new Map<string, CanvasNode>(
    context.runtime.canvas.nodes.map((node) => [node.id, node]),
  );
  return context.runtime.canvas.edges.filter(
    (edge): edge is Extract<CanvasEdge, { type: 'output' }> =>
      edge.type === 'output' &&
      edge.targetNodeId === context.node.id &&
      edge.config.required &&
      (edge.config.outputKind === 'branch' || edge.config.outputKind === 'diff') &&
      context.runtime.plan.executableEdgeIds.includes(edge.id) &&
      nodes.get(edge.sourceNodeId)?.type === 'agent',
  );
}

function agentRunId(
  context: WorkflowExecutorContext,
  edge: Extract<CanvasEdge, { type: 'output' }>,
): string {
  const publication = context.runtime.evidence.outputPublications[edge.id];
  const producer = context.runtime.run.nodeRuns[edge.sourceNodeId];
  if (
    publication === undefined ||
    producer?.status !== 'succeeded' ||
    publication.runId !== context.runtime.run.id ||
    publication.producerNodeId !== edge.sourceNodeId ||
    publication.producerAttempt !== producer.attempt ||
    publication.outputKind !== edge.config.outputKind ||
    publication.verifierId !== WORKFLOW_EVIDENCE_VERIFIER_ID ||
    publication.referenceIds.length !== 1
  ) {
    throw new Error(
      `Required agent output "${edge.id}" does not have one current verified worktree publication.`,
    );
  }
  const reference = AgentRunReferenceSchema.parse(publication.referenceIds[0]);
  return z.string().uuid().parse(reference.slice('agent-run:'.length));
}
