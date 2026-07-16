import type { WorkshopNode } from '../canvas/CanvasNode.js';
import type { WorkspaceContextDragPayload } from './contracts.js';

const DEFAULT_NODE_WIDTH = 210;
const DEFAULT_NODE_HEIGHT = 92;

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
  if (input.source.data.kind !== 'file') return null;

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
    return { ok: false, message: 'Unlock the File node before linking it as context.' };
  }
  if (target.data.locked) {
    return { ok: false, message: 'Unlock the Agent node before changing its context.' };
  }

  const reference = input.source.data.file;
  if (reference === undefined) {
    return { ok: false, message: 'Configure the File node before linking it as context.' };
  }
  if (reference.projectId !== input.projectId) {
    return { ok: false, message: 'The File node belongs to another project.' };
  }
  if (reference.missing) {
    return { ok: false, message: 'Choose a replacement for the missing File node first.' };
  }
  if (reference.kind !== 'file') {
    return { ok: false, message: 'Only ordinary File nodes can be Agent context.' };
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
  const width = positiveDimension(node.measured?.width ?? node.width) ?? DEFAULT_NODE_WIDTH;
  const height = positiveDimension(node.measured?.height ?? node.height) ?? DEFAULT_NODE_HEIGHT;
  return (
    point.x >= node.position.x &&
    point.x <= node.position.x + width &&
    point.y >= node.position.y &&
    point.y <= node.position.y + height
  );
}

function nodeCenter(node: WorkshopNode): { readonly x: number; readonly y: number } {
  const width = positiveDimension(node.measured?.width ?? node.width) ?? DEFAULT_NODE_WIDTH;
  const height = positiveDimension(node.measured?.height ?? node.height) ?? DEFAULT_NODE_HEIGHT;
  return { x: node.position.x + width / 2, y: node.position.y + height / 2 };
}

function positiveDimension(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
