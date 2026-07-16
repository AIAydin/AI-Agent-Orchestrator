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
  CollaborationMetadataSnapshotSchema,
  type CollaborationCommentMetadata,
  type CollaborationEdgeMetadata,
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
      message: 'The collaboration room snapshot belongs to a different canvas.',
    };
  }

  const local = canonicalCanvasFromLegacy(document);
  if (!local.ok) {
    return {
      ok: false,
      message: 'The local canvas could not be migrated before collaboration was applied.',
    };
  }

  const extensionNodeIds = new Set(
    local.canvas.nodes.filter((node) => node.type === 'extension').map((node) => node.id),
  );
  const localLegacyNodes = new Map(document.nodes.map((node) => [node.id, node]));
  const remoteNodes: LegacyCanvasNode[] = Object.values(snapshot.nodes).map((node) =>
    legacyNodeFromCollaboration(node, localLegacyNodes.get(node.id)),
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
      message: 'The collaboration metadata could not be represented by the local canvas.',
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
      message: 'The collaboration metadata failed local canvas validation.',
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
  const groups = mergedGroups(migrated, local, snapshot, options, nodeIds);
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
  task: CollaborationTaskMetadata | undefined,
  comments: readonly CollaborationCommentMetadata[],
  workflow: readonly CollaborationWorkflowMetadata[],
  reviews: readonly CollaborationReviewMetadata[],
  canvasUpdatedAt: string,
  options: CollaborationCanvasMergeOptions,
): CanvasNode {
  const localComments = options.initial ? (localNode?.comments ?? []) : [];
  const mergedComments = new Map(localComments.map((comment) => [comment.id, comment]));
  for (const comment of comments) {
    mergedComments.set(comment.id, {
      id: comment.id,
      authorId: comment.authorId,
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

  return CanvasNodeSchema.parse({
    ...withoutGroup,
    title: metadata.title,
    position: metadata.position,
    size: metadata.size ?? node.size,
    color: metadata.color ?? node.color,
    icon: metadata.icon ?? node.icon,
    status: localNodeStatus(metadata.status, node.status),
    locked: metadata.locked ?? false,
    collapsed: metadata.collapsed ?? false,
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
  const remoteGroups = Object.values(snapshot.groups).map((group) => {
    const localGroup = localGroups.get(group.id);
    const localOnlyMembers = (localGroup?.nodeIds ?? []).filter((nodeId) => {
      return localNodes.get(nodeId)?.type === 'extension';
    });
    return {
      id: group.id,
      title: group.title,
      nodeIds: [...new Set([...(remoteMembers.get(group.id) ?? []), ...localOnlyMembers])].filter(
        (id) => nodeIds.has(id),
      ),
      position: group.position,
      size: group.size,
      color: group.color ?? localGroup?.color ?? '#82909b',
      locked: group.locked ?? false,
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
): LegacyCanvasNode {
  const type = legacyNodeType(node.type);
  const matchingLocal = local !== undefined && collaborationNodeType(local) === node.type;
  const data = {
    ...(matchingLocal ? local.data : {}),
    kind: type,
    title: node.title,
    ...(node.color === undefined ? {} : { color: node.color }),
    ...(node.icon === undefined ? {} : { icon: node.icon }),
    status: localLegacyStatus(node.status),
    locked: node.locked ?? false,
    collapsed: node.collapsed ?? false,
    ...(node.assigneeId === undefined ? {} : { assigneeId: node.assigneeId }),
    ...(node.taskId === undefined ? {} : { taskId: node.taskId }),
    ...(node.type === 'file' && !matchingLocal
      ? {
          readOnly: true,
          recoverableWarning:
            'This collaborator shared file metadata only. Choose a local project file to link it.',
        }
      : {}),
  };
  return {
    id: node.id,
    type,
    position: node.position,
    ...(node.size === undefined ? {} : { width: node.size.width, height: node.size.height }),
    data,
  };
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
  if (status === 'waiting-for-approval' || status === 'paused') return 'waiting';
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
    case 'failed':
    case 'succeeded':
    case 'cancelled':
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
