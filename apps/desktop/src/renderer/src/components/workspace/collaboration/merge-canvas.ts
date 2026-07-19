import {
  CanvasEdgeSchema,
  CanvasNodeSchema,
  CanvasSchema,
  type Canvas,
  type CanvasEdge,
  type CanvasNode,
  type NodeStatus,
} from '@forgeboard/core/domain';

import {
  CanvasDocumentSchema,
  type CanvasDocument,
} from '../../../../../shared/application/contracts.js';
import {
  canonicalCanvasFromLegacy,
  legacySurfaceFromCanonical,
} from '../../../../../shared/canvas/adapter.js';
import type { LegacyCanvasEdge, LegacyCanvasNode } from '../../../../../shared/canvas/types.js';
import {
  CANVAS_NODE_MINIMUM_DIMENSIONS,
  GROUP_FRAME_MINIMUM_DIMENSIONS,
} from '../../../../../shared/canvas/node-dimensions.js';
import {
  CollaborationMetadataSnapshotSchema,
  type CollaborationCommentMetadata,
  type CollaborationEdgeMetadata,
  type CollaborationGroupMetadata,
  type CollaborationMetadataSnapshot,
  type CollaborationNodeMetadata,
  type CollaborationNodeType,
  type CollaborationReviewMetadata,
  type CollaborationTaskMetadata,
  type CollaborationWorkflowMetadata,
} from '../../../../../shared/collaboration/index.js';

export interface CollaborationCanvasMergeOptions {
  /** The first room snapshot is unioned with unsent local work; later snapshots carry deletions. */
  readonly initial: boolean;
}

export type CollaborationCanvasMergeResult =
  | { readonly ok: true; readonly document: CanvasDocument }
  | { readonly ok: false; readonly message: string };

/**
 * Applies the allowlisted room projection without importing paths, prompts, commands, or other
 * machine-local payloads. Existing typed data stays local; new File nodes are deliberately unbound.
 */
export function mergeCollaborationCanvasSnapshot(
  rawDocument: CanvasDocument,
  rawSnapshot: CollaborationMetadataSnapshot,
  options: CollaborationCanvasMergeOptions,
): CollaborationCanvasMergeResult {
  const document = CanvasDocumentSchema.parse(rawDocument);
  const snapshot = CollaborationMetadataSnapshotSchema.parse(rawSnapshot);
  if (snapshot.canvas.id !== document.id) {
    return {
      ok: false,
      message: 'These shared changes belong to a different canvas.',
    };
  }

  const local = canonicalCanvasFromLegacy(document);
  if (!local.ok) {
    return {
      ok: false,
      message: 'This canvas could not be prepared before applying shared changes.',
    };
  }

  const extensionNodeIds = new Set(
    local.canvas.nodes.filter((node) => node.type === 'extension').map((node) => node.id),
  );
  const localLegacyNodes = new Map(document.nodes.map((node) => [node.id, node]));
  const groupMemberIds = collaborationGroupMemberIds(snapshot, local.canvas);
  const remoteNodes: LegacyCanvasNode[] = Object.values(snapshot.nodes).map((node) =>
    legacyNodeFromCollaboration(
      node,
      localLegacyNodes.get(node.id),
      snapshot.groups[node.id],
      groupMemberIds.get(node.id) ?? [],
    ),
  );
  const includedNodeIds = new Set(remoteNodes.map((node) => node.id));
  for (const node of document.nodes) {
    if ((options.initial || extensionNodeIds.has(node.id)) && !includedNodeIds.has(node.id)) {
      remoteNodes.push(node);
      includedNodeIds.add(node.id);
    }
  }

  const remoteEdges: LegacyCanvasEdge[] = Object.values(snapshot.edges).map((edge) =>
    legacyEdgeFromCollaboration(edge),
  );
  const includedEdgeIds = new Set(remoteEdges.map((edge) => edge.id));
  for (const edge of document.edges) {
    const extensionEdge = extensionNodeIds.has(edge.source) || extensionNodeIds.has(edge.target);
    if (
      (options.initial || extensionEdge) &&
      !includedEdgeIds.has(edge.id) &&
      includedNodeIds.has(edge.source) &&
      includedNodeIds.has(edge.target)
    ) {
      remoteEdges.push(edge);
      includedEdgeIds.add(edge.id);
    }
  }

  const migrated = canonicalCanvasFromLegacy({
    ...document,
    name: snapshot.canvas.title,
    nodes: remoteNodes,
    edges: remoteEdges,
    viewport: {
      x: snapshot.canvas.viewport?.x ?? document.viewport.x,
      y: snapshot.canvas.viewport?.y ?? document.viewport.y,
      zoom: snapshot.canvas.zoom ?? document.viewport.zoom,
    },
    updatedAt: snapshot.canvas.updatedAt,
    canonical: local.canvas,
  });
  if (!migrated.ok) {
    return {
      ok: false,
      message: 'The shared changes could not be applied to this canvas.',
    };
  }

  try {
    const canonical = applyCollaborationMetadata(migrated.canvas, local.canvas, snapshot, options);
    return {
      ok: true,
      document: CanvasDocumentSchema.parse({
        ...legacySurfaceFromCanonical(canonical),
        schemaVersion: 2,
        canonical,
      }),
    };
  } catch {
    return {
      ok: false,
      message: 'The shared changes are not valid for this canvas.',
    };
  }
}

function applyCollaborationMetadata(
  migrated: Canvas,
  local: Canvas,
  snapshot: CollaborationMetadataSnapshot,
  options: CollaborationCanvasMergeOptions,
): Canvas {
  const localNodes = new Map(local.nodes.map((node) => [node.id, node]));
  const remoteComments = commentsByNode(snapshot);
  const workflowByNode = recordsByNode(Object.values(snapshot.workflow));
  const reviewsByNode = recordsByNode(Object.values(snapshot.reviews));
  const nodes = migrated.nodes.map((node) => {
    const metadata = snapshot.nodes[node.id];
    if (metadata === undefined) return node;
    return applyNodeMetadata(
      node,
      localNodes.get(node.id),
      metadata,
      snapshot.groups[node.id],
      snapshot.tasks[node.id],
      remoteComments.get(node.id) ?? [],
      workflowByNode.get(node.id) ?? [],
      reviewsByNode.get(node.id) ?? [],
      snapshot.canvas.updatedAt,
      options,
    );
  });
  const edges = migrated.edges.map((edge) => {
    const metadata = snapshot.edges[edge.id];
    return metadata === undefined ? edge : applyEdgeMetadata(edge, metadata);
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const groups = mergedGroups(migrated, local, snapshot, options, nodeIds, nodes);
  const edgeIds = new Set(edges.map((edge) => edge.id));

  return CanvasSchema.parse({
    ...migrated,
    name: snapshot.canvas.title,
    nodes,
    edges,
    groups,
    revisionLoops: migrated.revisionLoops.filter(
      (loop) =>
        nodeIds.has(loop.implementationNodeId) &&
        nodeIds.has(loop.reviewNodeId) &&
        edgeIds.has(loop.reviewEdgeId) &&
        edgeIds.has(loop.revisionEdgeId),
    ),
    viewState: {
      ...migrated.viewState,
      viewport: {
        x: snapshot.canvas.viewport?.x ?? migrated.viewState.viewport.x,
        y: snapshot.canvas.viewport?.y ?? migrated.viewState.viewport.y,
        zoom: snapshot.canvas.zoom ?? migrated.viewState.viewport.zoom,
      },
      selectedNodeIds: migrated.viewState.selectedNodeIds.filter((id) => nodeIds.has(id)),
      selectedEdgeIds: migrated.viewState.selectedEdgeIds.filter((id) => edgeIds.has(id)),
    },
    updatedAt: snapshot.canvas.updatedAt,
  });
}

function applyNodeMetadata(
  node: CanvasNode,
  localNode: CanvasNode | undefined,
  metadata: CollaborationNodeMetadata,
  group: CollaborationGroupMetadata | undefined,
  task: CollaborationTaskMetadata | undefined,
  comments: readonly CollaborationCommentMetadata[],
  workflow: readonly CollaborationWorkflowMetadata[],
  reviews: readonly CollaborationReviewMetadata[],
  canvasUpdatedAt: string,
  options: CollaborationCanvasMergeOptions,
): CanvasNode {
  // Private comments remain device-local through every room update. On the initial handshake we
  // also retain shared comments long enough for the collaboration recovery flow to reconcile them.
  const localComments = (localNode?.comments ?? []).filter(
    (comment) => comment.scope !== 'shared' || options.initial,
  );
  const mergedComments = new Map(localComments.map((comment) => [comment.id, comment]));
  for (const comment of comments) {
    mergedComments.set(comment.id, {
      id: comment.id,
      authorId: comment.authorId,
      scope: 'shared',
      body: comment.body,
      createdAt: comment.createdAt,
      ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
      ...(comment.resolved === true ? { resolvedAt: comment.updatedAt ?? comment.createdAt } : {}),
    });
  }

  const collaborationInspector = {
    ...(metadata.taskId === undefined ? {} : { taskId: metadata.taskId }),
    ...(metadata.type !== 'file'
      ? {}
      : {
          // A resource identifier is meaningful only on the client that produced it.
          fileAvailability:
            metadata.availability === 'unavailable' ? 'unavailable' : 'metadata-only',
        }),
    ...(task?.acceptanceState === undefined ? {} : { acceptanceState: task.acceptanceState }),
    ...(workflow.length === 0 ? {} : { workflow }),
    ...(reviews.length === 0 ? {} : { reviews }),
  };
  const data =
    node.type === 'task' && task !== undefined ? applyTaskMetadata(node, task) : node.data;
  const withoutGroup = { ...node } as Record<string, unknown>;
  delete withoutGroup['groupId'];
  const inspector = inspectorWithoutStaleTaskAssignee(node, task);
  delete inspector['collaboration'];
  const frameGroup = node.type === 'group-frame' ? group : undefined;
  const requestedSize = metadata.size ?? frameGroup?.size ?? node.size;
  const minimumSize =
    node.type === 'group-frame' ? GROUP_FRAME_MINIMUM_DIMENSIONS : CANVAS_NODE_MINIMUM_DIMENSIONS;

  return CanvasNodeSchema.parse({
    ...withoutGroup,
    title: metadata.title,
    position: metadata.position,
    size: {
      width: Math.max(minimumSize.width, requestedSize.width),
      height: Math.max(minimumSize.height, requestedSize.height),
    },
    color: metadata.color ?? node.color,
    icon: metadata.icon ?? node.icon,
    status: localNodeStatus(metadata.status, node.status),
    locked: metadata.locked ?? frameGroup?.locked ?? false,
    collapsed: metadata.collapsed ?? frameGroup?.collapsed ?? false,
    ...(metadata.groupId === undefined ? {} : { groupId: metadata.groupId }),
    comments: [...mergedComments.values()],
    inspector: {
      ...inspector,
      ...(Object.keys(collaborationInspector).length === 0
        ? {}
        : { collaboration: collaborationInspector }),
    },
    createdAt: metadata.createdAt ?? node.createdAt,
    updatedAt: metadata.updatedAt ?? canvasUpdatedAt,
    data,
  });
}

function inspectorWithoutStaleTaskAssignee(
  node: CanvasNode,
  task: CollaborationTaskMetadata | undefined,
): Record<string, unknown> {
  const inspector: Record<string, unknown> = { ...node.inspector };
  const legacyData = inspector['legacyData'];
  if (
    node.type === 'task' &&
    task !== undefined &&
    typeof legacyData === 'object' &&
    legacyData !== null &&
    !Array.isArray(legacyData)
  ) {
    const nextLegacyData = { ...legacyData } as Record<string, unknown>;
    delete nextLegacyData['assigneeId'];
    inspector['legacyData'] = nextLegacyData;
  }
  return inspector;
}

function applyEdgeMetadata(edge: CanvasEdge, metadata: CollaborationEdgeMetadata): CanvasEdge {
  return CanvasEdgeSchema.parse({
    ...edge,
    sourceNodeId: metadata.sourceId,
    targetNodeId: metadata.targetId,
    label: metadata.label,
    status: localEdgeStatus(metadata.status),
    createdAt: metadata.createdAt ?? edge.createdAt,
  });
}

function commentsByNode(
  snapshot: CollaborationMetadataSnapshot,
): ReadonlyMap<string, CollaborationCommentMetadata[]> {
  const result = new Map<string, CollaborationCommentMetadata[]>();
  for (const comment of Object.values(snapshot.comments)) {
    const nodeId = comment.nodeId ?? comment.taskId;
    if (nodeId === undefined) continue;
    const comments = result.get(nodeId) ?? [];
    comments.push(comment);
    result.set(nodeId, comments);
  }
  return result;
}

function recordsByNode<TRecord extends { readonly nodeId?: string | undefined }>(
  records: readonly TRecord[],
): ReadonlyMap<string, TRecord[]> {
  const result = new Map<string, TRecord[]>();
  for (const record of records) {
    if (record.nodeId === undefined) continue;
    const nodeRecords = result.get(record.nodeId) ?? [];
    nodeRecords.push(record);
    result.set(record.nodeId, nodeRecords);
  }
  return result;
}

function mergedGroups(
  migrated: Canvas,
  local: Canvas,
  snapshot: CollaborationMetadataSnapshot,
  options: CollaborationCanvasMergeOptions,
  nodeIds: ReadonlySet<string>,
  nodes: readonly CanvasNode[],
): Canvas['groups'] {
  const localGroups = new Map(local.groups.map((group) => [group.id, group]));
  const localNodes = new Map(local.nodes.map((node) => [node.id, node]));
  const remoteMembers = new Map<string, string[]>();
  for (const node of Object.values(snapshot.nodes)) {
    if (node.groupId === undefined) continue;
    const members = remoteMembers.get(node.groupId) ?? [];
    members.push(node.id);
    remoteMembers.set(node.groupId, members);
  }
  const remoteGroupIds = new Set(Object.keys(snapshot.groups));
  const framesById = new Map(
    nodes
      .filter(
        (node): node is Extract<CanvasNode, { type: 'group-frame' }> => node.type === 'group-frame',
      )
      .map((node) => [node.id, node] as const),
  );
  const remoteGroups = Object.values(snapshot.groups).map((group) => {
    const localGroup = localGroups.get(group.id);
    const frame = framesById.get(group.id);
    const localOnlyMembers = (localGroup?.nodeIds ?? []).filter((nodeId) => {
      return localNodes.get(nodeId)?.type === 'extension';
    });
    return {
      id: group.id,
      title: frame?.title ?? group.title,
      nodeIds: [...new Set([...(remoteMembers.get(group.id) ?? []), ...localOnlyMembers])].filter(
        (id) => nodeIds.has(id),
      ),
      position: frame?.position ?? group.position,
      size: frame?.size ?? group.size,
      color: frame?.color ?? group.color ?? localGroup?.color ?? '#82909b',
      locked: frame?.locked ?? group.locked ?? false,
    };
  });
  for (const group of migrated.groups) {
    if (remoteGroupIds.has(group.id)) continue;
    const extensionMembers = group.nodeIds.filter((nodeId) => {
      return localNodes.get(nodeId)?.type === 'extension' && nodeIds.has(nodeId);
    });
    if (options.initial || extensionMembers.length > 0) {
      remoteGroups.push({
        ...group,
        nodeIds: options.initial ? group.nodeIds.filter((id) => nodeIds.has(id)) : extensionMembers,
      });
    }
  }
  return remoteGroups;
}

function legacyNodeFromCollaboration(
  node: CollaborationNodeMetadata,
  local:
    | {
        readonly type: string;
        readonly data: Readonly<Record<string, unknown>>;
      }
    | undefined,
  group: CollaborationGroupMetadata | undefined,
  groupMemberIds: readonly string[],
): LegacyCanvasNode {
  const type = legacyNodeType(node.type);
  const matchingLocal = local !== undefined && collaborationNodeType(local) === node.type;
  const frameGroup = node.type === 'group-frame' ? group : undefined;
  const size = node.size ?? frameGroup?.size;
  const data = {
    ...(matchingLocal ? local.data : {}),
    kind: type,
    title: node.title,
    ...(node.color === undefined ? {} : { color: node.color }),
    ...(node.icon === undefined ? {} : { icon: node.icon }),
    status: localLegacyStatus(node.status),
    locked: node.locked ?? frameGroup?.locked ?? false,
    collapsed: node.collapsed ?? frameGroup?.collapsed ?? false,
    ...(node.assigneeId === undefined ? {} : { assigneeId: node.assigneeId }),
    ...(node.taskId === undefined ? {} : { taskId: node.taskId }),
    ...(node.type !== 'group-frame'
      ? {}
      : {
          purpose: frameGroup?.purpose ?? 'custom',
          childNodeIds: [...groupMemberIds],
          layout: frameGroup?.layout ?? 'freeform',
          autoFit: frameGroup?.autoFit ?? false,
        }),
    ...(node.type === 'file' && !matchingLocal
      ? {
          readOnly: true,
          recoverableWarning:
            'The person who shared this sent file details only, not the file itself. Choose a file on this device to link it.',
        }
      : {}),
  };
  return {
    id: node.id,
    type,
    position: node.position,
    ...(size === undefined ? {} : { width: size.width, height: size.height }),
    data,
  };
}

function collaborationGroupMemberIds(
  snapshot: CollaborationMetadataSnapshot,
  local: Canvas,
): ReadonlyMap<string, string[]> {
  const membersByGroup = new Map<string, Set<string>>();
  for (const node of Object.values(snapshot.nodes)) {
    if (node.groupId === undefined) continue;
    appendUnique(membersByGroup, node.groupId, node.id);
  }

  // Declarative extension payloads are deliberately local-only, including their frame membership.
  const localNodes = new Map(local.nodes.map((node) => [node.id, node]));
  for (const group of local.groups) {
    for (const nodeId of group.nodeIds) {
      if (localNodes.get(nodeId)?.type === 'extension') {
        appendUnique(membersByGroup, group.id, nodeId);
      }
    }
  }
  return new Map(
    [...membersByGroup].map(([groupId, memberIds]) => [groupId, [...memberIds]] as const),
  );
}

function appendUnique(target: Map<string, Set<string>>, groupId: string, nodeId: string): void {
  const members = target.get(groupId);
  if (members === undefined) {
    target.set(groupId, new Set([nodeId]));
    return;
  }
  members.add(nodeId);
}

function legacyEdgeFromCollaboration(edge: CollaborationEdgeMetadata): LegacyCanvasEdge {
  return {
    id: edge.id,
    source: edge.sourceId,
    target: edge.targetId,
    type: edge.type,
    data: {},
  };
}

function collaborationNodeType(node: {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}): CollaborationNodeType | undefined {
  const kind = typeof node.data['kind'] === 'string' ? node.data['kind'] : node.type;
  if (kind === 'brief') return 'product-brief';
  if (kind === 'diff') return 'diff-review';
  if (kind === 'whiteboard' || kind === 'whiteboard-mockup') return 'whiteboard';
  if (kind === 'extension') return undefined;
  return kind as CollaborationNodeType;
}

function legacyNodeType(type: CollaborationNodeType): string {
  if (type === 'product-brief') return 'brief';
  if (type === 'diff-review') return 'diff';
  if (type === 'whiteboard') return 'whiteboard';
  return type;
}

function localLegacyStatus(status: CollaborationNodeMetadata['status']): string {
  if (status === 'unavailable') return 'failed';
  return status ?? 'idle';
}

function localNodeStatus(
  status: CollaborationNodeMetadata['status'],
  fallback: NodeStatus,
): NodeStatus {
  switch (status) {
    case undefined:
      return fallback;
    case 'idle':
      return 'draft';
    case 'unavailable':
      return 'blocked';
    case 'queued':
    case 'running':
    case 'waiting-for-approval':
    case 'paused':
    case 'cancelling':
    case 'failed':
    case 'succeeded':
    case 'cancelled':
    case 'lost':
      return status;
  }
}

function applyTaskMetadata(
  node: Extract<CanvasNode, { type: 'task' }>,
  task: CollaborationTaskMetadata,
): Extract<CanvasNode, { type: 'task' }>['data'] {
  const data = { ...node.data } as Record<string, unknown>;
  delete data['assigneeId'];
  return {
    ...data,
    priority: task.priority ?? node.data.priority,
    ...(task.assigneeId === undefined ? {} : { assigneeId: task.assigneeId }),
    dependencyTaskIds: task.dependencyIds ?? node.data.dependencyTaskIds,
    taskStatus: localTaskStatus(task.status),
  } as Extract<CanvasNode, { type: 'task' }>['data'];
}

function localTaskStatus(
  status: CollaborationTaskMetadata['status'],
): Extract<CanvasNode, { type: 'task' }>['data']['taskStatus'] {
  if (status === 'running' || status === 'blocked') return 'in-progress';
  return status;
}

function localEdgeStatus(status: CollaborationEdgeMetadata['status']): CanvasEdge['status'] {
  switch (status) {
    case undefined:
    case 'idle':
      return undefined;
    case 'active':
      return 'running';
    case 'blocked':
      return 'waiting-for-approval';
    case 'queued':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return status;
  }
}
