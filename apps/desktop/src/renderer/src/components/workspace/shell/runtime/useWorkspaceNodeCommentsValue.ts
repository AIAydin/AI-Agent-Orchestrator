import { useMemo, type Dispatch, type SetStateAction } from 'react';

import type { CanvasDocument } from '../../../../../../shared/application/contracts.js';
import {
  CollaborationCommentMetadataSchema,
  type CollaborationCommentMetadata,
} from '../../../../../../shared/collaboration/index.js';
import type { NodeCommentsContextValue } from '../../canvas/node-details/NodeCommentsContext.js';
import {
  appendLocalComment,
  appendSharedComment,
  localCommentsForNode,
  sharedCanonicalCommentsForNode,
} from '../../comments/comment-model.js';
import type { CollaborationCanvasBinding } from '../../collaboration/useCollaborationCanvas.js';

type CommentCollaborationBinding = Pick<
  CollaborationCanvasBinding,
  'canComment' | 'createComment' | 'discardRejectedComment' | 'rejectedCommentEntries'
>;

interface UseWorkspaceNodeCommentsValueInput {
  readonly pendingCanvas: CanvasDocument | null;
  readonly collaboration: CommentCollaborationBinding;
  readonly roomEnabled: boolean;
  readonly setCanvas: Dispatch<SetStateAction<CanvasDocument | null>>;
  readonly setEvents: Dispatch<SetStateAction<string[]>>;
}

export function useWorkspaceNodeCommentsValue({
  pendingCanvas,
  collaboration,
  roomEnabled,
  setCanvas,
  setEvents,
}: UseWorkspaceNodeCommentsValueInput): NodeCommentsContextValue {
  return useMemo<NodeCommentsContextValue>(
    () => ({
      localCommentsFor: (nodeId) => localCommentsForNode(pendingCanvas, nodeId),
      sharedCommentsFor: (nodeId) => collaborationCommentsForNode(pendingCanvas, nodeId),
      rejectedSharedCommentsFor: (nodeId) =>
        collaboration.rejectedCommentEntries.filter((entry) => entry.comment.nodeId === nodeId),
      createLocalComment: (nodeId, body) => {
        if (pendingCanvas === null || body.trim() === '') return false;
        const next = appendLocalComment(pendingCanvas, nodeId, body, {
          id: `local:${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
        });
        if (next === null || next === pendingCanvas) return false;
        setCanvas(next);
        setEvents((items) => ['Saved a private comment on this computer.', ...items].slice(0, 80));
        return true;
      },
      createSharedComment: async (nodeId, body) => {
        const comment = await collaboration.createComment(nodeId, body);
        if (comment === null) return false;
        setCanvas((current) => appendSharedComment(current, nodeId, comment));
        setEvents((items) => ['Shared a comment.', ...items].slice(0, 80));
        return true;
      },
      discardRejectedComment: collaboration.discardRejectedComment,
      canComment: collaboration.canComment,
      roomEnabled,
    }),
    [collaboration, pendingCanvas, roomEnabled, setCanvas, setEvents],
  );
}

function collaborationCommentsForNode(
  canvas: CanvasDocument | null,
  nodeId: string,
): CollaborationCommentMetadata[] {
  return sharedCanonicalCommentsForNode(canvas, nodeId).flatMap((comment) => {
    const parsed = CollaborationCommentMetadataSchema.safeParse({
      id: comment.id,
      nodeId,
      authorId: comment.authorId,
      body: comment.body,
      createdAt: comment.createdAt,
      ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
      ...(comment.resolvedAt === undefined ? {} : { resolved: true }),
    });
    return parsed.success ? [parsed.data] : [];
  });
}
