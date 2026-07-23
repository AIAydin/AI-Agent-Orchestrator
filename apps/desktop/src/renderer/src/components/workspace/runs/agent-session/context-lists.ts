import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import { checkProducerId } from '../../workflows/workflow-node-config.js';
import type { CanvasNodeRosterEntry, CheckProducerEntry } from './AgentSessionContext.js';

export function canvasNodeRoster(nodes: readonly WorkshopNode[]): CanvasNodeRosterEntry[] {
  return nodes.map((node) => ({
    id: node.id,
    title: node.data.title,
    kind: node.data.kind,
    locked: node.data.locked,
    ...(node.data.adapterId === undefined ? {} : { adapterId: node.data.adapterId }),
  }));
}

export function canvasNodeRosterKey(entries: readonly CanvasNodeRosterEntry[]): string {
  return entries
    .map((entry) =>
      [entry.id, entry.title, entry.kind, String(entry.locked), entry.adapterId ?? ''].join(
        '\u0000',
      ),
    )
    .join('\n');
}

export function canvasCheckProducers(nodes: readonly WorkshopNode[]): CheckProducerEntry[] {
  return nodes
    .filter((node) => node.data.kind === 'test')
    .map((node) => ({
      nodeId: node.id,
      producerId: checkProducerId(node),
      title: node.data.title,
      checkKind: node.data.checkKind ?? 'test',
    }));
}

export function canvasCheckProducersKey(entries: readonly CheckProducerEntry[]): string {
  return entries
    .map((entry) => [entry.nodeId, entry.producerId, entry.title, entry.checkKind].join('\u0000'))
    .join('\n');
}

export function useAgentSessionContextLists(nodes: readonly WorkshopNode[]): {
  readonly nodeRoster: readonly CanvasNodeRosterEntry[];
  readonly checkProducers: readonly CheckProducerEntry[];
} {
  const nodeRosterSource = useMemo(() => canvasNodeRoster(nodes), [nodes]);
  const checkProducersSource = useMemo(() => canvasCheckProducers(nodes), [nodes]);
  return {
    nodeRoster: useKeyedStable(nodeRosterSource, canvasNodeRosterKey(nodeRosterSource)),
    checkProducers: useKeyedStable(
      checkProducersSource,
      canvasCheckProducersKey(checkProducersSource),
    ),
  };
}
import { useMemo } from 'react';

import { useKeyedStable } from '../../../../lib/use-keyed-stable.js';
