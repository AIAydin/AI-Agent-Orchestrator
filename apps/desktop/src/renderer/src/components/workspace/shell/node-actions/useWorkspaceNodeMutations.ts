import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import {
  lockedCanvasNodeIds,
  removalProtectedCanvasNodeIds,
} from '../../canvas/interactions/lock-protection.js';
import {
  arrangeGroupMembers,
  fitGroupFrameToMembers,
  type GroupLayout,
} from '../../canvas/interactions/groups/group-containment.js';
import {
  fitAutomaticGroupFrames,
  frameIdsWithChangedMembership,
  updateGroupFrameData,
} from '../../canvas/interactions/groups/group-workspace-state.js';
import { removeContextNode } from '../../canvas/context-menu/graph-actions.js';
import type { WorkshopEdge } from '../../model/types.js';

interface WorkspaceNodeMutationOptions {
  readonly projectId: string;
  readonly graphReadOnly: boolean;
  readonly selectedNode: WorkshopNode | null;
  readonly nodesRef: MutableRefObject<WorkshopNode[]>;
  readonly edgesRef: MutableRefObject<WorkshopEdge[]>;
  readonly reportReadOnly: () => void;
  readonly recordSnapshot: (nodes: WorkshopNode[], edges: WorkshopEdge[]) => void;
  readonly updateNodeData: (nodeId: string, data: Partial<WorkshopNode['data']>) => void;
  readonly replaceNodes: (nodes: WorkshopNode[]) => void;
  readonly setEdges: Dispatch<SetStateAction<WorkshopEdge[]>>;
  readonly setSelectedNodeId: Dispatch<SetStateAction<string | null>>;
  readonly setEvents: Dispatch<SetStateAction<string[]>>;
}

export function useWorkspaceNodeMutations(options: WorkspaceNodeMutationOptions) {
  const {
    projectId,
    graphReadOnly,
    selectedNode,
    nodesRef,
    edgesRef,
    reportReadOnly,
    recordSnapshot,
    updateNodeData,
    replaceNodes,
    setEdges,
    setSelectedNodeId,
    setEvents,
  } = options;

  function updateSelected(data: Partial<WorkshopNode['data']>) {
    if (graphReadOnly) {
      reportReadOnly();
      return;
    }
    if (!selectedNode) return;
    const keys = Object.keys(data);
    const unlocksSelectedNode =
      selectedNode.data.locked &&
      keys.length === 1 &&
      keys[0] === 'locked' &&
      data.locked === false;
    if (lockedCanvasNodeIds(nodesRef.current).has(selectedNode.id) && !unlocksSelectedNode) {
      setEvents((items) =>
        ['Unlock the node or its group before editing it.', ...items].slice(0, 30),
      );
      return;
    }
    if (selectedNode.data.kind === 'group-frame') {
      const currentNodes = nodesRef.current;
      const update = updateGroupFrameData(currentNodes, selectedNode.id, data);
      let nextNodes = update.nodes;
      if (update.blockedChildIds.length > 0) {
        setEvents((items) =>
          [
            `Unlock ${update.blockedChildIds.length} protected member${update.blockedChildIds.length === 1 ? '' : 's'} before changing group ownership.`,
            ...items,
          ].slice(0, 30),
        );
      }
      const membershipChangedFrameIds = frameIdsWithChangedMembership(currentNodes, nextNodes);
      nextNodes = fitAutomaticGroupFrames(nextNodes, [
        ...membershipChangedFrameIds,
        ...(data.autoFit === true ? [selectedNode.id] : []),
      ]);
      replaceNodes(nextNodes);
      return;
    }
    updateNodeData(selectedNode.id, data);
  }

  function fitSelectedGroupFrame() {
    if (graphReadOnly) {
      reportReadOnly();
      return;
    }
    if (selectedNode?.data.kind !== 'group-frame') return;
    const currentNodes = nodesRef.current;
    const currentFrame = currentNodes.find(({ id }) => id === selectedNode.id);
    if (currentFrame?.data.kind !== 'group-frame') return;
    if (lockedCanvasNodeIds(currentNodes).has(currentFrame.id)) {
      setEvents((items) =>
        [`Unlock ${currentFrame.data.title} before fitting it.`, ...items].slice(0, 30),
      );
      return;
    }
    const result = fitGroupFrameToMembers(currentNodes, currentFrame.id);
    if (result.disposition !== 'fitted') return;
    recordSnapshot(currentNodes, edgesRef.current);
    replaceNodes(fitAutomaticGroupFrames(result.nodes, [currentFrame.id]));
    setEvents((items) =>
      [`Fitted ${currentFrame.data.title} to its members.`, ...items].slice(0, 30),
    );
  }

  function arrangeSelectedGroupFrame(layout: GroupLayout) {
    if (graphReadOnly) {
      reportReadOnly();
      return;
    }
    if (selectedNode?.data.kind !== 'group-frame') return;
    const currentNodes = nodesRef.current;
    const currentFrame = currentNodes.find(({ id }) => id === selectedNode.id);
    if (currentFrame?.data.kind !== 'group-frame') return;
    if (lockedCanvasNodeIds(currentNodes).has(currentFrame.id)) {
      setEvents((items) =>
        [`Unlock ${currentFrame.data.title} before arranging its members.`, ...items].slice(0, 30),
      );
      return;
    }
    const result = arrangeGroupMembers(currentNodes, currentFrame.id, layout);
    if (result.disposition === 'rejected') return;
    const fitResult = currentFrame.data.autoFit
      ? fitGroupFrameToMembers(result.nodes, currentFrame.id)
      : null;
    const nextNodes = fitAutomaticGroupFrames(fitResult?.nodes ?? result.nodes, [currentFrame.id]);
    if (result.disposition !== 'arranged' && fitResult?.disposition !== 'fitted') return;
    recordSnapshot(currentNodes, edgesRef.current);
    replaceNodes(nextNodes);
    if (result.disposition === 'arranged') {
      setEvents((items) =>
        [
          `Arranged ${result.movedMemberIds.length} member${result.movedMemberIds.length === 1 ? '' : 's'} in ${currentFrame.data.title}.`,
          ...items,
        ].slice(0, 30),
      );
    } else {
      setEvents((items) =>
        [`Fitted ${currentFrame.data.title} to its arranged members.`, ...items].slice(0, 30),
      );
    }
  }

  function setNodeLocked(nodeId: string, locked: boolean) {
    if (graphReadOnly) {
      reportReadOnly();
      return;
    }
    const currentNodes = nodesRef.current;
    const node = currentNodes.find(({ id }) => id === nodeId);
    if (node === undefined || node.data.locked === locked) return;
    if (lockedCanvasNodeIds(currentNodes).has(nodeId) && !node.data.locked) {
      setEvents((items) =>
        ['Unlock the containing group frame before changing this node lock.', ...items].slice(
          0,
          30,
        ),
      );
      return;
    }
    recordSnapshot(currentNodes, edgesRef.current);
    updateNodeData(nodeId, { locked });
    setEvents((items) =>
      [`${locked ? 'Locked' : 'Unlocked'} ${node.data.title}.`, ...items].slice(0, 30),
    );
  }

  function deleteNode(nodeId: string) {
    if (graphReadOnly) {
      reportReadOnly();
      return;
    }
    const currentNodes = nodesRef.current;
    const node = currentNodes.find(({ id }) => id === nodeId);
    if (node === undefined) return;
    if (removalProtectedCanvasNodeIds(currentNodes, edgesRef.current).has(node.id)) {
      setEvents((items) =>
        [
          `Unlock ${node.data.title}, its protected members, or connected locked nodes before deleting it.`,
          ...items,
        ].slice(0, 30),
      );
      return;
    }
    if (node.data.kind === 'web-preview' || node.data.kind === 'mobile-preview') {
      void window.forgeboard.previews.stop({ projectId, nodeId: node.id });
    }
    recordSnapshot(currentNodes, edgesRef.current);
    const nextGraph = removeContextNode(currentNodes, edgesRef.current, node.id);
    replaceNodes(nextGraph.nodes);
    edgesRef.current = nextGraph.edges;
    setEdges(nextGraph.edges);
    setSelectedNodeId((selected) => (selected === node.id ? null : selected));
    setEvents((items) => [`Deleted ${node.data.title}.`, ...items].slice(0, 30));
  }

  function deleteSelected() {
    if (selectedNode !== null) deleteNode(selectedNode.id);
  }

  return {
    arrangeSelectedGroupFrame,
    deleteNode,
    deleteSelected,
    fitSelectedGroupFrame,
    setNodeLocked,
    updateSelected,
  };
}
