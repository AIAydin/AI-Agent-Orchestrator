import { providerTheme } from './provider-themes.js';
import { NODE_DEFINITIONS, type NodeKind } from './registry.js';
import { assignNodeName } from './node-names.js';

/**
 * The slice of a canvas node this migration needs: enough to detect a still-generic title and
 * to write a replacement. Kept structural (rather than importing `WorkshopNode`) so this pure
 * module has no dependency on the canvas/React layer.
 */
export interface MigratableNode {
  readonly id: string;
  readonly data: {
    readonly kind: NodeKind;
    readonly title: string;
    readonly adapterId?: string | undefined;
    readonly [key: string]: unknown;
  };
}

/**
 * One-pass normalization for nodes loaded from a persisted canvas: any node whose title is
 * still empty or exactly its kind's generic label (or, for agents, its provider theme's label)
 * is given a distinct friendly name. User-customized titles are left untouched. Threads the
 * in-use set across the batch so newly assigned names stay distinct from each other and from
 * every existing custom title. Idempotent — a node already carrying a distinct friendly name is
 * not generic, so a second pass is a no-op and returns the same array reference.
 */
export function migrateGenericNodeTitles<T extends MigratableNode>(nodes: readonly T[]): T[] {
  const inUse = new Set(
    nodes.filter((node) => !isGenericNodeTitle(node.data)).map((node) => node.data.title),
  );
  let changed = false;
  const migrated = nodes.map((node) => {
    if (!isGenericNodeTitle(node.data)) return node;
    const title = assignNodeName(inUse);
    inUse.add(title);
    changed = true;
    return { ...node, data: { ...node.data, title } };
  });
  return changed ? migrated : (nodes as T[]);
}

function isGenericNodeTitle(data: MigratableNode['data']): boolean {
  const trimmed = data.title.trim();
  if (trimmed === '') return true;
  if (data.kind === 'agent') {
    const theme = providerTheme(data.adapterId);
    if (theme !== null && trimmed === theme.label) return true;
  }
  const definition = NODE_DEFINITIONS[data.kind];
  return definition !== undefined && trimmed === definition.label;
}
