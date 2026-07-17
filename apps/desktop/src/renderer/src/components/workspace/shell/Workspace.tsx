import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  addEdge,
  applyEdgeChanges,
  MarkerType,
  ReactFlowProvider,
  type Connection,
  type EdgeChange,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react';
import { PanelBottomOpen } from 'lucide-react';

import type { CanvasDocument, RunAdapterId } from '../../../../../shared/application/contracts.js';
import {
  CollaborationCommentMetadataSchema,
  type CollaborationCommentMetadata,
  type CollaborationMetadataSnapshot,
} from '../../../../../shared/collaboration/index.js';
import { FileDocumentSchema } from '../../../../../shared/files/contracts.js';
import type { WorkflowExecutionView } from '../../../../../shared/workflow/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import { commandPaletteShortcutLabel, opensCommandPalette } from '../../../lib/keyboard-preset.js';
import {
  NODE_DEFINITIONS,
  NODE_KINDS,
  type NodeKind,
  type WorkshopNode,
} from '../canvas/CanvasNode.js';
import { CommandPalette } from '../../shell/CommandPalette.js';
import {
  createExtensionNodeBinding,
  extensionTemplateKey,
} from '../../extensions/extension-nodes.js';
import { GitReviewDialog } from '../../git-review/GitReviewDialog.js';
import { permissionProfileUnavailableReason } from '../../permissions/permission-profile-ui.js';
import { CheckApprovalDialog } from '../CheckApprovalDialog.js';
import { RunApprovalDialog } from '../runs/RunApprovalDialog.js';
import { WorkspaceActivityDrawer } from '../activity/WorkspaceActivityDrawer.js';
import { WorkspaceCanvas } from '../canvas/WorkspaceCanvas.js';
import { RejectedCommentsNotice } from '../collaboration/comments/RejectedCommentsNotice.js';
import {
  canConnectUnlocked,
  canEditEdge,
  filterLockedEdgeChanges,
  lockedCanvasNodeIds,
  removalProtectedCanvasNodeIds,
} from '../canvas/interactions/lock-protection.js';
import {
  moveSelectedCanvasNodes,
  type CanvasKeyboardMovement,
  type CanvasKeyboardMoveSummary,
} from '../canvas/interactions/keyboard-navigation.js';
import {
  captureSelectedSubgraph,
  instantiateClipboardSelection,
  type CanvasClipboardSelection,
} from '../canvas/interactions/selection-clipboard.js';
import {
  arrangeGroupMembers,
  fitGroupFrameToMembers,
  reconcileGroupMembership,
  type GroupLayout,
} from '../canvas/interactions/groups/group-containment.js';
import { projectGroupDisplay } from '../canvas/interactions/groups/group-display.js';
import {
  fitAutomaticGroupFrames,
  frameIdsClaimingMembers,
  frameIdsWithChangedMembership,
  updateGroupFrameData,
} from '../canvas/interactions/groups/group-workspace-state.js';
import { useCanvasGraphInteractions } from '../canvas/interactions/workspace/useCanvasGraphInteractions.js';
import { WorkspaceCommandBar } from './WorkspaceCommandBar.js';
import { WorkflowDecisionDialog } from '../workflows/WorkflowDecisionDialog.js';
import { WorkspaceInspector } from './WorkspaceInspector.js';
import { WorkspaceNotifications } from './WorkspaceOverlays.js';
import { WorkspaceRail } from './WorkspaceRail.js';
import {
  createEdgeData,
  edgeDataForPersistence,
  type WorkshopEdgeData,
} from '../model/edge-config.js';
import { hydrateNodeData, isRunAdapterId, summarizeRunEvent } from '../model/helpers.js';
import {
  initialWorkshopNodeDimensions,
  workshopNodeForPersistence,
} from '../model/node-persistence.js';
import type {
  CheckCommand,
  EdgeKind,
  ExtensionTemplate,
  Snapshot,
  WorkshopEdge,
  WorkspaceHandle,
  WorkspaceProps,
} from '../model/types.js';
import type { WorkflowDecisionTarget } from '../workflows/workflow-ui-types.js';
import { useAgentRunController } from '../runs/useAgentRunController.js';
import { useCanvasPersistence } from '../canvas/useCanvasPersistence.js';
import { normalizeCanvasViewport } from '../canvas/view-state/viewport.js';
import { useCollaborationCanvas } from '../collaboration/useCollaborationCanvas.js';
import { mergeCollaborationCanvasSnapshot } from '../collaboration/merge-canvas.js';
import { useProjectChecks } from '../useProjectChecks.js';
import { useWorkflowRuns } from '../workflows/useWorkflowRuns.js';
import { useWorkspacePreviews } from '../previews/useWorkspacePreviews.js';
import { initialWorkflowNodeData } from '../workflows/workflow-node-config.js';
import { useDiffReviewNodeController } from '../diff-review/useDiffReviewNodeController.js';
import { useDiffReviewSession } from '../diff-review/useDiffReviewSession.js';
import type { WorkspaceContextDragPayload } from '../context-dnd/contracts.js';
import { linkProjectFileToAgent, removeProjectFileFromAgent } from '../context-dnd/linking.js';
import {
  runnableWorkflowNodeCount,
  workflowSelectionEligibility,
} from '../workflows/workflow-run-eligibility.js';
import { workflowCanvasNodeStatus } from '../workflows/workflow-node-status.js';
import {
  appendLocalComment,
  appendSharedComment,
  localCommentsForNode,
  sharedCanonicalCommentsForNode,
} from '../comments/comment-model.js';

const LOCKED_CONNECTION_ACTIVITY = 'Unlock locked nodes before changing their connections.';

export const Workspace = forwardRef<WorkspaceHandle, WorkspaceProps>(
  function Workspace(props, ref) {
    return (
      <ReactFlowProvider>
        <WorkspaceInner {...props} ref={ref} />
      </ReactFlowProvider>
    );
  },
);

function workflowEdgeColor(
  disposition: WorkflowExecutionView['edges'][number]['disposition'],
): string {
  switch (disposition) {
    case 'satisfied':
      return 'var(--green)';
    case 'waiting':
    case 'waiting-for-approval':
      return 'var(--yellow)';
    case 'blocked':
      return 'var(--red)';
    case 'inactive':
      return 'var(--text-faint)';
  }
}

function workflowDecisionIsCurrent(
  target: WorkflowDecisionTarget,
  execution: WorkflowExecutionView | null,
): boolean {
  if (execution === null || target.request.executionId !== execution.id) return false;
  if (target.kind === 'launch') {
    return execution.approvals.some(
      (request) =>
        request.preparationId === target.request.preparationId &&
        request.approvalFingerprint === target.request.approvalFingerprint,
    );
  }
  if (target.kind === 'human') {
    return execution.humanDecisions.some(
      (request) =>
        request.targetId === target.request.targetId &&
        request.targetType === target.request.targetType &&
        request.targetAttempt === target.request.targetAttempt &&
        request.evidenceFingerprint === target.request.evidenceFingerprint,
    );
  }
  return execution.revisionEscapes.some(
    (request) =>
      request.loopId === target.request.loopId &&
      request.attemptsStarted === target.request.attemptsStarted &&
      request.evidenceFingerprint === target.request.evidenceFingerprint,
  );
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('[contenteditable="true"]') !== null ||
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA'
  );
}

const WorkspaceInner = forwardRef<WorkspaceHandle, WorkspaceProps>(function WorkspaceInner(
  {
    project,
    settings,
    agents,
    extensionDiscovery,
    onClose,
    onProjectUpdated,
    onOpenSettings,
    onError,
  },
  ref,
) {
  const [canvas, setCanvas] = useState<CanvasDocument | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [nodes, setNodes] = useState<WorkshopNode[]>([]);
  const [edges, setEdges] = useState<WorkshopEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [railTab, setRailTab] = useState<'project' | 'nodes'>('project');
  const [activityOpen, setActivityOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [workflowDecision, setWorkflowDecision] = useState<WorkflowDecisionTarget | null>(null);
  const [initializingGit, setInitializingGit] = useState(false);
  const [search, setSearch] = useState('');
  const [instance, setInstance] = useState<ReactFlowInstance<WorkshopNode, WorkshopEdge> | null>(
    null,
  );
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [events, setEvents] = useState<string[]>(['Project health scan completed locally.']);
  const loaded = useRef(false);
  const nodesRef = useRef<WorkshopNode[]>(nodes);
  const edgesRef = useRef<WorkshopEdge[]>(edges);
  const collaborationGraphReadOnlyRef = useRef(false);
  const pendingNodeSelection = useRef<string | null>(null);
  const canvasClipboard = useRef<CanvasClipboardSelection | null>(null);
  const pasteSequence = useRef(0);
  const extensionDiscoveryRef = useRef(extensionDiscovery);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  useEffect(() => {
    loaded.current = false;
    void window.forgeboard.canvas
      .load(project.id)
      .then((result) => {
        const document = unwrap(result);
        setCanvas(document);
        setViewport(normalizeCanvasViewport(document.viewport));
        setNodes(
          document.nodes.map((node) => ({
            id: node.id,
            type: 'workshop' as const,
            position: node.position,
            ...(node.width === undefined ? {} : { width: node.width }),
            ...(node.height === undefined ? {} : { height: node.height }),
            data: hydrateNodeData(node.data, extensionDiscoveryRef.current),
          })),
        );
        setEdges(
          document.edges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
            ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed },
            data: createEdgeData(edge.type, edge.source, edge.data),
            label: edge.type,
          })),
        );
        loaded.current = true;
      })
      .catch((cause: unknown) =>
        onError(cause instanceof Error ? cause.message : 'Could not load the canvas.'),
      );
  }, [onError, project.id]);

  useEffect(() => {
    extensionDiscoveryRef.current = extensionDiscovery;
    setNodes((items) =>
      items.map((node) => ({
        ...node,
        data: hydrateNodeData(node.data, extensionDiscovery),
      })),
    );
  }, [extensionDiscovery]);

  useEffect(() => {
    return window.forgeboard.runs.onEvent((event) => {
      const update = summarizeRunEvent(event);
      setNodes((items) =>
        items.map((node) => {
          if (node.id !== event.nodeId) return node;
          const transcript = update.transcript
            ? `${node.data.transcript ?? ''}${update.transcript}`.slice(-100_000)
            : node.data.transcript;
          return {
            ...node,
            data: {
              ...node.data,
              ...(update.status ? { status: update.status } : {}),
              ...(transcript === undefined ? {} : { transcript }),
              ...(update.transcript ? { transcriptUpdatedAt: new Date().toISOString() } : {}),
              ...(update.summary ? { lastRunSummary: update.summary } : {}),
              ...(update.changedFiles === undefined ? {} : { changedFiles: update.changedFiles }),
            },
          };
        }),
      );
      if (update.activity) {
        setEvents((items) => [update.activity as string, ...items].slice(0, 80));
      }
    });
  }, []);

  const previews = useWorkspacePreviews({
    projectId: project.id,
    nodes,
    setNodes,
    setEvents,
  });

  const pendingCanvas = useMemo<CanvasDocument | null>(() => {
    if (!canvas || !loaded.current) return null;
    return {
      ...canvas,
      nodes: nodes.map(workshopNodeForPersistence),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.sourceHandle === undefined || edge.sourceHandle === null
          ? {}
          : { sourceHandle: edge.sourceHandle }),
        ...(edge.targetHandle === undefined || edge.targetHandle === null
          ? {}
          : { targetHandle: edge.targetHandle }),
        type: edge.data?.edgeType ?? 'context',
        data: edgeDataForPersistence(edge.data),
      })),
      viewport: viewport ?? normalizeCanvasViewport(canvas.viewport),
    };
  }, [canvas, edges, nodes, viewport]);
  const applyCollaborationSnapshot = useCallback(
    (snapshot: CollaborationMetadataSnapshot, context: { readonly initial: boolean }): boolean => {
      if (pendingCanvas === null) return false;
      const merged = mergeCollaborationCanvasSnapshot(pendingCanvas, snapshot, context);
      if (!merged.ok) {
        onError(merged.message);
        return false;
      }
      const nextSelectedNodeId = merged.document.nodes.some((node) => node.id === selectedNodeId)
        ? selectedNodeId
        : null;
      const nextSelectedEdgeId = merged.document.edges.some((edge) => edge.id === selectedEdgeId)
        ? selectedEdgeId
        : null;
      setCanvas(merged.document);
      setViewport(normalizeCanvasViewport(merged.document.viewport));
      setNodes(
        merged.document.nodes.map((node) => ({
          id: node.id,
          type: 'workshop' as const,
          position: node.position,
          ...(node.width === undefined ? {} : { width: node.width }),
          ...(node.height === undefined ? {} : { height: node.height }),
          selected: node.id === nextSelectedNodeId,
          data: hydrateNodeData(node.data, extensionDiscoveryRef.current),
        })),
      );
      setEdges(
        merged.document.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
          ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
          type: 'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed },
          selected: edge.id === nextSelectedEdgeId,
          data: createEdgeData(edge.type, edge.source, edge.data),
          label: edge.type,
        })),
      );
      setSelectedNodeId(nextSelectedNodeId);
      setSelectedEdgeId(nextSelectedEdgeId);
      setPast([]);
      setFuture([]);
      setEvents((items) =>
        items[0] === 'Applied authenticated collaboration metadata.'
          ? items
          : ['Applied authenticated collaboration metadata.', ...items].slice(0, 80),
      );
      return true;
    },
    [onError, pendingCanvas, selectedEdgeId, selectedNodeId],
  );
  const collaborationCanvas = useCollaborationCanvas({
    enabled: settings.collaborationEnabled,
    document: pendingCanvas,
    selectedNodeId,
    onSnapshot: applyCollaborationSnapshot,
    onError,
  });
  collaborationGraphReadOnlyRef.current = collaborationCanvas.graphReadOnly;
  const reportCollaborationReadOnly = useCallback(() => {
    setEvents((items) =>
      items[0] === 'This collaboration role cannot edit the shared graph.'
        ? items
        : ['This collaboration role cannot edit the shared graph.', ...items].slice(0, 80),
    );
  }, []);
  const { saveState, flushCanvas } = useCanvasPersistence({
    projectId: project.id,
    document: pendingCanvas,
    autosaveIntervalMs: settings.autosaveIntervalMs,
    onError,
  });
  const workflows = useWorkflowRuns({
    projectId: project.id,
    canvasId: canvas?.projectId === project.id ? canvas.id : null,
    flushCanvas,
    setEvents,
    onError,
    mutationsAuthorized: !collaborationCanvas.graphReadOnly,
  });
  useImperativeHandle(ref, () => ({ flushCanvas }), [flushCanvas]);

  const closeProject = useCallback(async () => {
    if (await flushCanvas()) onClose();
  }, [flushCanvas, onClose]);

  const initializeGit = useCallback(async () => {
    setInitializingGit(true);
    try {
      const updated = unwrap(await window.forgeboard.projects.initializeGit(project.id));
      if (updated) {
        await onProjectUpdated(updated);
        setEvents((items) =>
          ['Initialized Git without staging existing files.', ...items].slice(0, 30),
        );
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Git could not be initialized.');
    } finally {
      setInitializingGit(false);
    }
  }, [onError, onProjectUpdated, project.id]);

  const recordSnapshot = useCallback(
    (snapshotNodes: WorkshopNode[], snapshotEdges: WorkshopEdge[]) => {
      setPast((items) => [...items.slice(-49), { nodes: snapshotNodes, edges: snapshotEdges }]);
      setFuture([]);
    },
    [],
  );

  const record = useCallback(() => {
    recordSnapshot(nodes, edges);
  }, [edges, nodes, recordSnapshot]);

  const { setNodeCollapsed, beginNodeResize, finishNodeDrag, changeCanvasNodes } =
    useCanvasGraphInteractions({
      nodesRef,
      edgesRef,
      readOnlyRef: collaborationGraphReadOnlyRef,
      setNodes,
      setEvents,
      recordSnapshot,
      reportCollaborationReadOnly,
    });

  const undo = useCallback(() => {
    if (collaborationCanvas.graphReadOnly) {
      reportCollaborationReadOnly();
      return;
    }
    const snapshot = past.at(-1);
    if (!snapshot) return;
    setFuture((items) => [{ nodes, edges }, ...items].slice(0, 50));
    setPast((items) => items.slice(0, -1));
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setEvents((items) => ['Undid the last canvas change.', ...items].slice(0, 30));
  }, [collaborationCanvas.graphReadOnly, edges, nodes, past, reportCollaborationReadOnly]);

  const redo = useCallback(() => {
    if (collaborationCanvas.graphReadOnly) {
      reportCollaborationReadOnly();
      return;
    }
    const snapshot = future[0];
    if (!snapshot) return;
    setPast((items) => [...items, { nodes, edges }].slice(-50));
    setFuture((items) => items.slice(1));
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setEvents((items) => ['Redid a canvas change.', ...items].slice(0, 30));
  }, [collaborationCanvas.graphReadOnly, edges, future, nodes, reportCollaborationReadOnly]);

  const insertClipboardSelection = useCallback(
    (selection: CanvasClipboardSelection, offset: number, activity: string) => {
      if (collaborationCanvas.graphReadOnly) {
        reportCollaborationReadOnly();
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
    [collaborationCanvas.graphReadOnly, record, reportCollaborationReadOnly],
  );

  const copySelected = useCallback(() => {
    const selection = captureSelectedSubgraph(nodes, edges, selectedNodeId);
    if (selection.nodes.length === 0) return;
    canvasClipboard.current = selection;
    pasteSequence.current = 0;
    setEvents((items) =>
      [
        `Copied ${selection.nodes.length} canvas node${selection.nodes.length === 1 ? '' : 's'}.`,
        ...items,
      ].slice(0, 30),
    );
  }, [edges, nodes, selectedNodeId]);

  const pasteClipboard = useCallback(() => {
    if (canvasClipboard.current === null) return;
    pasteSequence.current += 1;
    insertClipboardSelection(
      canvasClipboard.current,
      pasteSequence.current * 32,
      `Pasted ${canvasClipboard.current.nodes.length} canvas node${
        canvasClipboard.current.nodes.length === 1 ? '' : 's'
      }.`,
    );
  }, [insertClipboardSelection]);

  const duplicateSelected = useCallback(() => {
    const selection = captureSelectedSubgraph(nodes, edges, selectedNodeId);
    insertClipboardSelection(
      selection,
      32,
      `Duplicated ${selection.nodes.length} canvas node${selection.nodes.length === 1 ? '' : 's'}.`,
    );
  }, [edges, insertClipboardSelection, nodes, selectedNodeId]);

  const moveSelectedByKeyboard = useCallback(
    (
      movement: CanvasKeyboardMovement,
      recordUndoCheckpoint: boolean,
    ): CanvasKeyboardMoveSummary => {
      if (collaborationCanvas.graphReadOnly) {
        reportCollaborationReadOnly();
        const selectedNodeIds = nodes
          .filter((node) => node.selected === true)
          .map((node) => node.id);
        return {
          selectedNodeIds,
          movedNodeIds: [],
          lockedNodeIds: selectedNodeIds,
        };
      }
      const currentNodes = nodesRef.current;
      const result = moveSelectedCanvasNodes(currentNodes, movement);
      if (result.movedNodeIds.length > 0) {
        if (recordUndoCheckpoint) recordSnapshot(currentNodes, edgesRef.current);
        const movedNodeIds = new Set(result.movedNodeIds);
        const affectedFrameIds = [
          ...frameIdsClaimingMembers(currentNodes, result.movedNodeIds),
          ...currentNodes
            .filter((node) => node.data.kind === 'group-frame' && movedNodeIds.has(node.id))
            .map((node) => node.id),
        ];
        const nextNodes = fitAutomaticGroupFrames(result.nodes, affectedFrameIds);
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        if (recordUndoCheckpoint) {
          setEvents((items) =>
            [
              `Moved ${result.movedNodeIds.length} canvas node${
                result.movedNodeIds.length === 1 ? '' : 's'
              } with the keyboard.`,
              ...items,
            ].slice(0, 30),
          );
        }
      }
      return {
        selectedNodeIds: result.selectedNodeIds,
        movedNodeIds: result.movedNodeIds,
        lockedNodeIds: result.lockedNodeIds,
      };
    },
    [collaborationCanvas.graphReadOnly, recordSnapshot, reportCollaborationReadOnly],
  );

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (opensCommandPalette(event, settings.keyboardPreset)) {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (isTextEntryTarget(event.target)) {
        if (event.key === 'Escape') setPaletteOpen(false);
        return;
      }
      if (command && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelected();
        return;
      }
      if (command && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteClipboard();
        return;
      }
      if (command && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (command && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      }
      if (
        command &&
        ((event.key.toLowerCase() === 'z' && event.shiftKey) || event.key.toLowerCase() === 'y')
      ) {
        event.preventDefault();
        redo();
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [copySelected, duplicateSelected, pasteClipboard, redo, settings.keyboardPreset, undo]);

  const addNode = useCallback(
    (kind: NodeKind, position?: { x: number; y: number }) => {
      if (collaborationCanvas.graphReadOnly) {
        reportCollaborationReadOnly();
        return;
      }
      record();
      const definition = NODE_DEFINITIONS[kind];
      const id = crypto.randomUUID();
      const offset = nodes.length * 24;
      pendingNodeSelection.current = id;
      setNodes((items) => [
        ...items.map((node) => ({ ...node, selected: false })),
        {
          id,
          type: 'workshop',
          selected: true,
          position: position ?? { x: 220 + offset, y: 150 + offset },
          ...initialWorkshopNodeDimensions(kind),
          data: {
            kind,
            title: definition.label,
            description: definition.description,
            status: 'idle',
            locked: false,
            collapsed: false,
            color: definition.color,
            ...initialWorkflowNodeData(kind, id, settings),
            ...(kind === 'group-frame'
              ? {
                  purpose: 'custom' as const,
                  layout: 'freeform' as const,
                  autoFit: false,
                  childNodeIds: [],
                }
              : {}),
          },
        },
      ]);
      setSelectedNodeId(id);
      window.setTimeout(() => {
        if (pendingNodeSelection.current === id) pendingNodeSelection.current = null;
      }, 250);
      setEvents((items) => [`Added ${definition.label} node.`, ...items].slice(0, 30));
    },
    [
      collaborationCanvas.graphReadOnly,
      nodes.length,
      record,
      reportCollaborationReadOnly,
      settings,
    ],
  );

  const addExtensionNode = useCallback(
    (template: ExtensionTemplate, position?: { x: number; y: number }) => {
      if (collaborationCanvas.graphReadOnly) {
        reportCollaborationReadOnly();
        return;
      }
      record();
      const { extension, definition } = template;
      const binding = createExtensionNodeBinding(extension, definition);
      const id = crypto.randomUUID();
      const offset = nodes.length * 24;
      pendingNodeSelection.current = id;
      setNodes((items) => [
        ...items.map((node) => ({ ...node, selected: false })),
        {
          id,
          type: 'workshop',
          selected: true,
          position: position ?? { x: 220 + offset, y: 150 + offset },
          ...initialWorkshopNodeDimensions('extension'),
          data: {
            kind: 'extension',
            title: definition.displayName,
            description: definition.description,
            status: 'idle',
            locked: false,
            collapsed: false,
            color: definition.color,
            extensionId: binding.extensionId,
            extensionVersion: binding.extensionVersion,
            extensionNodeTypeId: binding.nodeTypeId,
            extensionDefinition: binding.definition,
            extensionValues: binding.values,
            extensionAvailability: binding.availability,
          },
        },
      ]);
      setSelectedNodeId(id);
      window.setTimeout(() => {
        if (pendingNodeSelection.current === id) pendingNodeSelection.current = null;
      }, 250);
      setEvents((items) =>
        [`Added ${definition.displayName} extension node.`, ...items].slice(0, 30),
      );
    },
    [collaborationCanvas.graphReadOnly, nodes.length, record, reportCollaborationReadOnly],
  );

  const attachProjectFileContext = useCallback(
    async (targetNodeId: string, payload: WorkspaceContextDragPayload): Promise<void> => {
      if (collaborationGraphReadOnlyRef.current) {
        reportCollaborationReadOnly();
        throw new Error('This collaboration role cannot edit the shared graph.');
      }
      const target = nodesRef.current.find((node) => node.id === targetNodeId);
      if (target === undefined || target.data.kind !== 'agent') {
        throw new Error('Project files can only be attached to an Agent node.');
      }
      if (lockedCanvasNodeIds(nodesRef.current).has(targetNodeId)) {
        throw new Error('Unlock the Agent node or its group before changing its context.');
      }
      if (payload.projectId !== project.id) {
        throw new Error('The dragged file belongs to another project.');
      }
      const document = FileDocumentSchema.parse(
        await window.forgeboard.files.read({
          projectId: payload.projectId,
          relativePath: payload.relativePath,
        }),
      );
      if (collaborationGraphReadOnlyRef.current) {
        reportCollaborationReadOnly();
        throw new Error('This collaboration role cannot edit the shared graph.');
      }
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      if (lockedCanvasNodeIds(currentNodes).has(targetNodeId)) {
        throw new Error('Unlock the Agent node or its group before changing its context.');
      }
      const result = linkProjectFileToAgent({
        projectId: project.id,
        targetNodeId,
        payload,
        document,
        nodes: currentNodes,
        newNodeId: crypto.randomUUID(),
      });
      if (!result.ok) throw new Error(result.message);
      if (!result.changed) {
        setEvents((items) => ['That project file is already attached.', ...items].slice(0, 30));
        return;
      }
      recordSnapshot(currentNodes, currentEdges);
      nodesRef.current = result.nodes;
      setNodes(result.nodes);
      setEvents((items) =>
        [
          `${result.createdFileNode ? 'Created a File node and attached' : 'Attached'} verified project file context.`,
          ...items,
        ].slice(0, 30),
      );
    },
    [project.id, recordSnapshot, reportCollaborationReadOnly],
  );

  const removeProjectFileContext = useCallback(
    (targetNodeId: string, attachmentNodeId: string): void => {
      if (collaborationGraphReadOnlyRef.current) {
        reportCollaborationReadOnly();
        return;
      }
      const currentNodes = nodesRef.current;
      if (lockedCanvasNodeIds(currentNodes).has(targetNodeId)) {
        setEvents((items) =>
          ['Unlock the Agent node or its group before changing its context.', ...items].slice(
            0,
            30,
          ),
        );
        return;
      }
      const result = removeProjectFileFromAgent({
        targetNodeId,
        attachmentNodeId,
        nodes: currentNodes,
      });
      if (!result.ok) {
        onError(result.message);
        return;
      }
      if (!result.changed) return;
      recordSnapshot(currentNodes, edgesRef.current);
      nodesRef.current = result.nodes;
      setNodes(result.nodes);
      setEvents((items) => ['Removed a project file from Agent context.', ...items].slice(0, 30));
    },
    [onError, recordSnapshot, reportCollaborationReadOnly],
  );

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const workflowRevisionFingerprint = useMemo(
    () =>
      workflows.executions
        .map((execution) => `${execution.id}:${String(execution.revision)}`)
        .sort()
        .join('|'),
    [workflows.executions],
  );
  const diffReview = useDiffReviewNodeController({
    project,
    nodes,
    agents,
    selectedNode,
    workflowRevisionFingerprint,
    onError,
  });
  const sharedComments = useMemo(
    () => collaborationCommentsForNode(pendingCanvas, selectedNodeId),
    [pendingCanvas, selectedNodeId],
  );
  const localComments = useMemo(
    () => localCommentsForNode(pendingCanvas, selectedNodeId),
    [pendingCanvas, selectedNodeId],
  );
  const rejectedSharedCommentEntries = useMemo(
    () =>
      selectedNodeId === null
        ? []
        : collaborationCanvas.rejectedCommentEntries.filter(
            (entry) => entry.comment.nodeId === selectedNodeId,
          ),
    [collaborationCanvas.rejectedCommentEntries, selectedNodeId],
  );
  const createSharedComment = useCallback(
    async (body: string): Promise<boolean> => {
      if (selectedNodeId === null) return false;
      const comment = await collaborationCanvas.createComment(selectedNodeId, body);
      if (comment === null) return false;
      setCanvas((current) => appendSharedComment(current, selectedNodeId, comment));
      setEvents((items) => ['Shared a collaboration comment.', ...items].slice(0, 80));
      return true;
    },
    [collaborationCanvas.createComment, selectedNodeId],
  );
  const createLocalComment = useCallback(
    (body: string): boolean => {
      if (pendingCanvas === null || selectedNodeId === null || body.trim() === '') return false;
      const next = appendLocalComment(pendingCanvas, selectedNodeId, body, {
        id: `local:${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
      });
      if (next === null || next === pendingCanvas) return false;
      setCanvas(next);
      setEvents((items) => ['Saved a private local comment.', ...items].slice(0, 80));
      return true;
    },
    [pendingCanvas, selectedNodeId],
  );
  const selectedCanvasNodes = nodes.filter((node) => node.selected === true);
  const selectedWorkflowEligibility = workflowSelectionEligibility(
    selectedCanvasNodes.length > 0
      ? selectedCanvasNodes
      : selectedNode === null
        ? []
        : [selectedNode],
    nodes,
    edges,
  );
  const selectedWorkflowScope = selectedWorkflowEligibility.scope;
  const canRunWorkflow = runnableWorkflowNodeCount(nodes, edges) > 0;
  const runnableAgents = agents.filter(
    (agent): agent is typeof agent & { id: RunAdapterId } =>
      agent.installed && isRunAdapterId(agent.id),
  );
  const selectedAdapter = selectedNode
    ? (selectedNode.data.adapterId ??
      (isRunAdapterId(settings.defaultAgent) ? settings.defaultAgent : 'test-agent'))
    : 'test-agent';
  const configuredPermission =
    selectedNode?.data.permissionProfile ?? settings.defaultPermissionProfile;
  const selectedPermission = configuredPermission;
  const selectedPermissionUnavailableReason =
    selectedNode === null
      ? null
      : permissionProfileUnavailableReason(selectedPermission, settings, selectedAdapter);

  const updateNodeData = useCallback((nodeId: string, data: Partial<WorkshopNode['data']>) => {
    setNodes((items) => {
      const nextNodes = items.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node,
      );
      nodesRef.current = nextNodes;
      return nextNodes;
    });
  }, []);
  const readCurrentGraph = useCallback(
    () => ({ nodes: nodesRef.current, edges: edgesRef.current }),
    [],
  );
  const replaceCurrentNodes = useCallback((nextNodes: WorkshopNode[]) => {
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
  }, []);
  const gitReview = useDiffReviewSession({
    projectId: project.id,
    nodes,
    collaborationGraphReadOnly: collaborationCanvas.graphReadOnly,
    readGraph: readCurrentGraph,
    recordSnapshot,
    replaceNodes: replaceCurrentNodes,
    refreshAgentRuns: diffReview.refreshAgentRuns,
    refreshSummary: diffReview.refreshSummary,
  });
  const openProjectGitReview = useCallback(
    () => gitReview.openTarget({ kind: 'primary', projectId: project.id }),
    [gitReview.openTarget, project.id],
  );
  const runs = useAgentRunController({
    project,
    selectedNode,
    selectedAdapter,
    selectedPermission,
    permissionUnavailableReason: selectedPermissionUnavailableReason,
    flushCanvas,
    updateNodeData,
    setEvents,
    onError,
  });
  const checks = useProjectChecks({
    projectId: project.id,
    setEvents,
    onError,
  });
  const workflowNodeTitles = useMemo(
    () => new Map(nodes.map((node) => [node.id, node.data.title] as const)),
    [nodes],
  );
  const workflowInteractiveNodeIds = useMemo(
    () =>
      new Set(
        nodes
          .filter((node) => node.data.kind === 'agent' || node.data.kind === 'task')
          .map((node) => node.id),
      ),
    [nodes],
  );
  const workflowNodeStatuses = useMemo(
    () =>
      new Map(
        (workflows.currentExecution?.nodeRuns ?? []).map(
          (run) => [run.nodeId, workflowCanvasNodeStatus(run.status)] as const,
        ),
      ),
    [workflows.currentExecution],
  );
  const protectedNodeIds = useMemo(() => lockedCanvasNodeIds(nodes), [nodes]);
  const removalProtectedNodeIds = useMemo(
    () => removalProtectedCanvasNodeIds(nodes, edges),
    [edges, nodes],
  );
  const selectedNodeLockedByGroup =
    selectedNode !== null && protectedNodeIds.has(selectedNode.id) && !selectedNode.data.locked;
  const inspectorSelectedNode = selectedNodeLockedByGroup
    ? { ...selectedNode, data: { ...selectedNode.data, locked: true } }
    : selectedNode;
  const runtimeDisplayedNodes = useMemo(
    () =>
      nodes.map((node) => {
        const status = workflowNodeStatuses.get(node.id);
        const inheritedLock = protectedNodeIds.has(node.id) && !node.data.locked;
        const displayed =
          status === undefined && !inheritedLock
            ? node
            : {
                ...node,
                data: {
                  ...node.data,
                  ...(status === undefined ? {} : { status }),
                  ...(inheritedLock ? { locked: true } : {}),
                },
              };
        const mutable = !protectedNodeIds.has(node.id);
        return {
          ...displayed,
          ariaLabel: `${node.data.title}, ${NODE_DEFINITIONS[node.data.kind].label} node${
            protectedNodeIds.has(node.id) ? ', locked' : ''
          }`,
          connectable: mutable,
          deletable: mutable,
          draggable: mutable,
        };
      }),
    [nodes, protectedNodeIds, workflowNodeStatuses],
  );
  const workflowEdgeStates = useMemo(
    () => new Map((workflows.currentExecution?.edges ?? []).map((edge) => [edge.edgeId, edge])),
    [workflows.currentExecution],
  );
  const runtimeDisplayedEdges = useMemo(
    () =>
      edges.map((edge) => {
        const runtime = workflowEdgeStates.get(edge.id);
        if (runtime === undefined) return edge;
        return {
          ...edge,
          animated: runtime.disposition === 'waiting' || runtime.status === 'running',
          className: `${edge.className ?? ''} workflow-edge-runtime ${runtime.status}`.trim(),
          label: `${edge.data?.edgeType ?? runtime.type} · ${runtime.status.replaceAll('-', ' ')} · ${runtime.disposition.replaceAll('-', ' ')}`,
          style: {
            ...edge.style,
            stroke: workflowEdgeColor(runtime.disposition),
            strokeWidth: runtime.disposition === 'inactive' ? 1 : 2,
            opacity: runtime.disposition === 'inactive' ? 0.45 : 1,
          },
        };
      }),
    [edges, workflowEdgeStates],
  );
  const displayedGraph = useMemo(
    () => projectGroupDisplay(runtimeDisplayedNodes, runtimeDisplayedEdges),
    [runtimeDisplayedEdges, runtimeDisplayedNodes],
  );
  const workflowActive = workflows.activeExecution !== null;
  const workflowStartBusy =
    !workflows.mutationsAuthorized ||
    workflows.busyAction !== null ||
    workflowActive ||
    canvas === null ||
    nodes.length === 0;

  useEffect(() => {
    if (workflowDecision === null) return;
    if (
      !workflows.mutationsAuthorized ||
      !workflowDecisionIsCurrent(workflowDecision, workflows.currentExecution)
    ) {
      setWorkflowDecision(null);
    }
  }, [workflowDecision, workflows.currentExecution, workflows.mutationsAuthorized]);

  const workflowDecisionCount =
    (workflows.currentExecution?.approvals.length ?? 0) +
    (workflows.currentExecution?.humanDecisions.length ?? 0) +
    (workflows.currentExecution?.revisionEscapes.length ?? 0);
  useEffect(() => {
    if (workflowDecisionCount > 0) setActivityOpen(true);
  }, [workflowDecisionCount]);

  const extensionTemplates = useMemo<ExtensionTemplate[]>(
    () =>
      extensionDiscovery.installed.flatMap((extension) =>
        extension.manifest.contributes.canvasNodeTypes.map((definition) => ({
          extension,
          definition,
          key: extensionTemplateKey(extension.manifest.id, definition.id),
        })),
      ),
    [extensionDiscovery.installed],
  );
  const searchTerm = search.toLowerCase();
  const filteredTemplates = NODE_KINDS.filter((kind) =>
    NODE_DEFINITIONS[kind].label.toLowerCase().includes(searchTerm),
  );
  const filteredExtensionTemplates = extensionTemplates.filter(({ extension, definition }) =>
    `${definition.displayName} ${definition.description} ${extension.manifest.name}`
      .toLowerCase()
      .includes(searchTerm),
  );
  const filteredNodes = nodes.filter((node) =>
    `${node.data.title} ${NODE_DEFINITIONS[node.data.kind].label}`
      .toLowerCase()
      .includes(searchTerm),
  );
  const changeReports = nodes.flatMap((node) => {
    const files = node.data.changedFiles ?? [];
    return files.length
      ? [
          {
            nodeId: node.id,
            nodeKind: node.data.kind,
            title: node.data.title,
            status: node.data.status,
            files,
            runId: node.data.runId ?? null,
            runPermissionProfile: node.data.lastRunPermissionProfile ?? null,
          },
        ]
      : [];
  });
  const checkCommands: CheckCommand[] = [
    {
      id: 'lint',
      label: 'Lint',
      command: settings.lintCommand,
      detectedScript: project.health.scripts.lint,
    },
    {
      id: 'typecheck',
      label: 'Typecheck',
      command: settings.typecheckCommand,
      detectedScript: project.health.scripts.typecheck,
    },
    {
      id: 'test',
      label: 'Tests',
      command: settings.testCommand,
      detectedScript: project.health.scripts.test,
    },
    {
      id: 'build',
      label: 'Build',
      command: settings.buildCommand,
      detectedScript: project.health.scripts.build,
    },
    ...(settings.customChecks ?? []).map((check) => ({
      id: check.id,
      label: check.label,
      command: check.command,
      detectedScript: undefined,
    })),
  ];

  function updateSelected(data: Partial<WorkshopNode['data']>) {
    if (collaborationCanvas.graphReadOnly) {
      reportCollaborationReadOnly();
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
      replaceCurrentNodes(nextNodes);
      return;
    }
    updateNodeData(selectedNode.id, data);
  }

  function fitSelectedGroupFrame() {
    if (collaborationCanvas.graphReadOnly) {
      reportCollaborationReadOnly();
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
    replaceCurrentNodes(result.nodes);
    setEvents((items) =>
      [`Fitted ${currentFrame.data.title} to its members.`, ...items].slice(0, 30),
    );
  }

  function arrangeSelectedGroupFrame(layout: GroupLayout) {
    if (collaborationCanvas.graphReadOnly) {
      reportCollaborationReadOnly();
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
    const nextNodes = fitResult?.nodes ?? result.nodes;
    if (result.disposition !== 'arranged' && fitResult?.disposition !== 'fitted') return;
    recordSnapshot(currentNodes, edgesRef.current);
    replaceCurrentNodes(nextNodes);
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

  function deleteSelected() {
    if (collaborationCanvas.graphReadOnly) {
      reportCollaborationReadOnly();
      return;
    }
    if (!selectedNode) return;
    if (removalProtectedCanvasNodeIds(nodesRef.current, edgesRef.current).has(selectedNode.id)) {
      setEvents((items) =>
        [
          `Unlock ${selectedNode.data.title}, its protected members, or connected locked nodes before deleting it.`,
          ...items,
        ].slice(0, 30),
      );
      return;
    }
    if (selectedNode.data.kind === 'web-preview' || selectedNode.data.kind === 'mobile-preview') {
      void window.forgeboard.previews.stop({
        projectId: project.id,
        nodeId: selectedNode.id,
      });
    }
    record();
    const affectedFrameIds = frameIdsClaimingMembers(nodesRef.current, [selectedNode.id]);
    const nextNodes = fitAutomaticGroupFrames(
      reconcileGroupMembership(nodesRef.current.filter((node) => node.id !== selectedNode.id))
        .nodes,
      affectedFrameIds,
    );
    const nextEdges = edgesRef.current.filter(
      (edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id,
    );
    replaceCurrentNodes(nextNodes);
    edgesRef.current = nextEdges;
    setEdges(nextEdges);
    setSelectedNodeId(null);
    setEvents((items) => [`Deleted ${selectedNode.data.title}.`, ...items].slice(0, 30));
  }

  function updateEdgeType(edgeType: EdgeKind) {
    if (collaborationCanvas.graphReadOnly) {
      reportCollaborationReadOnly();
      return;
    }
    if (!selectedEdge) return;
    if (!canEditEdge(selectedEdge, nodes)) {
      setEvents((items) =>
        items[0] === LOCKED_CONNECTION_ACTIVITY
          ? items
          : [LOCKED_CONNECTION_ACTIVITY, ...items].slice(0, 30),
      );
      return;
    }
    record();
    setEdges((items) =>
      items.map((edge) =>
        edge.id === selectedEdge.id
          ? {
              ...edge,
              label: edgeType,
              data: createEdgeData(edgeType, edge.source, edge.data),
            }
          : edge,
      ),
    );
  }

  function updateEdgeData(data: WorkshopEdgeData) {
    if (collaborationCanvas.graphReadOnly) {
      reportCollaborationReadOnly();
      return;
    }
    if (!selectedEdge) return;
    if (!canEditEdge(selectedEdge, nodes)) {
      setEvents((items) =>
        items[0] === LOCKED_CONNECTION_ACTIVITY
          ? items
          : [LOCKED_CONNECTION_ACTIVITY, ...items].slice(0, 30),
      );
      return;
    }
    record();
    setEdges((items) =>
      items.map((edge) =>
        edge.id === selectedEdge.id ? { ...edge, label: data.edgeType, data } : edge,
      ),
    );
  }

  const paletteActions = useMemo(
    () => [
      {
        id: 'add-agent',
        label: 'Add agent node',
        section: 'Canvas',
        run: () => addNode('agent'),
      },
      {
        id: 'add-task',
        label: 'Add task node',
        section: 'Canvas',
        run: () => addNode('task'),
      },
      {
        id: 'add-brief',
        label: 'Add product brief',
        section: 'Canvas',
        run: () => addNode('brief'),
      },
      ...extensionTemplates.map((template) => ({
        id: `add-extension-${template.key}`,
        label: `Add ${template.definition.displayName}`,
        section: `Extension · ${template.extension.manifest.name}`,
        run: () => addExtensionNode(template),
      })),
      {
        id: 'fit',
        label: 'Fit canvas to content',
        section: 'View',
        shortcut: 'F',
        run: () =>
          void instance?.fitView({
            padding: 0.18,
            duration: settings.reducedMotion ? 0 : 240,
          }),
      },
      ...(canRunWorkflow && workflows.mutationsAuthorized
        ? [
            {
              id: 'run-workflow',
              label: 'Run saved canvas workflow',
              section: 'Workflow',
              run: () => {
                if (!workflowStartBusy) void workflows.start({ kind: 'workflow' });
              },
            },
          ]
        : []),
      ...(selectedNode === null ||
      selectedWorkflowScope === undefined ||
      !workflows.mutationsAuthorized
        ? []
        : [
            {
              id: 'run-selected-workflow-node',
              label: `Run ${selectedNode.data.title} with dependencies`,
              section: 'Workflow',
              run: () => {
                if (!workflowStartBusy) {
                  void workflows.start(selectedWorkflowScope);
                }
              },
            },
          ]),
      {
        id: 'git-review',
        label: 'Review Git changes',
        section: 'Project',
        run: openProjectGitReview,
      },
      {
        id: 'settings',
        label: 'Open settings',
        section: 'Application',
        shortcut: '⌘,',
        run: onOpenSettings,
      },
      {
        id: 'close',
        label: 'Close project',
        section: 'Project',
        run: () => void closeProject(),
      },
    ],
    [
      addExtensionNode,
      addNode,
      canRunWorkflow,
      closeProject,
      extensionTemplates,
      instance,
      onOpenSettings,
      openProjectGitReview,
      project.id,
      selectedNode,
      selectedWorkflowScope,
      settings.reducedMotion,
      workflowStartBusy,
      workflows,
    ],
  );

  return (
    <main className="workspace-shell">
      <WorkspaceCommandBar
        project={project}
        canvasName={canvas?.name}
        agents={agents}
        saveState={saveState}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        notificationsOpen={notificationsOpen}
        workflowStatus={
          workflows.activeExecution?.status ?? workflows.currentExecution?.status ?? null
        }
        workflowBusy={workflowStartBusy}
        canRunWorkflow={canRunWorkflow && workflows.mutationsAuthorized}
        canRunSelected={selectedWorkflowEligibility.runnable && workflows.mutationsAuthorized}
        runSelectedReason={
          workflows.mutationsAuthorized
            ? selectedWorkflowEligibility.reason
            : 'This collaboration role can inspect workflow history but cannot start execution.'
        }
        commandPaletteShortcut={commandPaletteShortcutLabel(settings.keyboardPreset)}
        onCloseProject={() => void closeProject()}
        onUndo={undo}
        onRedo={redo}
        onFitCanvas={() =>
          void instance?.fitView({
            padding: 0.18,
            duration: settings.reducedMotion ? 0 : 240,
          })
        }
        onRunWorkflow={() => void workflows.start({ kind: 'workflow' })}
        onRunSelected={() => {
          if (selectedWorkflowScope === undefined) return;
          void workflows.start(selectedWorkflowScope);
        }}
        onOpenGitReview={openProjectGitReview}
        onOpenCommands={() => setPaletteOpen(true)}
        onToggleNotifications={() => setNotificationsOpen((open) => !open)}
        onOpenSettings={onOpenSettings}
      />

      <RejectedCommentsNotice
        entries={collaborationCanvas.rejectedCommentEntries}
        onDiscard={collaborationCanvas.discardRejectedComment}
      />

      <div className={`workspace-grid ${activityOpen ? '' : 'activity-closed'}`}>
        <WorkspaceRail
          project={project}
          tab={railTab}
          search={search}
          templates={filteredTemplates}
          extensionTemplates={filteredExtensionTemplates}
          nodes={railTab === 'nodes' ? filteredNodes : nodes}
          fileOperations={window.forgeboard.files}
          initializingGit={initializingGit}
          collaborationGraphReadOnly={collaborationCanvas.graphReadOnly}
          onTabChange={setRailTab}
          onSearchChange={setSearch}
          onAddNode={addNode}
          onAddExtensionNode={addExtensionNode}
          onInitializeGit={() => void initializeGit()}
          onAttachAgentContext={attachProjectFileContext}
          onSelectNode={(node) => {
            setSelectedNodeId(node.id);
            setSelectedEdgeId(null);
            setNodes((items) =>
              items.map((item) => ({
                ...item,
                selected: item.id === node.id,
              })),
            );
            setEdges((items) => items.map((edge) => ({ ...edge, selected: false })));
            void instance?.setCenter(node.position.x, node.position.y, {
              zoom: 1.15,
              duration: settings.reducedMotion ? 0 : 220,
            });
          }}
        />
        <WorkspaceCanvas
          canvas={canvas}
          nodes={displayedGraph.nodes}
          edges={displayedGraph.edges}
          settings={settings}
          extensionTemplates={extensionTemplates}
          instance={instance}
          onInstance={setInstance}
          onViewportChange={setViewport}
          onNodesChange={changeCanvasNodes}
          onEdgesChange={(changes: EdgeChange<WorkshopEdge>[]) => {
            if (collaborationCanvas.graphReadOnly) {
              const safeChanges = changes.filter((change) => change.type === 'select');
              setEdges((items) => applyEdgeChanges(safeChanges, items));
              if (safeChanges.length !== changes.length) reportCollaborationReadOnly();
              return;
            }
            const allowedChanges = filterLockedEdgeChanges(changes, edges, nodes);
            const blockedRemoval = changes.some(
              (change) => change.type === 'remove' && !allowedChanges.includes(change),
            );
            if (allowedChanges.some((change) => change.type === 'remove')) record();
            if (blockedRemoval) {
              setEvents((items) =>
                items[0] === LOCKED_CONNECTION_ACTIVITY
                  ? items
                  : [LOCKED_CONNECTION_ACTIVITY, ...items].slice(0, 30),
              );
            }
            setEdges((items) =>
              applyEdgeChanges(filterLockedEdgeChanges(changes, items, nodes), items),
            );
          }}
          onConnect={(connection: Connection) => {
            if (collaborationCanvas.graphReadOnly) {
              reportCollaborationReadOnly();
              return;
            }
            if (!canConnectUnlocked(connection, nodes)) {
              setEvents((items) =>
                ['Unlock both nodes before changing their connections.', ...items].slice(0, 30),
              );
              return;
            }
            record();
            setEdges((items) =>
              addEdge(
                {
                  ...connection,
                  id: crypto.randomUUID(),
                  type: 'smoothstep',
                  markerEnd: { type: MarkerType.ArrowClosed },
                  data: createEdgeData('context', connection.source),
                  label: 'context',
                },
                items,
              ),
            );
            setEvents((items) => ['Connected nodes with a context edge.', ...items].slice(0, 30));
          }}
          onNodeDragStart={record}
          onNodeDragStop={finishNodeDrag}
          onSetNodeCollapsed={setNodeCollapsed}
          onNodeResizeStart={beginNodeResize}
          onKeyboardMove={moveSelectedByKeyboard}
          onSelectionChange={({
            nodes: selectedNodes,
            edges: selectedEdges,
          }: OnSelectionChangeParams<WorkshopNode, WorkshopEdge>) => {
            const nextSelectedNode = selectedNodes[0];
            if (nextSelectedNode) {
              pendingNodeSelection.current = null;
              setSelectedNodeId(nextSelectedNode.id);
              setSelectedEdgeId(null);
              return;
            }
            if (pendingNodeSelection.current) {
              setSelectedNodeId(pendingNodeSelection.current);
              setSelectedEdgeId(null);
              return;
            }
            setSelectedNodeId(null);
            setSelectedEdgeId(selectedEdges[0]?.id ?? null);
          }}
          onAddNode={addNode}
          onAddExtensionNode={addExtensionNode}
          collaborationAwareness={collaborationCanvas.awareness}
          onCollaborationCursorMove={collaborationCanvas.updateCursor}
          onCollaborationCursorLeave={collaborationCanvas.clearCursor}
          collaborationGraphReadOnly={collaborationCanvas.graphReadOnly}
          onAttachAgentContext={attachProjectFileContext}
          onContextDropError={onError}
        />
        <WorkspaceInspector
          project={project}
          settings={settings}
          canvas={canvas}
          nodes={nodes}
          selectedNode={inspectorSelectedNode}
          selectedNodeLockedByGroup={selectedNodeLockedByGroup}
          selectedNodeDeletionProtected={
            selectedNode !== null && removalProtectedNodeIds.has(selectedNode.id)
          }
          selectedEdge={selectedEdge}
          runnableAgents={runnableAgents}
          selectedAdapter={selectedAdapter}
          selectedPermission={selectedPermission}
          previewSession={selectedNode ? (previews.sessions[selectedNode.id] ?? null) : null}
          runInput={runs.runInput}
          agentRunActive={runs.selectedRunActive}
          preparingRun={runs.preparingRun}
          sharedComments={sharedComments}
          localComments={localComments}
          rejectedSharedCommentEntries={rejectedSharedCommentEntries}
          canComment={collaborationCanvas.canComment}
          onCreateComment={createSharedComment}
          onCreateLocalComment={createLocalComment}
          onDiscardRejectedComment={collaborationCanvas.discardRejectedComment}
          onClearSelection={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
            setNodes((items) => items.map((node) => ({ ...node, selected: false })));
            setEdges((items) => items.map((edge) => ({ ...edge, selected: false })));
          }}
          onRecord={record}
          onUpdateSelected={updateSelected}
          onFitGroupFrame={fitSelectedGroupFrame}
          onArrangeGroupFrame={arrangeSelectedGroupFrame}
          onUpdateEdgeType={updateEdgeType}
          onUpdateEdgeData={updateEdgeData}
          onDuplicateSelected={duplicateSelected}
          onDeleteSelected={deleteSelected}
          onRunInputChange={runs.setRunInput}
          onSendRunInput={() => void runs.sendRunInput()}
          onControlRun={(action) => void runs.controlRun(action)}
          onPrepareRun={() => {
            if (selectedPermissionUnavailableReason !== null) {
              onError(selectedPermissionUnavailableReason);
              return;
            }
            void runs.prepareSelectedRun();
          }}
          onPreviewSession={(session) => {
            if (selectedNode) previews.updateSession(selectedNode.id, session);
          }}
          onTerminalSessionStatus={(nodeId, status) => updateNodeData(nodeId, { status })}
          testNodeRuntime={{
            executions: workflows.executions,
            interactionEvents: workflows.interactionEvents,
            busyAction: workflows.busyAction,
            mutationsAuthorized: workflows.mutationsAuthorized,
            onStart: (nodeId) =>
              void workflows.start({ kind: 'node', nodeId, includeUpstream: false }),
            onCancel: (input) => void workflows.cancelNode(input),
            onRevealArtifact: async (input) => {
              unwrap(await window.forgeboard.workflows.revealArtifact(input));
            },
            onOpenArtifact: async (input) => {
              unwrap(await window.forgeboard.workflows.openArtifact(input));
            },
          }}
          diffReview={diffReview}
          onOpenDiffReview={(request) => {
            if (selectedNode?.data.kind !== 'diff') return;
            gitReview.openNodeReview(selectedNode.id, selectedNode.data.reviewTarget, request);
          }}
          onOpenGitPrReadiness={(runId) =>
            gitReview.openTarget({
              kind: 'agent-worktree',
              projectId: project.id,
              runId,
            })
          }
          collaborationGraphReadOnly={collaborationCanvas.graphReadOnly}
          onAttachAgentContext={attachProjectFileContext}
          onRemoveAgentContext={removeProjectFileContext}
          onOpenSettings={onOpenSettings}
          onError={onError}
        />
        <WorkspaceActivityDrawer
          events={events}
          changeReports={changeReports}
          checkCommands={checkCommands}
          latestChecks={checks.latestByCheckId}
          busyCheckId={checks.busyCheckId}
          workflowExecutions={workflows.executions}
          currentWorkflow={workflows.currentExecution}
          workflowNodeTitles={workflowNodeTitles}
          workflowInteractiveNodeIds={workflowInteractiveNodeIds}
          workflowInteractionEvents={workflows.interactionEvents}
          workflowLoading={workflows.loading}
          workflowBusyAction={workflows.busyAction}
          workflowMutationsAuthorized={workflows.mutationsAuthorized}
          onPrepareCheck={(checkId) => void checks.prepare(checkId)}
          onCancelCheck={(executionId) => void checks.cancel(executionId)}
          onSelectWorkflow={workflows.selectExecution}
          onRefreshWorkflows={() => void workflows.refresh()}
          onCancelWorkflow={(executionId) => void workflows.cancel(executionId)}
          onReviewWorkflowDecision={setWorkflowDecision}
          onSendWorkflowInput={workflows.sendInput}
          onInterruptWorkflowNode={workflows.interrupt}
          onOpenSettings={onOpenSettings}
          onOpenGitReview={(runId) =>
            gitReview.openTarget(
              runId === undefined
                ? { kind: 'primary', projectId: project.id }
                : { kind: 'agent-worktree', projectId: project.id, runId },
            )
          }
          onClose={() => setActivityOpen(false)}
        />
      </div>

      {!activityOpen && (
        <button className="open-activity" type="button" onClick={() => setActivityOpen(true)}>
          <PanelBottomOpen size={15} /> Activity
        </button>
      )}
      {paletteOpen && (
        <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />
      )}
      {notificationsOpen && (
        <WorkspaceNotifications events={events} onClose={() => setNotificationsOpen(false)} />
      )}
      {gitReview.session !== null && (
        <GitReviewDialog
          target={gitReview.session.target}
          projectName={project.name}
          cleanupRecovery={gitReview.session.cleanupRecovery}
          {...(gitReview.session.source === null
            ? {}
            : { displayPreferences: gitReview.session.source.preferences })}
          {...(gitReview.canPersistPreferences
            ? { onDisplayPreferencesChange: gitReview.persistPreferences }
            : {})}
          onClose={gitReview.close}
          onError={onError}
          onCleanupSuccess={(message) => {
            gitReview.refreshCleanupState();
            setEvents((items) => [message, ...items].slice(0, 80));
          }}
          onCleanupTargetReactivated={(reactivatedTarget, message) => {
            gitReview.reactivateCleanupTarget(reactivatedTarget);
            setEvents((items) => [message, ...items].slice(0, 80));
          }}
          onCleanupStateUncertain={gitReview.refreshCleanupState}
        />
      )}
      {workflowDecision !== null && (
        <WorkflowDecisionDialog
          target={workflowDecision}
          busy={workflows.busyAction !== null}
          onClose={() => setWorkflowDecision(null)}
          onApproveLaunch={(request) => {
            void workflows.approveNode(request).then(() => setWorkflowDecision(null));
          }}
          onApproveHuman={(request) => {
            void workflows.approveHuman(request).then(() => setWorkflowDecision(null));
          }}
          onDecideReview={(request, decision, feedback) => {
            void workflows
              .decideReview(request, decision, feedback)
              .then(() => setWorkflowDecision(null));
          }}
          onResolveRevision={(request, decision) => {
            void workflows
              .resolveRevisionEscape(request, decision)
              .then(() => setWorkflowDecision(null));
          }}
          onReviewChanges={(runId) => {
            gitReview.openTarget({
              kind: 'agent-worktree',
              projectId: project.id,
              runId,
            });
            setWorkflowDecision(null);
          }}
        />
      )}
      {runs.disclosure && (
        <RunApprovalDialog
          disclosure={runs.disclosure}
          prompt={runs.reviewedPrompt ?? ''}
          busy={runs.approvingRun}
          onCancel={() => void runs.cancelPreparedRun()}
          onApprove={() => void runs.approvePreparedRun()}
        />
      )}
      {checks.plan && (
        <CheckApprovalDialog
          plan={checks.plan}
          busy={checks.approving}
          onCancel={checks.dismissPlan}
          onContinue={() => void checks.confirm()}
        />
      )}
    </main>
  );
});

function collaborationCommentsForNode(
  document: CanvasDocument | null,
  nodeId: string | null,
): CollaborationCommentMetadata[] {
  if (document === null || nodeId === null) return [];
  return sharedCanonicalCommentsForNode(document, nodeId).flatMap((comment) => {
    const parsed = CollaborationCommentMetadataSchema.safeParse({
      id: comment.id,
      nodeId,
      authorId: comment.authorId,
      body: comment.body,
      createdAt: comment.createdAt,
      ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
      ...(comment.resolvedAt === undefined ? {} : { resolved: true }),
    });
    return parsed.success ? [parsed.data] : [];
  });
}
