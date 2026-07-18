import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import type { WorkshopNode } from '../CanvasNode.js';
import {
  captureSelectedSubgraph,
  instantiateClipboardSelection,
  type CanvasClipboardSelection,
} from '../interactions/selection-clipboard.js';
import type { WorkshopEdge } from '../../model/types.js';
import { contextNodeSelection } from './graph-actions.js';

interface CanvasClipboardActionOptions {
  readonly graphReadOnly: boolean;
  readonly nodes: WorkshopNode[];
  readonly edges: WorkshopEdge[];
  readonly selectedNodeId: string | null;
  readonly pendingNodeSelection: MutableRefObject<string | null>;
  readonly record: () => void;
  readonly reportReadOnly: () => void;
  readonly setNodes: Dispatch<SetStateAction<WorkshopNode[]>>;
  readonly setEdges: Dispatch<SetStateAction<WorkshopEdge[]>>;
  readonly setSelectedNodeId: Dispatch<SetStateAction<string | null>>;
  readonly setSelectedEdgeId: Dispatch<SetStateAction<string | null>>;
  readonly setEvents: Dispatch<SetStateAction<string[]>>;
}

export function useCanvasClipboardActions(options: CanvasClipboardActionOptions) {
  const {
    graphReadOnly,
    nodes,
    edges,
    selectedNodeId,
    pendingNodeSelection,
    record,
    reportReadOnly,
    setNodes,
    setEdges,
    setSelectedNodeId,
    setSelectedEdgeId,
    setEvents,
  } = options;
  const clipboard = useRef<CanvasClipboardSelection | null>(null);
  const pasteSequence = useRef(0);

  const insertSelection = useCallback(
    (selection: CanvasClipboardSelection, offset: number, activity: string) => {
      if (graphReadOnly) {
        reportReadOnly();
        return;
      }
      if (selection.nodes.length === 0) return;
      record();
      const duplicate = instantiateClipboardSelection(selection, {
        createId: () => crypto.randomUUID(),
        offset,
      });
      const firstNodeId = duplicate.nodes[0]?.id ?? null;
      pendingNodeSelection.current = firstNodeId;
      setNodes((items) => [
        ...items.map((node) => ({ ...node, selected: false })),
        ...duplicate.nodes,
      ]);
      setEdges((items) => [
        ...items.map((edge) => ({ ...edge, selected: false })),
        ...duplicate.edges,
      ]);
      setSelectedNodeId(firstNodeId);
      setSelectedEdgeId(null);
      if (firstNodeId !== null) {
        window.setTimeout(() => {
          if (pendingNodeSelection.current === firstNodeId) pendingNodeSelection.current = null;
        }, 250);
      }
      setEvents((items) => [activity, ...items].slice(0, 30));
    },
    [
      graphReadOnly,
      pendingNodeSelection,
      record,
      reportReadOnly,
      setEdges,
      setEvents,
      setNodes,
      setSelectedEdgeId,
      setSelectedNodeId,
    ],
  );

  const copySelected = useCallback(() => {
    const selection = captureSelectedSubgraph(nodes, edges, selectedNodeId);
    if (selection.nodes.length === 0) return;
    clipboard.current = selection;
    pasteSequence.current = 0;
    setEvents((items) =>
      [
        `Copied ${selection.nodes.length} canvas node${selection.nodes.length === 1 ? '' : 's'}.`,
        ...items,
      ].slice(0, 30),
    );
  }, [edges, nodes, selectedNodeId, setEvents]);

  const pasteClipboard = useCallback(() => {
    if (clipboard.current === null) return;
    pasteSequence.current += 1;
    insertSelection(
      clipboard.current,
      pasteSequence.current * 32,
      `Pasted ${clipboard.current.nodes.length} canvas node${clipboard.current.nodes.length === 1 ? '' : 's'}.`,
    );
  }, [insertSelection]);

  const duplicateNode = useCallback(
    (nodeId: string) => {
      const selection = contextNodeSelection(nodes, edges, nodeId);
      insertSelection(
        selection,
        32,
        `Duplicated ${selection.nodes.length} canvas node${selection.nodes.length === 1 ? '' : 's'}.`,
      );
    },
    [edges, insertSelection, nodes],
  );

  const duplicateSelected = useCallback(() => {
    const selection = captureSelectedSubgraph(nodes, edges, selectedNodeId);
    insertSelection(
      selection,
      32,
      `Duplicated ${selection.nodes.length} canvas node${selection.nodes.length === 1 ? '' : 's'}.`,
    );
  }, [edges, insertSelection, nodes, selectedNodeId]);

  return { copySelected, duplicateNode, duplicateSelected, pasteClipboard };
}
