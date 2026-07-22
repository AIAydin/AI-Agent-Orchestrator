import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { CANVAS_NODE_MINIMUM_DIMENSIONS } from '../../../../../shared/canvas/node-dimensions.js';
import type { WorkspaceContextDragPayload } from './contracts.js';

export type FileNodeContextDropResolution =
  | {
      readonly ok: true;
      readonly targetNodeId: string;
      readonly payload: WorkspaceContextDragPayload;
    }
  | { readonly ok: false; readonly message: string }
  | null;

/** Resolves a completed ReactFlow File-node gesture without turning ordinary movement into a link. */
export function resolveFileNodeContextDrop(input: {
  readonly projectId: string;
  readonly source: WorkshopNode;
  readonly draggedNodes: readonly WorkshopNode[];
  readonly nodes: readonly WorkshopNode[];
}): FileNodeContextDropResolution {
  if (input.source.data.kind !== 'file' && input.source.data.kind !== 'video') return null;

  const draggedIds = new Set(
    (input.draggedNodes.length > 0 ? input.draggedNodes : [input.source]).map((node) => node.id),
  );
  const sourceCenter = nodeCenter(input.source);
  const target = input.nodes.find(
    (node) =>
      !draggedIds.has(node.id) &&
      node.hidden !== true &&
      node.data.kind === 'agent' &&
      containsPoint(node, sourceCenter),
  );
  if (target === undefined) return null;
  if (input.source.data.locked) {
    return {
      ok: false,
      message: 'Unlock the context node before sharing it with an agent.',
    };
  }
  if (target.data.locked) {
    return {
      ok: false,
      message: 'Unlock the agent before changing its files.',
    };
  }

  const reference = input.source.data.file;
  if (reference === undefined) {
    return {
      ok: false,
      message: 'Set up the file or video before sharing it with an agent.',
    };
  }
  if (reference.projectId !== input.projectId) {
    return { ok: false, message: 'This file belongs to another project.' };
  }
  if (reference.missing) {
    return {
      ok: false,
      message: 'This file is missing. Choose a replacement first.',
    };
  }
  if (reference.kind !== 'file') {
    return {
      ok: false,
      message: 'Only regular files can be shared with an agent.',
    };
  }

  return {
    ok: true,
    targetNodeId: target.id,
    payload: {
      schemaVersion: 1,
      kind: 'project-file',
      projectId: reference.projectId,
      relativePath: reference.relativePath,
      sourceNodeId: input.source.id,
    },
  };
}

function containsPoint(node: WorkshopNode, point: { readonly x: number; readonly y: number }) {
  const width = resolvedDimension(
    node.measured?.width ?? node.width,
    CANVAS_NODE_MINIMUM_DIMENSIONS.width,
  );
  const height = resolvedDimension(
    node.measured?.height ?? node.height,
    CANVAS_NODE_MINIMUM_DIMENSIONS.height,
  );
  return (
    point.x >= node.position.x &&
    point.x <= node.position.x + width &&
    point.y >= node.position.y &&
    point.y <= node.position.y + height
  );
}

function nodeCenter(node: WorkshopNode): {
  readonly x: number;
  readonly y: number;
} {
  const width = resolvedDimension(
    node.measured?.width ?? node.width,
    CANVAS_NODE_MINIMUM_DIMENSIONS.width,
  );
  const height = resolvedDimension(
    node.measured?.height ?? node.height,
    CANVAS_NODE_MINIMUM_DIMENSIONS.height,
  );
  return { x: node.position.x + width / 2, y: node.position.y + height / 2 };
}

function resolvedDimension(value: number | null | undefined, minimum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(minimum, value)
    : minimum;
}
