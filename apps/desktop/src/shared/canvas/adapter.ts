import {
  CanvasNodeSchema,
  CanvasSchema,
  type Canvas,
  type CanvasNode,
} from '@forgeboard/core/domain';

import { canonicalEdgeFromLegacy, legacyEdgeFromCanonical } from './edge-adapter.js';
import { canonicalNodeFromLegacy, legacyNodeFromCanonical } from './node-adapter.js';
import { GROUP_FRAME_MINIMUM_DIMENSIONS } from './node-dimensions.js';
import { reconcileRevisionLoops } from './revision-loop-adapter.js';
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
  const groupFrames = reconcileGroupFrameNodes(nodes);
  const groupFrameIds = new Set(groupFrames.nodesById.keys());
  const knownGroupFrameIds = new Set([
    ...groupFrameIds,
    ...(previous?.nodes.filter((node) => node.type === 'group-frame').map((node) => node.id) ?? []),
  ]);
  const retainedGroups = (previous?.groups ?? [])
    .filter((group) => !knownGroupFrameIds.has(group.id))
    .map((group) => ({
      ...group,
      nodeIds: group.nodeIds.filter((nodeId) => nodeIds.has(nodeId)),
    }));
  const groups = [
    ...retainedGroups,
    ...groupFrames.frames.map((frame) => ({
      id: frame.id,
      title: frame.title,
      nodeIds: [...frame.data.childNodeIds],
      position: frame.position,
      size: frame.size,
      color: frame.color,
      locked: frame.locked,
    })),
  ];
  const groupIds = new Set(groups.map((group) => group.id));
  const normalizedNodes = groupFrames.nodes.map((node) => {
    const frameId = groupFrames.parentByChildId.get(node.id);
    if (frameId !== undefined) return nodeWithGroup(node, frameId);
    return node.groupId !== undefined &&
      (groupFrameIds.has(node.groupId) || !groupIds.has(node.groupId))
      ? nodeWithoutGroup(node)
      : node;
  });
  const reconciledLoops = reconcileRevisionLoops(
    document.edges,
    edges,
    normalizedNodes,
    (previous?.revisionLoops ?? []).filter(
      (loop) =>
        nodeIds.has(loop.implementationNodeId) &&
        nodeIds.has(loop.reviewNodeId) &&
        edgeIds.has(loop.reviewEdgeId) &&
        edgeIds.has(loop.revisionEdgeId),
    ),
    document.updatedAt,
  );
  const parsed = CanvasSchema.safeParse({
    schemaVersion: 1,
    id: document.id,
    projectId: document.projectId,
    name: document.name,
    nodes: reconciledLoops.nodes,
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
    revisionLoops: reconciledLoops.revisionLoops,
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

function nodeWithGroup(node: CanvasNode, groupId: string): CanvasNode {
  return CanvasNodeSchema.parse({ ...node, groupId });
}

function reconcileGroupFrameNodes(nodes: readonly CanvasNode[]): {
  readonly nodes: CanvasNode[];
  readonly frames: Array<Extract<CanvasNode, { type: 'group-frame' }>>;
  readonly nodesById: ReadonlyMap<string, Extract<CanvasNode, { type: 'group-frame' }>>;
  readonly parentByChildId: ReadonlyMap<string, string>;
} {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const sourceFrames = nodes.filter(isGroupFrameNode);
  const claimsByChildId = new Map<string, GroupFrameNode[]>();

  for (const frame of sourceFrames) {
    const seenChildIds = new Set<string>();
    for (const childId of frame.data.childNodeIds) {
      if (seenChildIds.has(childId)) continue;
      seenChildIds.add(childId);
      const child = byId.get(childId);
      if (child === undefined || child.id === frame.id || isGroupFrameNode(child)) continue;
      const claims = claimsByChildId.get(childId) ?? [];
      claims.push(frame);
      claimsByChildId.set(childId, claims);
    }
  }

  const parentByChildId = new Map<string, string>();
  const childrenByFrameId = new Map<string, string[]>();
  for (const childId of [...claimsByChildId.keys()].sort(compareIds)) {
    const child = byId.get(childId);
    if (child === undefined || isGroupFrameNode(child)) continue;
    const winner = [...(claimsByChildId.get(childId) ?? [])].sort((left, right) =>
      compareGroupFrameClaims(left, right, child),
    )[0];
    if (winner === undefined) continue;
    parentByChildId.set(childId, winner.id);
    const children = childrenByFrameId.get(winner.id) ?? [];
    children.push(childId);
    childrenByFrameId.set(winner.id, children);
  }

  const reconciled = nodes.map((node) => {
    if (!isGroupFrameNode(node)) return node;
    return CanvasNodeSchema.parse({
      ...node,
      data: { ...node.data, childNodeIds: childrenByFrameId.get(node.id) ?? [] },
    }) as Extract<CanvasNode, { type: 'group-frame' }>;
  });
  const frames = reconciled.filter(isGroupFrameNode);
  return {
    nodes: reconciled,
    frames,
    nodesById: new Map(frames.map((frame) => [frame.id, frame] as const)),
    parentByChildId,
  };
}

type GroupFrameNode = Extract<CanvasNode, { type: 'group-frame' }>;

function isGroupFrameNode(node: CanvasNode): node is GroupFrameNode {
  return node.type === 'group-frame';
}

function compareGroupFrameClaims(
  left: GroupFrameNode,
  right: GroupFrameNode,
  child: CanvasNode,
): number {
  const leftContains = groupFrameContainsNode(left, child);
  const rightContains = groupFrameContainsNode(right, child);
  if (leftContains !== rightContains) return leftContains ? -1 : 1;
  const areaDifference = groupFrameArea(left) - groupFrameArea(right);
  return areaDifference === 0 ? compareIds(left.id, right.id) : areaDifference;
}

function groupFrameContainsNode(frame: GroupFrameNode, child: CanvasNode): boolean {
  const frameWidth = Math.max(GROUP_FRAME_MINIMUM_DIMENSIONS.width, frame.size.width);
  const frameHeight = Math.max(GROUP_FRAME_MINIMUM_DIMENSIONS.height, frame.size.height);
  return (
    child.position.x >= frame.position.x &&
    child.position.y >= frame.position.y &&
    child.position.x + child.size.width <= frame.position.x + frameWidth &&
    child.position.y + child.size.height <= frame.position.y + frameHeight
  );
}

function groupFrameArea(frame: GroupFrameNode): number {
  return (
    Math.max(GROUP_FRAME_MINIMUM_DIMENSIONS.width, frame.size.width) *
    Math.max(GROUP_FRAME_MINIMUM_DIMENSIONS.height, frame.size.height)
  );
}

function compareIds(left: string, right: string): number {
  return left.localeCompare(right);
}
