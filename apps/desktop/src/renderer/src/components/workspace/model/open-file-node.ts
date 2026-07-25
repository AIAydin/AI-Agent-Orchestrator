import { NODE_DEFINITIONS, type WorkshopNode } from '../canvas/CanvasNode.js';
import { assignNodeName } from '../node-registry/node-names.js';
import { initialWorkshopNodeDimensions } from './node-persistence.js';

export interface OpenProjectFileInput {
  readonly projectId: string;
  readonly relativePath: string;
  readonly nodes: readonly WorkshopNode[];
  readonly newNodeId: string;
  readonly position?: { readonly x: number; readonly y: number };
}

export type OpenProjectFileResult =
  | { readonly kind: 'existing'; readonly nodeId: string }
  | { readonly kind: 'created'; readonly nodeId: string; readonly nodes: WorkshopNode[] };

/**
 * Tree-click open: reuses the canvas file node already bound to the clicked
 * project file, or appends a fresh minimal file node for it.
 */
export function openProjectFileNode(input: OpenProjectFileInput): OpenProjectFileResult {
  const existing = input.nodes.find(
    (node) =>
      node.data.kind === 'file' &&
      node.data.file?.projectId === input.projectId &&
      node.data.file.relativePath === input.relativePath,
  );
  if (existing !== undefined) return { kind: 'existing', nodeId: existing.id };

  const definition = NODE_DEFINITIONS.file;
  const offset = input.nodes.length * 24;
  const titlesInUse = new Set(input.nodes.map((node) => node.data.title));
  const node: WorkshopNode = {
    id: input.newNodeId,
    type: 'workshop',
    selected: true,
    position: input.position ?? { x: 220 + offset, y: 150 + offset },
    ...initialWorkshopNodeDimensions('file'),
    data: {
      kind: 'file',
      title: assignNodeName(titlesInUse),
      description: fileName(input.relativePath),
      status: 'idle',
      locked: false,
      collapsed: false,
      color: definition.color,
      file: {
        projectId: input.projectId,
        relativePath: input.relativePath,
        kind: 'file',
        missing: false,
      },
    },
  };
  return {
    kind: 'created',
    nodeId: node.id,
    nodes: [...input.nodes.map((current) => ({ ...current, selected: false })), node],
  };
}

function fileName(relativePath: string): string {
  return relativePath.split('/').at(-1) ?? relativePath;
}
