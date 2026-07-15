import {
  RevisionLoopSchema,
  type CanvasEdge,
  type CanvasNode,
  type RevisionLoop,
} from '@forgeboard/core/domain';

import { unknownRecord } from './json.js';
import type { LegacyCanvasEdge } from './types.js';

export interface ReconciledRevisionLoops {
  readonly nodes: readonly CanvasNode[];
  readonly revisionLoops: readonly RevisionLoop[];
}

/**
 * Promotes UI-authored revision metadata into the canonical bounded-loop registry. Incomplete loop
 * drafts remain ordinary edge metadata and therefore fail workflow validation instead of gaining
 * invented topology or policy.
 */
export function reconcileRevisionLoops(
  legacyEdges: readonly LegacyCanvasEdge[],
  edges: readonly CanvasEdge[],
  nodes: readonly CanvasNode[],
  previousLoops: readonly RevisionLoop[],
  updatedAt: string,
): ReconciledRevisionLoops {
  const rawById = new Map(legacyEdges.map((edge) => [edge.id, edge]));
  const previousByRevisionEdge = new Map(previousLoops.map((loop) => [loop.revisionEdgeId, loop]));
  const loops: RevisionLoop[] = [];
  const retryLimits = new Map<string, number>();

  for (const revisionEdge of edges) {
    if (revisionEdge.type !== 'revision' || revisionEdge.config.loopId === undefined) continue;
    const matchingReviews = edges.filter(
      (candidate) =>
        candidate.type === 'review' &&
        candidate.config.requireApproval &&
        candidate.sourceNodeId === revisionEdge.targetNodeId &&
        candidate.targetNodeId === revisionEdge.sourceNodeId,
    );
    if (matchingReviews.length !== 1) continue;
    const reviewEdge = matchingReviews[0];
    if (reviewEdge === undefined) continue;

    const rawEdge = rawById.get(revisionEdge.id);
    const rawLoop = unknownRecord(unknownRecord(rawEdge?.data)?.['loop']);
    const previous = previousByRevisionEdge.get(revisionEdge.id);
    if (rawLoop === undefined && previous === undefined) continue;

    const reviewNode = nodes.find((node) => node.id === revisionEdge.sourceNodeId);
    const defaultMaximum =
      reviewNode?.type === 'review-gate' ? reviewNode.data.retryPolicy.maximumIterations : 3;
    const maximumAttempts = boundedInteger(
      rawLoop?.['maximumAttempts'],
      previous?.maximumAttempts ?? defaultMaximum,
      1,
      100,
    );
    const stopConditions = parseStopConditions(
      rawLoop?.['stopConditions'],
      previous?.stopConditions ?? ['review-approved'],
    );
    const instructions =
      stringValue(rawLoop?.['humanEscapeInstructions']) ??
      previous?.humanEscapeHatch.instructions ??
      '';
    const parsed = RevisionLoopSchema.safeParse({
      id: revisionEdge.config.loopId,
      implementationNodeId: revisionEdge.targetNodeId,
      reviewNodeId: revisionEdge.sourceNodeId,
      reviewEdgeId: reviewEdge.id,
      revisionEdgeId: revisionEdge.id,
      maximumAttempts,
      stopConditions,
      humanEscapeHatch: {
        enabled: true,
        approvalRequired: true,
        instructions,
      },
    });
    if (!parsed.success) continue;
    loops.push(parsed.data);
    if (reviewNode?.type === 'review-gate') retryLimits.set(reviewNode.id, maximumAttempts);
  }

  return {
    revisionLoops: loops,
    nodes: nodes.map((node) => {
      const maximumIterations = retryLimits.get(node.id);
      if (node.type !== 'review-gate' || maximumIterations === undefined) return node;
      return {
        ...node,
        updatedAt,
        data: {
          ...node.data,
          retryPolicy: { ...node.data.retryPolicy, maximumIterations },
        },
      };
    }),
  };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseStopConditions(
  value: unknown,
  fallback: readonly RevisionLoop['stopConditions'][number][],
): RevisionLoop['stopConditions'] {
  if (!Array.isArray(value)) return [...fallback];
  const allowed = new Set<RevisionLoop['stopConditions'][number]>([
    'review-approved',
    'tests-passed',
    'human-accepted',
  ]);
  return [
    ...new Set(
      value.filter(
        (condition): condition is RevisionLoop['stopConditions'][number] =>
          typeof condition === 'string' &&
          allowed.has(condition as RevisionLoop['stopConditions'][number]),
      ),
    ),
  ];
}
