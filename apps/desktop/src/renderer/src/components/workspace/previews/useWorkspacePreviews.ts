import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type {
  PreviewEventEnvelope,
  PreviewSessionSnapshot,
} from '../../../../../shared/application/contracts.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { applyPreviewOutput, previewNodeStatus } from '../model/helpers.js';

interface UseWorkspacePreviewsInput {
  projectId: string;
  nodes: WorkshopNode[];
  setNodes: Dispatch<SetStateAction<WorkshopNode[]>>;
  setEvents: Dispatch<SetStateAction<string[]>>;
}

export function useWorkspacePreviews({
  projectId,
  nodes,
  setNodes,
  setEvents,
}: UseWorkspacePreviewsInput) {
  const [sessions, setSessions] = useState<Record<string, PreviewSessionSnapshot | null>>({});
  const sessionsRef = useRef<Record<string, PreviewSessionSnapshot | null>>({});
  const previewNodeIdsRef = useRef<string[]>([]);

  const updateSession = useCallback(
    (nodeId: string, session: PreviewSessionSnapshot | null) => {
      setSessions((items) => ({ ...items, [nodeId]: session }));
      setNodes((items) =>
        items.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, status: previewNodeStatus(session?.status) } }
            : node,
        ),
      );
    },
    [setNodes],
  );

  useEffect(() => {
    return window.forgeboard.previews.onEvent((event: PreviewEventEnvelope) => {
      if (event.kind === 'state') {
        updateSession(event.nodeId, event.session);
        if (['ready', 'failed', 'stopped', 'killed'].includes(event.session.status)) {
          setEvents((items) =>
            [
              `Preview ${event.session.status} for node ${event.nodeId.slice(0, 8)}.`,
              ...items,
            ].slice(0, 80),
          );
        }
        return;
      }
      setSessions((items) => {
        const current = items[event.nodeId];
        if (!current || current.id !== event.sessionId) return items;
        return { ...items, [event.nodeId]: applyPreviewOutput(current, event) };
      });
    });
  }, [setEvents, updateSession]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    previewNodeIdsRef.current = nodes
      .filter((node) => node.data.kind === 'web-preview' || node.data.kind === 'mobile-preview')
      .map((node) => node.id);
  }, [nodes]);

  useEffect(() => {
    return () => {
      const nodeIds = new Set([...previewNodeIdsRef.current, ...Object.keys(sessionsRef.current)]);
      for (const nodeId of nodeIds) {
        void window.forgeboard.previews.stop({ projectId, nodeId });
      }
    };
  }, [projectId]);

  return { sessions, updateSession };
}
