import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { applyNodeChanges, type NodeChange } from '@xyflow/react';

import type { WorkshopNode } from '../../CanvasNode.js';
import type { WorkshopEdge } from '../../../model/types.js';
import { setCanvasNodeCollapsed } from '../CanvasNodeInteractionContext.js';
import { filterLockedNodeChanges, lockedCanvasNodeIds } from '../lock-protection.js';
import {
  applyGroupAwareNodeChanges,
  finalizeDraggedGroupMembership,
} from '../groups/group-workspace-state.js';
import { terminateRemovedNodeSessions } from '../../../terminal/terminate-node-sessions.js';

const LOCKED_CONNECTION_ACTIVITY = 'Unlock locked nodes before changing them.';

export interface UseCanvasGraphInteractionsOptions {
  readonly projectId: string;
  readonly nodesRef: RefObject<WorkshopNode[]>;
  readonly edgesRef: RefObject<WorkshopEdge[]>;
  readonly readOnlyRef: RefObject<boolean>;
  readonly setNodes: Dispatch<SetStateAction<WorkshopNode[]>>;
  readonly setEvents: Dispatch<SetStateAction<string[]>>;
  readonly recordSnapshot: (nodes: WorkshopNode[], edges: WorkshopEdge[]) => void;
  readonly reportCollaborationReadOnly: () => void;
}

export interface CanvasGraphInteractionCallbacks {
  readonly setNodeCollapsed: (nodeId: string, collapsed: boolean) => void;
  readonly beginNodeResize: (nodeId: string) => void;
  readonly finishNodeDrag: (node: WorkshopNode, draggedNodes: readonly WorkshopNode[]) => void;
  readonly changeCanvasNodes: (changes: NodeChange<WorkshopNode>[]) => void;
}

export function useCanvasGraphInteractions({
  projectId,
  nodesRef,
  edgesRef,
  readOnlyRef,
  setNodes,
  setEvents,
  recordSnapshot,
  reportCollaborationReadOnly,
}: UseCanvasGraphInteractionsOptions): CanvasGraphInteractionCallbacks {
  const setNodeCollapsed = useCallback(
    (nodeId: string, collapsed: boolean) => {
      if (readOnlyRef.current) {
        reportCollaborationReadOnly();
        return;
      }
      const currentNodes = nodesRef.current;
      if (lockedCanvasNodeIds(currentNodes).has(nodeId)) {
        setEvents((items) =>
          ['Unlock the node or its group before collapsing it.', ...items].slice(0, 30),
        );
        return;
      }
      const nextNodes = setCanvasNodeCollapsed(currentNodes, nodeId, collapsed, false);
      if (nextNodes === currentNodes) return;
      recordSnapshot(currentNodes, edgesRef.current);
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      setEvents((items) =>
        [
          `${collapsed ? 'Collapsed' : 'Expanded'} ${currentNodes.find(({ id }) => id === nodeId)?.data.title ?? 'canvas node'}.`,
          ...items,
        ].slice(0, 30),
      );
    },
    [
      edgesRef,
      nodesRef,
      readOnlyRef,
      recordSnapshot,
      reportCollaborationReadOnly,
      setEvents,
      setNodes,
    ],
  );

  const beginNodeResize = useCallback(
    (nodeId: string) => {
      if (readOnlyRef.current) {
        reportCollaborationReadOnly();
        return;
      }
      const currentNodes = nodesRef.current;
      if (lockedCanvasNodeIds(currentNodes).has(nodeId)) return;
      recordSnapshot(currentNodes, edgesRef.current);
    },
    [edgesRef, nodesRef, readOnlyRef, recordSnapshot, reportCollaborationReadOnly],
  );

  const finishNodeDrag = useCallback(
    (node: WorkshopNode, draggedNodes: readonly WorkshopNode[]) => {
      if (readOnlyRef.current) {
        reportCollaborationReadOnly();
        return;
      }
      const activeNodes = draggedNodes.length > 0 ? draggedNodes : [node];
      const result = finalizeDraggedGroupMembership(nodesRef.current, activeNodes);
      nodesRef.current = result.nodes;
      setNodes(result.nodes);
      if (result.changedFrameIds.length > 0) {
        setEvents((items) => ["Updated the group's placement and size.", ...items].slice(0, 30));
      }
    },
    [nodesRef, readOnlyRef, reportCollaborationReadOnly, setEvents, setNodes],
  );

  const changeCanvasNodes = useCallback(
    (changes: NodeChange<WorkshopNode>[]) => {
      const currentNodes = nodesRef.current;
      if (readOnlyRef.current) {
        const safeChanges = changes.filter(
          (change) =>
            change.type === 'select' ||
            (change.type === 'dimensions' && change.resizing !== true && !change.setAttributes),
        );
        const nextNodes = applyNodeChanges(safeChanges, currentNodes);
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        if (safeChanges.length !== changes.length) reportCollaborationReadOnly();
        return;
      }
      const currentEdges = edgesRef.current;
      const allowedChanges = filterLockedNodeChanges(changes, currentNodes, currentEdges);
      const blockedMutation = changes.some(
        (change) =>
          !allowedChanges.includes(change) &&
          change.type !== 'select' &&
          !(change.type === 'dimensions' && change.resizing !== true),
      );
      if (allowedChanges.some((change) => change.type === 'remove')) {
        recordSnapshot(currentNodes, currentEdges);
      }
      if (blockedMutation) {
        setEvents((items) =>
          items[0] === LOCKED_CONNECTION_ACTIVITY
            ? items
            : [LOCKED_CONNECTION_ACTIVITY, ...items].slice(0, 30),
        );
      }
      const nextNodes = applyGroupAwareNodeChanges(currentNodes, allowedChanges);
      const remainingIds = new Set(nextNodes.map((candidate) => candidate.id));
      terminateRemovedNodeSessions(
        window.forgeboard.terminal,
        projectId,
        currentNodes
          .filter((candidate) => !remainingIds.has(candidate.id))
          .map((candidate) => ({ id: candidate.id, kind: candidate.data.kind })),
      );
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
    },
    [
      edgesRef,
      nodesRef,
      projectId,
      readOnlyRef,
      recordSnapshot,
      reportCollaborationReadOnly,
      setEvents,
      setNodes,
    ],
  );

  return { setNodeCollapsed, beginNodeResize, finishNodeDrag, changeCanvasNodes };
}
