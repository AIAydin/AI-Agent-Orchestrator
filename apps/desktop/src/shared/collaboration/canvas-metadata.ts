import {
  CanvasNodeSchema,
  CanvasEdgeSchema,
  CanvasSchema,
  type Canvas,
  type CanvasEdge,
  type CanvasNode,
  type NodeStatus,
} from '@forgeboard/core/domain';
import { z } from 'zod';

import {
  CollaborationFileAvailabilitySchema,
  CollaborationMetadataSnapshotSchema,
  type CollaborationCommentMetadata,
  type CollaborationEdgeMetadata,
  type CollaborationGroupMetadata,
  type CollaborationMetadataSnapshot,
  type CollaborationNodeMetadata,
  type CollaborationNodeType,
  type CollaborationTaskMetadata,
} from './metadata-contracts.js';
import {
  CollaborationIdSchema,
  CollaborationLocalResourceIdSchema,
  CollaborationSubjectSchema,
} from './values.js';

export const CollaborationFileResourceBindingSchema = z
  .object({
    localResourceId: CollaborationLocalResourceIdSchema.optional(),
    availability: CollaborationFileAvailabilitySchema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.availability === 'local' && binding.localResourceId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localResourceId'],
        message: 'Locally available file metadata requires an opaque local resource identifier.',
      });
    }
  });
export type CollaborationFileResourceBinding = z.infer<
  typeof CollaborationFileResourceBindingSchema
>;

export const CollaborationCanvasProjectionOptionsSchema = z
  .object({
    fileResources: z
      .record(CollaborationIdSchema, CollaborationFileResourceBindingSchema)
      .superRefine((bindings, context) => {
        if (Object.keys(bindings).length > 10_000) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Collaboration file resource bindings cannot exceed 10,000 records.',
          });
        }
      })
      .default({}),
  })
  .strict();
export type CollaborationCanvasProjectionOptions = z.input<
  typeof CollaborationCanvasProjectionOptionsSchema
>;

export class CollaborationMetadataProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollaborationMetadataProjectionError';
  }
}

export function collaborationMetadataSnapshotFromCanvas(
  canvas: Canvas,
  options: CollaborationCanvasProjectionOptions = {},
): CollaborationMetadataSnapshot {
  const canonical = CanvasSchema.parse(canvas);
  const parsedOptions = CollaborationCanvasProjectionOptionsSchema.parse(options);
  const nodes: Record<string, CollaborationNodeMetadata> = {};
  const includedNodeIds = new Set<string>();

  for (const nodeId of Object.keys(parsedOptions.fileResources)) {
    if (canonical.nodes.find((node) => node.id === nodeId)?.type !== 'file') {
      throw new CollaborationMetadataProjectionError(
        `File resource binding does not belong to a canonical file node: ${nodeId}`,
      );
    }
  }

  for (const node of canonical.nodes) {
    const metadata = collaborationNodeMetadataFromCanvasNode(
      node,
      parsedOptions.fileResources[node.id],
    );
    if (metadata === undefined) continue;
    insertUnique(nodes, metadata);
    includedNodeIds.add(metadata.id);
  }

  const edges: Record<string, CollaborationEdgeMetadata> = {};
  for (const edge of canonical.edges) {
    if (!includedNodeIds.has(edge.sourceNodeId) || !includedNodeIds.has(edge.targetNodeId))
      continue;
    insertUnique(edges, collaborationEdgeMetadataFromCanvasEdge(edge));
  }

  const groups: Record<string, CollaborationGroupMetadata> = {};
  const groupFrames = new Map(
    canonical.nodes
      .filter(
        (node): node is Extract<CanvasNode, { type: 'group-frame' }> => node.type === 'group-frame',
      )
      .map((node) => [node.id, node] as const),
  );
  for (const group of canonical.groups) {
    const frame = groupFrames.get(group.id);
    insertUnique(groups, {
      id: group.id,
      title: boundedRequiredText(frame?.title ?? group.title, 160, 'Untitled group'),
      position: {
        x: frame?.position.x ?? group.position.x,
        y: frame?.position.y ?? group.position.y,
      },
      size: {
        width: frame?.size.width ?? group.size.width,
        height: frame?.size.height ?? group.size.height,
      },
      ...(sixDigitColor(frame?.color ?? group.color) === undefined
        ? {}
        : { color: frame?.color ?? group.color }),
      locked: frame?.locked ?? group.locked,
      ...(frame === undefined
        ? {}
        : {
            collapsed: frame.collapsed,
            purpose: frame.data.purpose,
            layout: frame.data.layout,
            autoFit: frame.data.autoFit,
          }),
    });
  }

  const tasks: Record<string, CollaborationTaskMetadata> = {};
  for (const node of canonical.nodes) {
    if (node.type !== 'task' || !includedNodeIds.has(node.id)) continue;
    insertUnique(tasks, collaborationTaskMetadataFromCanvasNode(node));
  }

  const comments: Record<string, CollaborationCommentMetadata> = {};
  for (const node of canonical.nodes) {
    if (!includedNodeIds.has(node.id)) continue;
    for (const comment of node.comments) {
      // Unscoped comments predate collaboration-aware storage and are private by default. Only an
      // explicit user-authorized shared comment may enter a room document.
      if (comment.scope !== 'shared') continue;
      const body = comment.body.trim();
      const authorId = optionalParsedString(CollaborationSubjectSchema, comment.authorId);
      if (body === '' || body.length > 4_000 || authorId === undefined) {
        throw new CollaborationMetadataProjectionError(
          `Comment cannot be represented by the collaboration metadata contract: ${comment.id}`,
        );
      }
      insertUnique(comments, {
        id: comment.id,
        nodeId: node.id,
        ...(node.type === 'task' ? { taskId: node.id } : {}),
        authorId,
        body,
        resolved: comment.resolvedAt !== undefined,
        createdAt: comment.createdAt,
        ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
      });
    }
  }

  return CollaborationMetadataSnapshotSchema.parse({
    canvas: {
      id: canonical.id,
      title: boundedRequiredText(canonical.name, 160, 'Untitled canvas'),
      version: canonical.schemaVersion,
      updatedAt: canonical.updatedAt,
      viewport: {
        x: canonical.viewState.viewport.x,
        y: canonical.viewState.viewport.y,
      },
      zoom: Math.min(canonical.viewState.viewport.zoom, 8),
    },
    nodes,
    edges,
    groups,
    tasks,
    comments,
    workflow: {},
    reviews: {},
  });
}

export function collaborationNodeMetadataFromCanvasNode(
  input: CanvasNode,
  fileResource?: CollaborationFileResourceBinding,
): CollaborationNodeMetadata | undefined {
  const node = CanvasNodeSchema.parse(input);
  const parsedFileResource =
    fileResource === undefined
      ? undefined
      : CollaborationFileResourceBindingSchema.parse(fileResource);
  if (parsedFileResource !== undefined && node.type !== 'file') {
    throw new CollaborationMetadataProjectionError(
      `File resource binding does not belong to a canonical file node: ${node.id}`,
    );
  }
  const type = collaborationNodeType(node);
  if (type === undefined) return undefined;
  const assigneeId =
    node.type === 'task'
      ? optionalParsedString(CollaborationSubjectSchema, node.data.assigneeId)
      : undefined;
  const color = sixDigitColor(node.color);
  const icon = boundedOptionalText(node.icon, 40);

  return {
    id: node.id,
    type,
    title: boundedRequiredText(node.title, 160, 'Untitled node'),
    position: { x: node.position.x, y: node.position.y },
    size: { width: node.size.width, height: node.size.height },
    ...(color === undefined ? {} : { color }),
    ...(icon === undefined ? {} : { icon }),
    status: collaborationNodeStatus(node.status),
    locked: node.locked,
    collapsed: node.collapsed,
    ...(node.groupId === undefined ? {} : { groupId: node.groupId }),
    ...(assigneeId === undefined ? {} : { assigneeId }),
    ...(type !== 'file'
      ? {}
      : {
          ...(parsedFileResource?.localResourceId === undefined
            ? {}
            : { localResourceId: parsedFileResource.localResourceId }),
          availability:
            parsedFileResource?.availability ??
            (node.type === 'file' && node.data.file?.missing === true
              ? 'unavailable'
              : 'metadata-only'),
        }),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

export function collaborationEdgeMetadataFromCanvasEdge(
  input: CanvasEdge,
): CollaborationEdgeMetadata {
  const edge = CanvasEdgeSchema.parse(input);
  const status = collaborationEdgeStatus(edge.status);
  const label = boundedOptionalText(edge.label, 240);
  return {
    id: edge.id,
    sourceId: edge.sourceNodeId,
    targetId: edge.targetNodeId,
    type: edge.type,
    ...(status === undefined ? {} : { status }),
    ...(label === undefined ? {} : { label }),
    createdAt: edge.createdAt,
  };
}

export function parseCollaborationMetadataSnapshot(input: unknown): CollaborationMetadataSnapshot {
  return CollaborationMetadataSnapshotSchema.parse(input);
}

export function serializeCollaborationMetadataSnapshot(
  input: CollaborationMetadataSnapshot,
): string {
  return JSON.stringify(parseCollaborationMetadataSnapshot(input));
}

export function deserializeCollaborationMetadataSnapshot(
  serialized: string,
): CollaborationMetadataSnapshot {
  return parseCollaborationMetadataSnapshot(JSON.parse(serialized) as unknown);
}

function collaborationNodeType(node: CanvasNode): CollaborationNodeType | undefined {
  switch (node.type) {
    case 'whiteboard-mockup':
      return 'whiteboard';
    case 'extension':
      // The server wire contract intentionally has no extension payload. Omitting the node also
      // prevents declarative definitions and values from being mistaken for safe shared metadata.
      return undefined;
    case 'agent':
    case 'product-brief':
    case 'task':
    case 'file':
    case 'diff-review':
    case 'terminal':
    case 'web-preview':
    case 'mobile-preview':
    case 'test':
    case 'review-gate':
    case 'git-pr':
    case 'diagram':
    case 'note-image':
    case 'group-frame':
      return node.type;
  }
}

function collaborationNodeStatus(status: NodeStatus): CollaborationNodeMetadata['status'] {
  switch (status) {
    case 'draft':
    case 'ready':
      return 'idle';
    case 'cancelling':
      return 'running';
    case 'lost':
    case 'blocked':
      return 'unavailable';
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

function collaborationEdgeStatus(
  status: CanvasEdge['status'],
): CollaborationEdgeMetadata['status'] | undefined {
  switch (status) {
    case undefined:
      return undefined;
    case 'queued':
      return 'queued';
    case 'running':
    case 'cancelling':
      return 'active';
    case 'waiting-for-approval':
    case 'paused':
      return 'blocked';
    case 'succeeded':
      return 'succeeded';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'lost':
      return 'failed';
  }
}

function collaborationTaskMetadataFromCanvasNode(
  node: Extract<CanvasNode, { type: 'task' }>,
): CollaborationTaskMetadata {
  if (node.data.dependencyTaskIds.length > 100) {
    throw new CollaborationMetadataProjectionError(
      `Task has more than 100 collaboration dependencies: ${node.id}`,
    );
  }
  const assigneeId = optionalParsedString(CollaborationSubjectSchema, node.data.assigneeId);
  return {
    id: node.id,
    title: boundedRequiredText(node.title, 200, 'Untitled task'),
    priority: node.data.priority,
    ...(assigneeId === undefined ? {} : { assigneeId }),
    status: collaborationTaskStatus(node.data.taskStatus),
    dependencyIds: [...node.data.dependencyTaskIds],
    acceptanceState:
      node.data.acceptanceCriteria.length > 0 &&
      node.data.acceptanceCriteria.every((criterion) => criterion.satisfied)
        ? 'passed'
        : 'not-checked',
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function collaborationTaskStatus(
  status: Extract<CanvasNode, { type: 'task' }>['data']['taskStatus'],
): CollaborationTaskMetadata['status'] {
  return status === 'in-progress' ? 'running' : status;
}

function insertUnique<T extends { readonly id: string }>(
  records: Record<string, T>,
  value: T,
): void {
  if (Object.hasOwn(records, value.id)) {
    throw new CollaborationMetadataProjectionError(
      `Duplicate collaboration metadata identifier: ${value.id}`,
    );
  }
  records[value.id] = value;
}

function boundedRequiredText(value: string, maximum: number, fallback: string): string {
  const normalized = value.trim();
  const bounded = normalized === '' ? fallback : normalized;
  if (bounded.length > maximum) {
    throw new CollaborationMetadataProjectionError(
      `Collaboration metadata text exceeds the ${maximum}-character limit.`,
    );
  }
  return bounded;
}

function boundedOptionalText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new CollaborationMetadataProjectionError(
      `Collaboration metadata text exceeds the ${maximum}-character limit.`,
    );
  }
  return normalized === '' ? undefined : normalized;
}

function sixDigitColor(value: string): string | undefined {
  return /^#[0-9A-Fa-f]{6}$/u.test(value) ? value : undefined;
}

function optionalParsedString(
  schema: z.ZodType<string>,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
