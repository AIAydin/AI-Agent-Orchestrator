import type { WorkshopNode } from '../CanvasNode.js';
import type { WorkshopEdge } from '../../model/types.js';
import { persistedWorkshopNodeDimensions } from '../../model/node-persistence.js';

export interface CanvasClipboardSelection {
  nodes: WorkshopNode[];
  edges: WorkshopEdge[];
}

interface InstantiateSelectionOptions {
  createId: () => string;
  offset?: number;
}

const RUNTIME_DATA_KEYS = [
  'changedFiles',
  'lastRunPermissionProfile',
  'lastRunSummary',
  'runId',
  'runIds',
  'transcript',
  'transcriptUpdatedAt',
] as const;

const NODE_ID_KEYS = ['assigneeId', 'reviewerAgentId'] as const;
const NODE_ID_ARRAY_KEYS = ['attachmentIds', 'childNodeIds', 'dependencyTaskIds'] as const;

export function captureSelectedSubgraph(
  nodes: readonly WorkshopNode[],
  edges: readonly WorkshopEdge[],
  fallbackNodeId: string | null = null,
): CanvasClipboardSelection {
  const explicitlySelected = nodes.filter((node) => node.selected === true);
  const selectedNodes =
    explicitlySelected.length > 0
      ? explicitlySelected
      : nodes.filter((node) => node.id === fallbackNodeId);
  const selectedIds = selectedNodeClosure(selectedNodes, nodes);

  return {
    nodes: nodes.filter((node) => selectedIds.has(node.id)),
    edges: edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)),
  };
}

export function instantiateClipboardSelection(
  selection: CanvasClipboardSelection,
  { createId, offset = 32 }: InstantiateSelectionOptions,
): CanvasClipboardSelection {
  const nodeIds = new Map(selection.nodes.map((node) => [node.id, createId()] as const));
  const referenceIds = new Map(nodeIds);
  for (const node of selection.nodes) {
    if (node.data.kind !== 'test' || node.data.checkKind !== 'custom') continue;
    const copiedNodeId = nodeIds.get(node.id);
    const producerId = node.data.runIds?.[0];
    if (copiedNodeId !== undefined && producerId !== undefined) {
      referenceIds.set(producerId, copiedNodeId);
    }
  }
  const nodes = selection.nodes.map((node) => {
    const id = nodeIds.get(node.id);
    if (id === undefined) throw new Error(`Missing duplicate ID for canvas node ${node.id}.`);
    return {
      ...node,
      id,
      selected: true,
      position: { x: node.position.x + offset, y: node.position.y + offset },
      ...persistedWorkshopNodeDimensions(node),
      data: duplicateNodeData(node.data, nodeIds, referenceIds, id),
    };
  });
  const edges = selection.edges.map((edge) => {
    const source = nodeIds.get(edge.source);
    const target = nodeIds.get(edge.target);
    if (source === undefined || target === undefined) {
      throw new Error(`Canvas clipboard edge ${edge.id} is not internal to its node selection.`);
    }
    const data = remapEdgeData(edge.data, nodeIds);
    return {
      ...edge,
      id: createId(),
      source,
      target,
      selected: false,
      ...(data === undefined ? {} : { data }),
    };
  });

  return { nodes, edges };
}

function duplicateNodeData(
  source: WorkshopNode['data'],
  nodeIds: ReadonlyMap<string, string>,
  referenceIds: ReadonlyMap<string, string>,
  copiedNodeId: string,
): WorkshopNode['data'] {
  const data = structuredClone(source);
  const record = data as Record<string, unknown>;
  for (const key of RUNTIME_DATA_KEYS) delete record[key];

  data.title = `${source.title} copy`;
  data.status = 'idle';
  data.locked = false;
  if (data.gateState !== undefined) data.gateState = 'pending';
  if (data.kind === 'test') {
    const checkKind = data.checkKind ?? 'test';
    data.runIds = [checkKind === 'custom' ? copiedNodeId : checkKind];
  }

  for (const key of NODE_ID_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && nodeIds.has(value)) record[key] = nodeIds.get(value);
  }
  for (const key of NODE_ID_ARRAY_KEYS) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    record[key] = (value as unknown[]).flatMap((id: unknown) => {
      if (typeof id !== 'string') return [id];
      const remapped = nodeIds.get(id);
      if (remapped !== undefined) return [remapped];
      return source.kind === 'group-frame' && key === 'childNodeIds' ? [] : [id];
    });
  }
  if (Array.isArray(data.requiredCheckIds)) {
    data.requiredCheckIds = data.requiredCheckIds.map((id) => referenceIds.get(id) ?? id);
  }
  return data;
}

function selectedNodeClosure(
  selectedNodes: readonly WorkshopNode[],
  allNodes: readonly WorkshopNode[],
): Set<string> {
  const availableIds = new Set(allNodes.map((node) => node.id));
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  for (const frame of selectedNodes) {
    if (frame.data.kind !== 'group-frame') continue;
    for (const childId of frame.data.childNodeIds ?? []) {
      if (availableIds.has(childId)) selectedIds.add(childId);
    }
  }
  return selectedIds;
}

function remapEdgeData(
  source: WorkshopEdge['data'],
  nodeIds: ReadonlyMap<string, string>,
): WorkshopEdge['data'] {
  if (source === undefined) return undefined;
  const data = structuredClone(source);
  if (data.edgeType === 'context') {
    data.config.attachmentIds = data.config.attachmentIds.map((id) => nodeIds.get(id) ?? id);
  }
  if (data.edgeType === 'execute' && data.config.approvalGateNodeId !== undefined) {
    data.config.approvalGateNodeId =
      nodeIds.get(data.config.approvalGateNodeId) ?? data.config.approvalGateNodeId;
  }
  return data;
}
