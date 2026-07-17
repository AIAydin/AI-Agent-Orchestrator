import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import { canonicalCanvasFromLegacy } from '../../../../../shared/canvas/adapter.js';

export type NodeComment = NonNullable<
  CanvasDocument['canonical']
>['nodes'][number]['comments'][number];

export function localCommentsForNode(
  document: CanvasDocument | null,
  nodeId: string | null,
): NodeComment[] {
  return commentsForNode(document, nodeId).filter((comment) => comment.scope !== 'shared');
}

export function sharedCanonicalCommentsForNode(
  document: CanvasDocument | null,
  nodeId: string | null,
): NodeComment[] {
  return commentsForNode(document, nodeId).filter((comment) => comment.scope === 'shared');
}

export function appendLocalComment(
  document: CanvasDocument | null,
  nodeId: string,
  body: string,
  identity: { readonly id: string; readonly createdAt: string },
): CanvasDocument | null {
  if (document === null) return null;
  const migrated = canonicalCanvasFromLegacy(document);
  if (!migrated.ok) return document;
  const value = body.trim();
  if (value === '') return document;

  return withComment(document, migrated.canvas, nodeId, {
    id: identity.id,
    authorId: 'local-user',
    scope: 'local',
    body: value,
    createdAt: identity.createdAt,
  });
}

export function appendSharedComment(
  document: CanvasDocument | null,
  nodeId: string,
  comment: {
    readonly id: string;
    readonly authorId: string;
    readonly body: string;
    readonly createdAt: string;
    readonly updatedAt?: string | undefined;
    readonly resolved?: boolean | undefined;
  },
): CanvasDocument | null {
  if (document === null) return null;
  const migrated = canonicalCanvasFromLegacy(document);
  if (!migrated.ok) return document;
  return withComment(document, migrated.canvas, nodeId, {
    id: comment.id,
    authorId: comment.authorId,
    scope: 'shared',
    body: comment.body,
    createdAt: comment.createdAt,
    ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
    ...(comment.resolved ? { resolvedAt: comment.updatedAt ?? comment.createdAt } : {}),
  });
}

function commentsForNode(document: CanvasDocument | null, nodeId: string | null): NodeComment[] {
  if (document === null || nodeId === null) return [];
  const migrated = canonicalCanvasFromLegacy(document);
  if (!migrated.ok) return [];
  return migrated.canvas.nodes.find((node) => node.id === nodeId)?.comments ?? [];
}

function withComment(
  document: CanvasDocument,
  canonical: NonNullable<CanvasDocument['canonical']>,
  nodeId: string,
  comment: NodeComment,
): CanvasDocument {
  const target = canonical.nodes.find((node) => node.id === nodeId);
  if (target === undefined || target.comments.some((current) => current.id === comment.id)) {
    return document;
  }
  const now = new Date().toISOString();
  return {
    ...document,
    canonical: {
      ...canonical,
      nodes: canonical.nodes.map((node) =>
        node.id !== nodeId ? node : { ...node, comments: [...node.comments, comment] },
      ),
    },
    updatedAt: now,
  };
}
