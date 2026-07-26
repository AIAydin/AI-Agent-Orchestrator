import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { addEdge, MarkerType, type Connection } from '@xyflow/react';

import { unwrap } from '../../../../lib/ipc.js';
import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import {
  canConnectUnlocked,
  lockedCanvasNodeIds,
} from '../../canvas/interactions/lock-protection.js';
import { createEdgeData } from '../../model/edge-config.js';
import type { WorkshopEdge } from '../../model/types.js';
import { applyNodeDataPatch } from '../node-data/node-data-patch.js';
import { matchParameterizedVoiceIntent } from '../../voice/parameterized-intents.js';

interface UseWorkspaceContextActionsInput {
  readonly nodesRef: RefObject<WorkshopNode[]>;
  readonly edgesRef: RefObject<WorkshopEdge[]>;
  readonly collaborationGraphReadOnlyRef: RefObject<boolean>;
  readonly onError: (message: string) => void;
  readonly reportCollaborationReadOnly: () => void;
  readonly recordSnapshot: (nodes: WorkshopNode[], edges: WorkshopEdge[]) => void;
  readonly setNodes: Dispatch<SetStateAction<WorkshopNode[]>>;
  readonly setEdges: Dispatch<SetStateAction<WorkshopEdge[]>>;
  readonly setSelectedNodeId: Dispatch<SetStateAction<string | null>>;
  readonly setSelectedEdgeId: Dispatch<SetStateAction<string | null>>;
  readonly setEvents: Dispatch<SetStateAction<string[]>>;
}

export function useWorkspaceContextActions({
  nodesRef,
  edgesRef,
  collaborationGraphReadOnlyRef,
  onError,
  reportCollaborationReadOnly,
  recordSnapshot,
  setNodes,
  setEdges,
  setSelectedNodeId,
  setSelectedEdgeId,
  setEvents,
}: UseWorkspaceContextActionsInput) {
  const attachWhiteboardContext = useCallback(
    (sourceNodeId: string, targetNodeId: string): string => {
      if (collaborationGraphReadOnlyRef.current) {
        reportCollaborationReadOnly();
        return 'Your collaboration role cannot change Context connections.';
      }
      const currentNodes = nodesRef.current;
      const source = currentNodes.find((node) => node.id === sourceNodeId);
      const target = currentNodes.find((node) => node.id === targetNodeId);
      if (source?.data.kind !== 'whiteboard' || target?.data.kind !== 'agent') {
        return 'The whiteboard or Agent node is no longer available.';
      }
      const protectedIds = lockedCanvasNodeIds(currentNodes);
      if (protectedIds.has(sourceNodeId) || protectedIds.has(targetNodeId)) {
        return 'Unlock the whiteboard, its group, and the Agent before attaching context.';
      }
      const existing = edgesRef.current.some(
        (edge) =>
          edge.source === sourceNodeId &&
          edge.target === targetNodeId &&
          edge.data?.edgeType === 'context' &&
          edge.data.config.attachmentIds.includes(sourceNodeId),
      );
      if (existing) {
        return `The whiteboard specification is already attached to ${target.data.title}.`;
      }
      recordSnapshot(currentNodes, edgesRef.current);
      const nextEdge: WorkshopEdge = {
        id: crypto.randomUUID(),
        source: sourceNodeId,
        target: targetNodeId,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: createEdgeData('context', sourceNodeId),
        label: 'context',
      };
      setEdges((items) => addEdge(nextEdge, items));
      setEvents((items) =>
        [
          `Attached ${source.data.title} to ${target.data.title} as explicit Context.`,
          ...items,
        ].slice(0, 30),
      );
      return `Attached the exact whiteboard specification to ${target.data.title}.`;
    },
    [
      collaborationGraphReadOnlyRef,
      edgesRef,
      nodesRef,
      recordSnapshot,
      reportCollaborationReadOnly,
      setEdges,
      setEvents,
    ],
  );

  const promptAgentFromVoice = useCallback(
    (nodeId: string, prompt: string) => {
      const target = nodesRef.current.find((node) => node.id === nodeId);
      if (target?.data.kind !== 'agent') {
        onError('That Agent node is no longer available.');
        return;
      }
      if (
        collaborationGraphReadOnlyRef.current ||
        lockedCanvasNodeIds(nodesRef.current).has(nodeId)
      ) {
        onError('Unlock the Agent and ensure the canvas is editable before prompting it.');
        return;
      }
      if (
        target.data.runId !== undefined &&
        (target.data.status === 'running' || target.data.status === 'paused')
      ) {
        void window.forgeboard.runs
          .sendInput(target.data.runId, `${prompt}\n`)
          .then(unwrap)
          .then(() => {
            setEvents((items) =>
              [`Sent a voice prompt to ${target.data.title}.`, ...items].slice(0, 30),
            );
          })
          .catch((cause: unknown) => {
            onError(cause instanceof Error ? cause.message : 'Could not prompt the running Agent.');
          });
        return;
      }
      recordSnapshot(nodesRef.current, edgesRef.current);
      const nextNodes = nodesRef.current.map((node) => ({
        ...node,
        selected: node.id === nodeId,
        data: node.id === nodeId ? applyNodeDataPatch(node.data, { prompt }) : node.data,
      }));
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      setSelectedNodeId(nodeId);
      setSelectedEdgeId(null);
      setEvents((items) =>
        [
          `Set ${target.data.title}'s prompt by voice. Review the run before starting it.`,
          ...items,
        ].slice(0, 30),
      );
    },
    [
      collaborationGraphReadOnlyRef,
      edgesRef,
      nodesRef,
      onError,
      recordSnapshot,
      setEvents,
      setNodes,
      setSelectedEdgeId,
      setSelectedNodeId,
    ],
  );

  const connectNodesFromVoice = useCallback(
    (sourceNodeId: string, targetNodeId: string) => {
      const currentNodes = nodesRef.current;
      const source = currentNodes.find((node) => node.id === sourceNodeId);
      const target = currentNodes.find((node) => node.id === targetNodeId);
      if (source === undefined || target === undefined) {
        onError('One of those canvas nodes is no longer available.');
        return;
      }
      if (collaborationGraphReadOnlyRef.current) {
        reportCollaborationReadOnly();
        return;
      }
      const connection: Connection = {
        source: sourceNodeId,
        target: targetNodeId,
        sourceHandle: null,
        targetHandle: null,
      };
      if (!canConnectUnlocked(connection, currentNodes)) {
        onError('Unlock both nodes before connecting them.');
        return;
      }
      if (source.data.kind === 'text' || target.data.kind === 'text') {
        onError('Text nodes are annotations and cannot be connected.');
        return;
      }
      const alreadyConnected = edgesRef.current.some(
        (edge) =>
          edge.data?.edgeType === 'context' &&
          ((edge.source === sourceNodeId && edge.target === targetNodeId) ||
            (edge.source === targetNodeId && edge.target === sourceNodeId)),
      );
      if (alreadyConnected) {
        setEvents((items) =>
          [`${source.data.title} and ${target.data.title} are already connected.`, ...items].slice(
            0,
            30,
          ),
        );
        return;
      }
      recordSnapshot(currentNodes, edgesRef.current);
      const nextEdges = addEdge(
        {
          ...connection,
          id: crypto.randomUUID(),
          type: 'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: createEdgeData('context', sourceNodeId),
          label: 'context',
        },
        edgesRef.current,
      );
      edgesRef.current = nextEdges;
      setEdges(nextEdges);
      setEvents((items) =>
        [`Connected ${source.data.title} to ${target.data.title} by voice.`, ...items].slice(0, 30),
      );
    },
    [
      collaborationGraphReadOnlyRef,
      edgesRef,
      nodesRef,
      onError,
      recordSnapshot,
      reportCollaborationReadOnly,
      setEdges,
      setEvents,
    ],
  );

  const resolveParameterizedVoiceAction = useCallback(
    (transcript: string) =>
      matchParameterizedVoiceIntent({
        transcript,
        nodes: nodesRef.current,
        promptAgent: promptAgentFromVoice,
        connectNodes: connectNodesFromVoice,
      }),
    [connectNodesFromVoice, nodesRef, promptAgentFromVoice],
  );

  return { attachWhiteboardContext, resolveParameterizedVoiceAction };
}
