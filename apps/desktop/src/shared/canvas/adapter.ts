import {
  CanvasNodeSchema,
  CanvasSchema,
  type Canvas,
  type CanvasNode,
} from '@forgeboard/core/domain';

import { canonicalEdgeFromLegacy, legacyEdgeFromCanonical } from './edge-adapter.js';
import { canonicalNodeFromLegacy, legacyNodeFromCanonical } from './node-adapter.js';
import type {
  CanvasMigrationIssue,
  CanvasMigrationResult,
  LegacyCanvasDocument,
  LegacyCanvasSurface,
} from './types.js';

export interface SynchronizedCanvasDocument extends LegacyCanvasSurface {
  readonly schemaVersion: 2;
  readonly canonical: Canvas;
}

export function canonicalCanvasFromLegacy(document: LegacyCanvasDocument): CanvasMigrationResult {
  const previous = document.canonical;
  const previousNodes = new Map(previous?.nodes.map((node) => [node.id, node]));
  const previousEdges = new Map(previous?.edges.map((edge) => [edge.id, edge]));
  const issues: CanvasMigrationIssue[] = [];
  const nodes = document.nodes.flatMap((node) => {
    const migrated = canonicalNodeFromLegacy(node, previousNodes.get(node.id), document.updatedAt);
    if (migrated.issue !== undefined) issues.push(migrated.issue);
    return migrated.node === undefined ? [] : [migrated.node];
  });
  const edges = document.edges.flatMap((edge) => {
    const migrated = canonicalEdgeFromLegacy(edge, previousEdges.get(edge.id), document.updatedAt);
    if (migrated.issue !== undefined) issues.push(migrated.issue);
    return migrated.edge === undefined ? [] : [migrated.edge];
  });
  if (issues.length > 0) return { ok: false, issues };

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const groups = (previous?.groups ?? []).map((group) => ({
    ...group,
    nodeIds: group.nodeIds.filter((nodeId) => nodeIds.has(nodeId)),
  }));
  const groupIds = new Set(groups.map((group) => group.id));
  const normalizedNodes = nodes.map((node) =>
    node.groupId !== undefined && !groupIds.has(node.groupId) ? nodeWithoutGroup(node) : node,
  );
  const revisionLoops = (previous?.revisionLoops ?? []).filter(
    (loop) =>
      nodeIds.has(loop.implementationNodeId) &&
      nodeIds.has(loop.reviewNodeId) &&
      edgeIds.has(loop.reviewEdgeId) &&
      edgeIds.has(loop.revisionEdgeId),
  );
  const parsed = CanvasSchema.safeParse({
    schemaVersion: 1,
    id: document.id,
    projectId: document.projectId,
    name: document.name,
    nodes: normalizedNodes,
    edges,
    groups,
    viewState: {
      viewport: document.viewport,
      selectedNodeIds: (previous?.viewState.selectedNodeIds ?? []).filter((id) => nodeIds.has(id)),
      selectedEdgeIds: (previous?.viewState.selectedEdgeIds ?? []).filter((id) => edgeIds.has(id)),
      minimapVisible: previous?.viewState.minimapVisible ?? true,
      snapToGrid: previous?.viewState.snapToGrid ?? false,
      gridSize: previous?.viewState.gridSize ?? 16,
    },
    revisionLoops,
    workflowLimits: previous?.workflowLimits ?? {},
    createdAt: previous?.createdAt ?? document.updatedAt,
    updatedAt: document.updatedAt,
  });
  if (parsed.success) return { ok: true, canvas: parsed.data };
  return {
    ok: false,
    issues: [
      {
        code: 'INVALID_TYPED_NODE',
        entityId: document.id,
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      },
    ],
  };
}

export function legacySurfaceFromCanonical(canvas: Canvas): LegacyCanvasSurface {
  const parsed = CanvasSchema.parse(canvas);
  return {
    id: parsed.id,
    projectId: parsed.projectId,
    name: parsed.name,
    nodes: parsed.nodes.map(legacyNodeFromCanonical),
    edges: parsed.edges.map(legacyEdgeFromCanonical),
    viewport: parsed.viewState.viewport,
    updatedAt: parsed.updatedAt,
  };
}

export function synchronizeCanvasDocument(
  document: LegacyCanvasDocument,
):
  | { readonly ok: true; readonly document: SynchronizedCanvasDocument }
  | { readonly ok: false; readonly issues: readonly CanvasMigrationIssue[] } {
  const canonicalIsNewer =
    document.canonical !== undefined &&
    Date.parse(document.canonical.updatedAt) > Date.parse(document.updatedAt);
  if (canonicalIsNewer && document.canonical !== undefined) {
    const canonical = CanvasSchema.parse(document.canonical);
    return {
      ok: true,
      document: { ...legacySurfaceFromCanonical(canonical), schemaVersion: 2, canonical },
    };
  }
  const migrated = canonicalCanvasFromLegacy(document);
  if (!migrated.ok) return migrated;
  return {
    ok: true,
    document: {
      ...legacySurfaceFromCanonical(migrated.canvas),
      schemaVersion: 2,
      canonical: migrated.canvas,
    },
  };
}

function nodeWithoutGroup(node: CanvasNode): CanvasNode {
  const withoutGroup: Partial<CanvasNode> = { ...node };
  delete withoutGroup.groupId;
  return CanvasNodeSchema.parse(withoutGroup);
}
