import {
  CollaborationMetadataSnapshotSchema,
  type CollaborationMetadataSnapshot,
} from '../../../../../shared/collaboration/index.js';

/**
 * Retains allowlisted room fields that the current local canvas model cannot author yet. Local
 * graph fields remain authoritative, deleted records stay deleted, and opaque file bindings are
 * never adopted from another machine.
 */
export function preserveRemoteCollaborationMetadata(
  local: CollaborationMetadataSnapshot,
  remote: CollaborationMetadataSnapshot | null,
): CollaborationMetadataSnapshot {
  const projected = CollaborationMetadataSnapshotSchema.parse(local);
  if (remote === null) return projected;
  const previous = CollaborationMetadataSnapshotSchema.parse(remote);

  const nodes = Object.fromEntries(
    Object.entries(projected.nodes).map(([id, node]) => {
      const old = previous.nodes[id];
      if (old === undefined) return [id, node];
      return [
        id,
        {
          ...node,
          ...(old.order === undefined ? {} : { order: old.order }),
          ...(old.taskId === undefined || projected.tasks[old.taskId] === undefined
            ? {}
            : { taskId: old.taskId }),
          ...(node.type === 'task' || old.assigneeId === undefined
            ? {}
            : { assigneeId: old.assigneeId }),
          ...(node.type === 'file' && old.availability === 'unavailable'
            ? { availability: 'unavailable' as const }
            : {}),
        },
      ];
    }),
  );
  const edges = Object.fromEntries(
    Object.entries(projected.edges).map(([id, edge]) => {
      const updatedAt = previous.edges[id]?.updatedAt;
      return [id, { ...edge, ...(updatedAt === undefined ? {} : { updatedAt }) }];
    }),
  );
  const groups = Object.fromEntries(
    Object.entries(projected.groups).map(([id, group]) => {
      const old = previous.groups[id];
      return [
        id,
        {
          ...group,
          ...(group.collapsed !== undefined || old?.collapsed === undefined
            ? {}
            : { collapsed: old.collapsed }),
          ...(old?.order === undefined ? {} : { order: old.order }),
          ...(old?.createdAt === undefined ? {} : { createdAt: old.createdAt }),
          ...(old?.updatedAt === undefined ? {} : { updatedAt: old.updatedAt }),
        },
      ];
    }),
  );
  const tasks = Object.fromEntries(
    Object.entries(projected.tasks).map(([id, task]) => {
      const order = previous.tasks[id]?.order;
      return [id, { ...task, ...(order === undefined ? {} : { order }) }];
    }),
  );
  const comments = Object.fromEntries(
    Object.entries(projected.comments).map(([id, comment]) => {
      const old = previous.comments[id];
      return [
        id,
        {
          ...comment,
          ...(old?.taskId === undefined || tasks[old.taskId] === undefined
            ? {}
            : { taskId: old.taskId }),
          ...(old?.replyToId === undefined || projected.comments[old.replyToId] === undefined
            ? {}
            : { replyToId: old.replyToId }),
        },
      ];
    }),
  );
  const workflow = Object.fromEntries(
    Object.entries(previous.workflow).filter(
      ([, item]) => item.nodeId === undefined || nodes[item.nodeId] !== undefined,
    ),
  );
  const reviews = Object.fromEntries(
    Object.entries(previous.reviews)
      .filter(([, review]) => nodes[review.nodeId] !== undefined)
      .map(([id, review]) => [
        id,
        {
          ...review,
          ...(review.commentIds === undefined
            ? {}
            : {
                commentIds: review.commentIds.filter(
                  (commentId) => comments[commentId] !== undefined,
                ),
              }),
        },
      ]),
  );

  return CollaborationMetadataSnapshotSchema.parse({
    ...projected,
    canvas: {
      ...projected.canvas,
      ...(previous.canvas.theme === undefined ? {} : { theme: previous.canvas.theme }),
    },
    nodes,
    edges,
    groups,
    tasks,
    comments,
    workflow,
    reviews,
  });
}
