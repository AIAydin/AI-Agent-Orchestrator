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
import { emptyCanvasHistory } from '../../../../../shared/canvas/history/contracts.js';
import {
  CollaborationCommentMetadataSchema,
  type CollaborationCommentMetadata,
  type CollaborationMetadataSnapshot,
} from '../../../../../shared/collaboration/index.js';
import { FileDocumentSchema } from '../../../../../shared/files/contracts.js';
import type { WorkflowExecutionView } from '../../../../../shared/workflow/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import { useKeyedStable } from '../../../lib/use-keyed-stable.js';
import { commandPaletteShortcutLabel, opensCommandPalette } from '../../../lib/keyboard-preset.js';
import {
  NODE_DEFINITIONS,
  NODE_KINDS,
  type NodeKind,
  type WorkshopNode,
  type WorkshopNodeData,
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
import { inheritedContextLockIds } from '../canvas/context-menu/graph-actions.js';
import { useCanvasClipboardActions } from '../canvas/context-menu/useCanvasClipboardActions.js';
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
import { projectGroupDisplay } from '../canvas/interactions/groups/group-display.js';
import {
  fitAutomaticGroupFrames,
  frameIdsClaimingMembers,
} from '../canvas/interactions/groups/group-workspace-state.js';
import { useCanvasGraphInteractions } from '../canvas/interactions/workspace/useCanvasGraphInteractions.js';
import { WorkspaceCommandBar } from './WorkspaceCommandBar.js';
import { useProjectStatus } from './status/useProjectStatus.js';
import { applyNodeDataPatch } from './node-data-patch.js';
import { WorkflowDecisionDialog } from '../workflows/WorkflowDecisionDialog.js';
import { WorkspaceInspector } from './WorkspaceInspector.js';
import { WorkspaceRail } from './WorkspaceRail.js';
import { WorkspaceResizeHandle } from './WorkspaceResizeHandle.js';
import { useWorkspaceSidebarLayout } from './useWorkspaceSidebarLayout.js';
import { nodeRegistryFromTemplates } from '../node-registry/NodeRegistryContext.js';
import { providerTheme } from '../node-registry/provider-themes.js';
import { useWorkspaceNodeMutations } from './node-actions/useWorkspaceNodeMutations.js';
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
  WorkshopEdge,
  WorkspaceHandle,
  WorkspaceProps,
} from '../model/types.js';
import type { WorkflowDecisionTarget } from '../workflows/workflow-ui-types.js';
import { useAgentProviderGate } from '../runs/useAgentProviderGate.js';
import { useAgentRunController } from '../runs/useAgentRunController.js';
import { useAgentStatusReconciliation } from '../runs/useAgentStatusReconciliation.js';
import { useAgentWorktreeRecord } from '../runs/useAgentWorktreeAvailability.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
  type CanvasImageNodeEntry,
  type CanvasNodeRosterEntry,
  type CheckProducerEntry,
} from '../runs/agent-session/AgentSessionContext.js';
import { AGENT_NODE_DRAG_HANDLE } from '../runs/agent-session/AgentSessionNode.js';
import { providerConnectionIdForAdapter } from '../../../lib/provider-connections.js';
import { effectiveNodeModel } from '../runs/agent-node/model-selection.js';
import { useCanvasPersistence } from '../canvas/useCanvasPersistence.js';
import { useDurableCanvasHistory } from '../canvas/history/useDurableCanvasHistory.js';
import { durableHistoryState, hydrateHistorySnapshot } from '../canvas/history/serialization.js';
import { normalizeCanvasViewport } from '../canvas/view-state/viewport.js';
import { useCollaborationCanvas } from '../collaboration/useCollaborationCanvas.js';
import { mergeCollaborationCanvasSnapshot } from '../collaboration/merge-canvas.js';
import { useProjectChecks } from '../useProjectChecks.js';
import { useWorkflowRuns } from '../workflows/useWorkflowRuns.js';
import { useWorkspacePreviews } from '../previews/useWorkspacePreviews.js';
import { checkProducerId, initialWorkflowNodeData } from '../workflows/workflow-node-config.js';
import { buildWorkflowTemplate } from '../workflows/templates/builder.js';
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from '../workflows/templates/catalog.js';
import { collisionFreeTemplateOrigin } from '../workflows/templates/placement.js';
import { useDiffReviewNodeController } from '../diff-review/useDiffReviewNodeController.js';
import { useDiffReviewSession } from '../diff-review/useDiffReviewSession.js';
import type { DiffReviewOpenRequest } from '../diff-review/index.js';
import type { WorkspaceContextDragPayload } from '../context-dnd/contracts.js';
import { linkProjectFileToAgent, removeProjectFileFromAgent } from '../context-dnd/linking.js';
import {
  runnableWorkflowNodeCount,
  workflowExecutionMatchesCurrentCanvas,
  workflowSelectionEligibility,
} from '../workflows/workflow-run-eligibility.js';
import {
  workflowCanvasNodeStatus,
  workflowCanvasReviewGateState,
} from '../workflows/workflow-node-status.js';
import { workflowEdgeRuntimePresentation } from '../workflows/workflow-edge-presentation.js';
import { usePeerTransitPulse } from '../canvas/usePeerTransitPulse.js';
import {
  WorkflowRuntimeProvider,
  workflowPendingDecision,
  type WorkflowRuntimeContextValue,
} from '../workflows/WorkflowRuntimeContext.js';
import {
  NodeCommentsProvider,
  type NodeCommentsContextValue,
} from '../canvas/node-details/NodeCommentsContext.js';
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
  const [workflowDecision, setWorkflowDecision] = useState<WorkflowDecisionTarget | null>(null);
  const [initializingGit, setInitializingGit] = useState(false);
  const [search, setSearch] = useState('');
  const [instance, setInstance] = useState<ReactFlowInstance<WorkshopNode, WorkshopEdge> | null>(
    null,
  );
  const { past, future, recordSnapshot, replaceHistory, clearHistory, undoSnapshot, redoSnapshot } =
    useDurableCanvasHistory();
  const [events, setEvents] = useState<string[]>([
    'Finished checking this project on this computer.',
  ]);
  const loaded = useRef(false);
  const nodesRef = useRef<WorkshopNode[]>(nodes);
  const edgesRef = useRef<WorkshopEdge[]>(edges);
  const collaborationGraphReadOnlyRef = useRef(false);
  const pendingNodeSelection = useRef<string | null>(null);
  const extensionDiscoveryRef = useRef(extensionDiscovery);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  const projectStatus = useProjectStatus(project);
  const sidebarLayout = useWorkspaceSidebarLayout();

  useEffect(() => {
    loaded.current = false;
    const loadWorkspace = async () => {
      if (typeof window.forgeboard.canvas.loadWithHistory === 'function') {
        return unwrap(await window.forgeboard.canvas.loadWithHistory(project.id));
      }
      const document = unwrap(await window.forgeboard.canvas.load(project.id));
      return { document, history: emptyCanvasHistory(project.id, document.id) };
    };
    void loadWorkspace()
      .then(({ document, history }) => {
        const graph = hydrateHistorySnapshot(
          { nodes: document.nodes, edges: document.edges },
          extensionDiscoveryRef.current,
        );
        setCanvas(document);
        setViewport(normalizeCanvasViewport(document.viewport));
        setNodes(graph.nodes);
        setEdges(graph.edges);
        replaceHistory(
          history.past.map((snapshot) =>
            hydrateHistorySnapshot(snapshot, extensionDiscoveryRef.current),
          ),
          history.future.map((snapshot) =>
            hydrateHistorySnapshot(snapshot, extensionDiscoveryRef.current),
          ),
        );
        loaded.current = true;
      })
      .catch((cause: unknown) =>
        onError(cause instanceof Error ? cause.message : 'Could not load the canvas.'),
      );
  }, [onError, project.id, replaceHistory]);

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
              ...(update.branch === undefined ? {} : { branch: update.branch }),
              ...(update.worktreeId === undefined ? {} : { worktreeId: update.worktreeId }),
              ...(update.worktreeRecordedActive === undefined
                ? {}
                : { worktreeRecordedActive: update.worktreeRecordedActive }),
              ...(update.interactiveInputSupported === undefined
                ? {}
                : {
                    interactiveInputSupported: update.interactiveInputSupported,
                  }),
              ...(update.pauseSupported === undefined
                ? {}
                : { pauseSupported: update.pauseSupported }),
              ...(update.interruptSupported === undefined
                ? {}
                : { interruptSupported: update.interruptSupported }),
              ...(update.resumeSupported === undefined
                ? {}
                : { resumeSupported: update.resumeSupported }),
              ...(update.providerSessionAvailable === undefined
                ? {}
                : {
                    providerSessionAvailable: update.providerSessionAvailable,
                  }),
              ...(update.tokenUsage === undefined ? {} : { tokenUsage: update.tokenUsage }),
              ...(update.cost === undefined ? {} : { cost: update.cost }),
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
  const pendingHistory = useMemo(
    () => (canvas === null ? null : durableHistoryState(project.id, canvas.id, past, future)),
    [canvas, future, past, project.id],
  );
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
      clearHistory();
      setEvents((items) =>
        items[0] === 'Applied the latest shared canvas changes.'
          ? items
          : ['Applied the latest shared canvas changes.', ...items].slice(0, 80),
      );
      return true;
    },
    [clearHistory, onError, pendingCanvas, selectedEdgeId, selectedNodeId],
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
      items[0] === 'Your role in this shared session is view-only, so you cannot change the canvas.'
        ? items
        : [
            'Your role in this shared session is view-only, so you cannot change the canvas.',
            ...items,
          ].slice(0, 80),
    );
  }, []);
  const { saveState, persistedUpdatedAt, flushCanvas } = useCanvasPersistence({
    projectId: project.id,
    document: pendingCanvas,
    history: pendingHistory,
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
          ['Set up Git without changing any existing files.', ...items].slice(0, 30),
        );
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Git could not be set up.');
    } finally {
      setInitializingGit(false);
    }
  }, [onError, onProjectUpdated, project.id]);

  const record = useCallback(() => {
    recordSnapshot(nodes, edges);
  }, [edges, nodes, recordSnapshot]);

  const { setNodeCollapsed, beginNodeResize, finishNodeDrag, changeCanvasNodes } =
    useCanvasGraphInteractions({
      projectId: project.id,
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
    const snapshot = undoSnapshot({ nodes, edges });
    if (!snapshot) return;
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setEvents((items) => ['Undid the last canvas change.', ...items].slice(0, 30));
  }, [collaborationCanvas.graphReadOnly, edges, nodes, reportCollaborationReadOnly, undoSnapshot]);

  const redo = useCallback(() => {
    if (collaborationCanvas.graphReadOnly) {
      reportCollaborationReadOnly();
      return;
    }
    const snapshot = redoSnapshot({ nodes, edges });
    if (!snapshot) return;
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setEvents((items) => ['Redid a canvas change.', ...items].slice(0, 30));
  }, [collaborationCanvas.graphReadOnly, edges, nodes, redoSnapshot, reportCollaborationReadOnly]);

  const { copySelected, duplicateNode, duplicateSelected, pasteClipboard } =
    useCanvasClipboardActions({
      graphReadOnly: collaborationCanvas.graphReadOnly,
      nodes,
      edges,
      selectedNodeId,
      pendingNodeSelection,
      record,
      reportReadOnly: reportCollaborationReadOnly,
      setNodes,
      setEdges,
      setSelectedNodeId,
      setSelectedEdgeId,
      setEvents,
    });

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
    (
      kind: NodeKind,
      position?: { x: number; y: number },
      dataOverrides?: Partial<WorkshopNodeData>,
    ) => {
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
            ...dataOverrides,
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

  const addAgentNode = useCallback(
    (adapterId: RunAdapterId, position?: { x: number; y: number }) => {
      const theme = providerTheme(adapterId);
      addNode('agent', position, {
        adapterId,
        ...(theme === null ? {} : { title: theme.label, color: theme.accent }),
      });
    },
    [addNode],
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

  const addWorkflowTemplate = useCallback(
    (template: WorkflowTemplate) => {
      if (collaborationCanvas.graphReadOnly) {
        reportCollaborationReadOnly();
        return;
      }
      try {
        const origin = collisionFreeTemplateOrigin(template, nodesRef.current, { x: 220, y: 150 });
        const built = buildWorkflowTemplate(template.id, settings, origin);
        const selected = built.nodes[0];
        if (selected === undefined) throw new Error('The workflow template contains no nodes.');
        record();
        pendingNodeSelection.current = selected.id;
        setNodes((items) => [
          ...items.map((node) => ({ ...node, selected: false })),
          ...built.nodes.map((node, index) => ({ ...node, selected: index === 0 })),
        ]);
        setEdges((items) => [
          ...items.map((edge) => ({ ...edge, selected: false })),
          ...built.edges,
        ]);
        setSelectedNodeId(selected.id);
        setSelectedEdgeId(null);
        window.setTimeout(() => {
          if (pendingNodeSelection.current === selected.id) pendingNodeSelection.current = null;
        }, 250);
        setEvents((items) =>
          [
            `Added ${built.template.name} workflow with ${built.nodes.length} nodes.`,
            ...items,
          ].slice(0, 30),
        );
      } catch (cause) {
        onError(
          cause instanceof Error
            ? cause.message
            : 'Forgeboard could not add the workflow template.',
        );
      }
    },
    [collaborationCanvas.graphReadOnly, onError, record, reportCollaborationReadOnly, settings],
  );

  const attachProjectFileContext = useCallback(
    async (targetNodeId: string, payload: WorkspaceContextDragPayload): Promise<void> => {
      if (collaborationGraphReadOnlyRef.current) {
        reportCollaborationReadOnly();
        throw new Error(
          'Your role in this shared session is view-only, so you cannot change the canvas.',
        );
      }
      const target = nodesRef.current.find((node) => node.id === targetNodeId);
      if (target === undefined || target.data.kind !== 'agent') {
        throw new Error('You can only add project files to an Agent node.');
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
        throw new Error(
          'Your role in this shared session is view-only, so you cannot change the canvas.',
        );
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
          `${result.createdFileNode ? 'Created a file node and added' : 'Added'} the project file to the agent.`,
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
      setEvents((items) =>
        ["Removed a project file from the agent's context.", ...items].slice(0, 30),
      );
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
      setEvents((items) => ['Shared a comment.', ...items].slice(0, 80));
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
      setEvents((items) => ['Saved a private comment on this computer.', ...items].slice(0, 80));
      return true;
    },
    [pendingCanvas, selectedNodeId],
  );
  const runnableAgents = agents.filter(
    (agent): agent is typeof agent & { id: RunAdapterId } =>
      agent.installed && isRunAdapterId(agent.id),
  );
  const fallbackAdapter = isRunAdapterId(settings.defaultAgent)
    ? settings.defaultAgent
    : 'test-agent';
  const selectedAdapter = selectedNode
    ? (selectedNode.data.adapterId ?? fallbackAdapter)
    : 'test-agent';
  const selectedAgent = runnableAgents.find((agent) => agent.id === selectedAdapter);
  const selectedModel = effectiveNodeModel(
    selectedAgent,
    selectedNode?.data.model,
    settings.agentDefaultModels[selectedAdapter],
  );
  const configuredPermission =
    selectedNode?.data.permissionProfile ?? settings.defaultPermissionProfile;
  const selectedPermission = configuredPermission;
  const selectedPermissionUnavailableReason =
    selectedNode === null
      ? null
      : permissionProfileUnavailableReason(selectedPermission, settings, selectedAdapter);
  const selectedNodeKind = selectedNode?.data.kind;
  const watchedProviderAdapterIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedNodeKind === 'agent') ids.add(selectedAdapter);
    for (const node of nodes) {
      if (node.data.kind === 'agent') ids.add(node.data.adapterId ?? fallbackAdapter);
    }
    return [...ids].sort((left, right) => left.localeCompare(right));
  }, [fallbackAdapter, nodes, selectedAdapter, selectedNodeKind]);
  const providerGates = useAgentProviderGate({
    adapterIds: watchedProviderAdapterIds,
    executableOverrides: {
      codex: settings.agentExecutableOverrides['codex'] ?? '',
      claude: settings.agentExecutableOverrides['claude'] ?? '',
    },
  });
  const agentRunBlockReason = useCallback(
    (node: WorkshopNode): string | null => {
      if (node.data.kind !== 'agent') return null;
      const gate = providerGates.gateFor(node.data.adapterId ?? fallbackAdapter);
      return gate !== null && gate.settled && gate.state !== 'connected'
        ? gate.blockedReason
        : null;
    },
    [fallbackAdapter, providerGates.gateFor],
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
    agentRunBlockReason,
  );
  const selectedWorkflowScope = selectedWorkflowEligibility.scope;
  const canRunWorkflow = runnableWorkflowNodeCount(nodes, edges, agentRunBlockReason) > 0;

  const updateNodeData = useCallback((nodeId: string, data: Partial<WorkshopNode['data']>) => {
    setNodes((items) => {
      const nextNodes = items.map((node) => {
        if (node.id !== nodeId) return node;
        const nextData = applyNodeDataPatch(node.data, data);
        return { ...node, data: nextData };
      });
      nodesRef.current = nextNodes;
      return nextNodes;
    });
  }, []);
  useAgentStatusReconciliation({
    projectId: project.id,
    nodes,
    updateNodeData,
    onError,
  });
  useAgentWorktreeRecord({ projectId: project.id, nodes, updateNodeData });
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
    ...(selectedModel === undefined ? {} : { selectedModel }),
    selectedPermission,
    permissionUnavailableReason: selectedPermissionUnavailableReason,
    verifyAdapterConnection: providerGates.verifyAdapterConnection,
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
  const workflowEvidenceExecution = workflowExecutionMatchesCurrentCanvas(
    workflows.currentExecution,
    persistedUpdatedAt,
    saveState !== 'saved',
  )
    ? workflows.currentExecution
    : null;
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
        (workflowEvidenceExecution?.nodeRuns ?? []).map(
          (run) => [run.nodeId, workflowCanvasNodeStatus(run.status)] as const,
        ),
      ),
    [workflowEvidenceExecution],
  );
  const workflowReviewGates = useMemo(
    () =>
      new Map(
        (workflowEvidenceExecution?.reviewGates ?? []).map((gate) => [gate.nodeId, gate] as const),
      ),
    [workflowEvidenceExecution],
  );
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
  const nodeRegistry = useMemo(
    () => nodeRegistryFromTemplates(extensionTemplates),
    [extensionTemplates],
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
        const definition = nodeRegistry.resolve(node.data);
        const status = workflowNodeStatuses.get(node.id);
        const reviewGate = workflowReviewGates.get(node.id);
        const inheritedLock = protectedNodeIds.has(node.id) && !node.data.locked;
        const displayed =
          status === undefined && reviewGate === undefined && !inheritedLock
            ? node
            : {
                ...node,
                data: {
                  ...node.data,
                  ...(status === undefined ? {} : { status }),
                  ...(reviewGate === undefined
                    ? {}
                    : {
                        gateState: workflowCanvasReviewGateState(reviewGate.status),
                      }),
                  ...(inheritedLock ? { locked: true } : {}),
                },
              };
        const mutable = !protectedNodeIds.has(node.id);
        return {
          ...displayed,
          // Single source of truth for the agent-window drag handle, so every creation path
          // (add, hydrate, collaboration merge, workflow template) restricts dragging to the
          // title bar. Never clobber a handle a node already carries.
          ...(node.data.kind === 'agent' && displayed.dragHandle === undefined
            ? { dragHandle: AGENT_NODE_DRAG_HANDLE }
            : {}),
          ariaLabel: `${node.data.title}, ${definition.label} node${
            protectedNodeIds.has(node.id) ? ', locked' : ''
          }`,
          connectable: mutable,
          deletable: mutable,
          draggable: mutable,
        };
      }),
    [nodeRegistry, nodes, protectedNodeIds, workflowNodeStatuses, workflowReviewGates],
  );
  const workflowEdgeStates = useMemo(
    () => new Map((workflowEvidenceExecution?.edges ?? []).map((edge) => [edge.edgeId, edge])),
    [workflowEvidenceExecution],
  );
  const pulsingEdges = usePeerTransitPulse((cb) =>
    window.forgeboard.agentPeers.onEvent((event) => {
      if (event.projectId === project.id) cb(event);
    }),
  );
  const runtimeDisplayedEdges = useMemo(
    () =>
      edges.map((edge) => {
        const pulsing = pulsingEdges.has(edge.id);
        const runtime = workflowEdgeStates.get(edge.id);
        if (runtime === undefined) {
          return pulsing
            ? { ...edge, className: `${edge.className ?? ''} peer-transit`.trim() }
            : edge;
        }
        const presentation = workflowEdgeRuntimePresentation(
          runtime,
          edge.data?.edgeType,
          edge.className,
        );
        return {
          ...edge,
          ...presentation,
          className: pulsing
            ? `${presentation.className} peer-transit`.trim()
            : presentation.className,
          style: {
            ...edge.style,
            ...presentation.style,
          },
        };
      }),
    [edges, pulsingEdges, workflowEdgeStates],
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

  const searchTerm = search.toLowerCase();
  const filteredTemplates = NODE_KINDS.filter((kind) =>
    nodeRegistry.resolve({ kind }).label.toLowerCase().includes(searchTerm),
  );
  const filteredWorkflowTemplates = WORKFLOW_TEMPLATES.filter((template) =>
    `${template.name} ${template.description}`.toLowerCase().includes(searchTerm),
  );
  const filteredExtensionTemplates = extensionTemplates.filter(({ extension, definition }) =>
    `${definition.displayName} ${definition.description} ${extension.manifest.name}`
      .toLowerCase()
      .includes(searchTerm),
  );
  const filteredNodes = nodes.filter((node) =>
    `${node.data.title} ${nodeRegistry.resolve(node.data).label}`
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

  const {
    arrangeGroupFrame,
    arrangeSelectedGroupFrame,
    deleteNode,
    deleteSelected,
    fitGroupFrame,
    fitSelectedGroupFrame,
    setNodeLocked,
    updateSelected,
  } = useWorkspaceNodeMutations({
    projectId: project.id,
    graphReadOnly: collaborationCanvas.graphReadOnly,
    selectedNode,
    nodesRef,
    edgesRef,
    reportReadOnly: reportCollaborationReadOnly,
    recordSnapshot,
    updateNodeData,
    replaceNodes: replaceCurrentNodes,
    setEdges,
    setSelectedNodeId,
    setEvents,
  });

  const attachWhiteboardContext = useCallback(
    (sourceNodeId: string, targetNodeId: string): string => {
      if (collaborationCanvas.graphReadOnly) {
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
      if (existing)
        return `The whiteboard specification is already attached to ${target.data.title}.`;
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
      collaborationCanvas.graphReadOnly,
      recordSnapshot,
      reportCollaborationReadOnly,
      setEdges,
      setEvents,
    ],
  );

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
        label: 'Add an agent',
        section: 'Canvas',
        run: () => addNode('agent'),
      },
      {
        id: 'add-task',
        label: 'Add a task',
        section: 'Canvas',
        run: () => addNode('task'),
      },
      {
        id: 'add-brief',
        label: 'Add a product brief',
        section: 'Canvas',
        run: () => addNode('brief'),
      },
      ...extensionTemplates.map((template) => ({
        id: `add-extension-${template.key}`,
        label: `Add ${template.definition.displayName}`,
        section: `Extension · ${template.extension.manifest.name}`,
        run: () => addExtensionNode(template),
      })),
      ...WORKFLOW_TEMPLATES.map((template) => ({
        id: `add-workflow-template-${template.id}`,
        label: `Add ${template.name} workflow`,
        section: 'Workflow templates',
        run: () => addWorkflowTemplate(template),
      })),
      {
        id: 'fit',
        label: 'Zoom to fit the canvas',
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
              label: 'Run the saved canvas workflow',
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
              label: `Run ${selectedNode.data.title} and everything it needs`,
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
      addWorkflowTemplate,
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

  const nodeRosterSource = useMemo<readonly CanvasNodeRosterEntry[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        title: node.data.title,
        kind: node.data.kind,
        locked: node.data.locked,
      })),
    [nodes],
  );
  const nodeRoster = useKeyedStable(
    nodeRosterSource,
    nodeRosterSource
      .map(
        (entry) => `${entry.id}\u0000${entry.title}\u0000${entry.kind}\u0000${String(entry.locked)}`,
      )
      .join('\n'),
  );
  const canvasImageNodesSource = useMemo<readonly CanvasImageNodeEntry[]>(
    () =>
      nodes
        .filter((node) => node.data.kind === 'file' && node.data.file?.kind === 'image')
        .map((node) => {
          const reference = node.data.file;
          return {
            id: node.id,
            title: node.data.title,
            projectId: reference?.projectId ?? '',
            relativePath: reference?.relativePath ?? '',
            missing: reference?.missing ?? false,
            ...(reference?.lastKnownHash === undefined
              ? {}
              : { lastKnownHash: reference.lastKnownHash }),
          };
        }),
    [nodes],
  );
  const canvasImageNodes = useKeyedStable(
    canvasImageNodesSource,
    canvasImageNodesSource
      .map(
        (entry) =>
          `${entry.id} ${entry.title} ${entry.projectId} ${entry.relativePath} ${String(entry.missing)} ${entry.lastKnownHash ?? ''}`,
      )
      .join('\n'),
  );
  const checkProducersSource = useMemo<readonly CheckProducerEntry[]>(
    () =>
      nodes
        .filter((node) => node.data.kind === 'test')
        .map((node) => ({
          nodeId: node.id,
          producerId: checkProducerId(node),
          title: node.data.title,
          checkKind: node.data.checkKind ?? 'test',
        })),
    [nodes],
  );
  const checkProducers = useKeyedStable(
    checkProducersSource,
    checkProducersSource
      .map(
        (entry) =>
          `${entry.nodeId}\u0000${entry.producerId}\u0000${entry.title}\u0000${entry.checkKind}`,
      )
      .join('\n'),
  );
  const openGitPrReadiness = useCallback(
    (runId: string) => {
      gitReview.openTarget({ kind: 'agent-worktree', projectId: project.id, runId });
    },
    [gitReview, project.id],
  );

  const agentSessionValue = useMemo<AgentSessionContextValue>(
    () => ({
      project,
      settings,
      runnableAgents,
      graphReadOnly: collaborationCanvas.graphReadOnly,
      gateFor: providerGates.gateFor,
      recheckProvider: (adapterId: string) => {
        const providerId = providerConnectionIdForAdapter(adapterId);
        if (providerId !== null) void providerGates.recheck(providerId);
      },
      openSettings: onOpenSettings,
      reportError: onError,
      updateNodeData,
      fitGroupFrame,
      arrangeGroupFrame,
      recordHistory: record,
      nodeTitle: (nodeId: string) =>
        nodesRef.current.find((node) => node.id === nodeId)?.data.title ?? null,
      removeAgentContext: removeProjectFileContext,
      requestDeleteNode: deleteNode,
      attachWhiteboardContext,
      nodeRoster,
      canvasImageNodes,
      checkProducers,
      openGitPrReadiness,
      openDiffReview: (nodeId: string, request: DiffReviewOpenRequest) => {
        const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
        if (node?.data.kind !== 'diff') return;
        gitReview.openNodeReview(nodeId, node.data.reviewTarget, request);
      },
    }),
    [
      arrangeGroupFrame,
      attachWhiteboardContext,
      canvasImageNodes,
      checkProducers,
      collaborationCanvas.graphReadOnly,
      deleteNode,
      fitGroupFrame,
      gitReview,
      nodeRoster,
      onError,
      onOpenSettings,
      openGitPrReadiness,
      project,
      providerGates.gateFor,
      providerGates.recheck,
      record,
      removeProjectFileContext,
      runnableAgents,
      settings,
      updateNodeData,
    ],
  );

  const {
    executions: workflowExecutions,
    interactionEvents: workflowInteractionEvents,
    busyAction: workflowBusyAction,
    mutationsAuthorized: workflowMutationsAuthorized,
    currentExecution: workflowCurrentExecution,
    start: workflowStart,
    cancelNode: workflowCancelNode,
  } = workflows;

  const workflowRuntimeValue = useMemo<WorkflowRuntimeContextValue>(
    () => ({
      executions: workflowExecutions,
      interactionEvents: workflowInteractionEvents,
      busyAction: workflowBusyAction,
      mutationsAuthorized: workflowMutationsAuthorized,
      reviewGateFor: (nodeId: string) => workflowReviewGates.get(nodeId) ?? null,
      pendingDecisionFor: (nodeId: string) =>
        workflowPendingDecision(workflowCurrentExecution, nodeId),
      requestDecision: setWorkflowDecision,
      startNode: (nodeId: string) =>
        void workflowStart({ kind: 'node', nodeId, includeUpstream: false }),
      cancelNode: (input) => void workflowCancelNode(input),
      revealArtifact: async (input) => {
        unwrap(await window.forgeboard.workflows.revealArtifact(input));
      },
      openArtifact: async (input) => {
        unwrap(await window.forgeboard.workflows.openArtifact(input));
      },
    }),
    [
      workflowReviewGates,
      workflowExecutions,
      workflowInteractionEvents,
      workflowBusyAction,
      workflowMutationsAuthorized,
      workflowCurrentExecution,
      workflowStart,
      workflowCancelNode,
    ],
  );

  // Per-node comment data + mutators for the node-header details popover. These mirror the
  // selected-node comment wiring the WorkspaceInspector receives as props (createSharedComment /
  // createLocalComment above), but parameterized by node id so the popover works on any node — not
  // only the inspector's current selection. Purely additive: the inspector's own props are
  // unchanged, so removing the inspector later leaves this untouched.
  const nodeCommentsValue = useMemo<NodeCommentsContextValue>(
    () => ({
      localCommentsFor: (nodeId) => localCommentsForNode(pendingCanvas, nodeId),
      sharedCommentsFor: (nodeId) => collaborationCommentsForNode(pendingCanvas, nodeId),
      rejectedSharedCommentsFor: (nodeId) =>
        collaborationCanvas.rejectedCommentEntries.filter(
          (entry) => entry.comment.nodeId === nodeId,
        ),
      createLocalComment: (nodeId, body) => {
        if (pendingCanvas === null || body.trim() === '') return false;
        const next = appendLocalComment(pendingCanvas, nodeId, body, {
          id: `local:${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
        });
        if (next === null || next === pendingCanvas) return false;
        setCanvas(next);
        setEvents((items) =>
          ['Saved a private comment on this computer.', ...items].slice(0, 80),
        );
        return true;
      },
      createSharedComment: async (nodeId, body) => {
        const comment = await collaborationCanvas.createComment(nodeId, body);
        if (comment === null) return false;
        setCanvas((current) => appendSharedComment(current, nodeId, comment));
        setEvents((items) => ['Shared a comment.', ...items].slice(0, 80));
        return true;
      },
      discardRejectedComment: collaborationCanvas.discardRejectedComment,
      canComment: collaborationCanvas.canComment,
      roomEnabled: settings.collaborationEnabled,
    }),
    [
      collaborationCanvas.canComment,
      collaborationCanvas.createComment,
      collaborationCanvas.discardRejectedComment,
      collaborationCanvas.rejectedCommentEntries,
      pendingCanvas,
      settings.collaborationEnabled,
    ],
  );

  return (
    <main className="workspace-shell">
      <WorkspaceCommandBar
        project={projectStatus.project}
        projectStatusAvailable={projectStatus.available}
        canvasName={canvas?.name}
        agents={agents}
        saveState={saveState}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        workflowStatus={
          workflows.activeExecution?.status ?? workflows.currentExecution?.status ?? null
        }
        commandPaletteShortcut={commandPaletteShortcutLabel(settings.keyboardPreset)}
        collaborationEnabled={settings.collaborationEnabled}
        sharingStatus={collaborationCanvas.connectionStatus}
        onCloseProject={() => void closeProject()}
        onUndo={undo}
        onRedo={redo}
        onFitCanvas={() =>
          void instance?.fitView({
            padding: 0.18,
            duration: settings.reducedMotion ? 0 : 240,
          })
        }
        onOpenGitReview={openProjectGitReview}
        onOpenCommands={() => setPaletteOpen(true)}
        onOpenSettings={onOpenSettings}
      />

      <RejectedCommentsNotice
        entries={collaborationCanvas.rejectedCommentEntries}
        onDiscard={collaborationCanvas.discardRejectedComment}
      />

      <div
        className={`workspace-grid ${activityOpen ? '' : 'activity-closed'}`}
        style={sidebarLayout.gridStyle}
      >
        <WorkspaceRail
          project={project}
          tab={railTab}
          search={search}
          templates={filteredTemplates}
          workflowTemplates={filteredWorkflowTemplates}
          extensionTemplates={filteredExtensionTemplates}
          nodes={railTab === 'nodes' ? filteredNodes : nodes}
          nodeRegistry={nodeRegistry}
          fileOperations={window.forgeboard.files}
          initializingGit={initializingGit}
          collaborationGraphReadOnly={collaborationCanvas.graphReadOnly}
          runnableAgents={runnableAgents}
          onTabChange={setRailTab}
          onSearchChange={setSearch}
          onAddNode={addNode}
          onAddAgentNode={addAgentNode}
          onAddWorkflowTemplate={addWorkflowTemplate}
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
        <WorkspaceResizeHandle
          label="Resize project rail"
          className="rail-resize"
          edge="start"
          range={sidebarLayout.rail.range}
          width={sidebarLayout.rail.width}
          onResize={sidebarLayout.rail.resize}
          onReset={sidebarLayout.rail.reset}
        />
        <AgentSessionProvider value={agentSessionValue}>
        <WorkflowRuntimeProvider value={workflowRuntimeValue}>
        <NodeCommentsProvider value={nodeCommentsValue}>
        <WorkspaceCanvas
          canvas={canvas}
          nodes={displayedGraph.nodes}
          edges={displayedGraph.edges}
          settings={settings}
          extensionTemplates={extensionTemplates}
          nodeRegistry={nodeRegistry}
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
            setEvents((items) =>
              ['Connected the nodes with a context link.', ...items].slice(0, 30),
            );
          }}
          onNodeDragStart={record}
          onNodeDragStop={finishNodeDrag}
          onSetNodeCollapsed={setNodeCollapsed}
          onNodeResizeStart={beginNodeResize}
          onKeyboardMove={moveSelectedByKeyboard}
          onInspectNode={(nodeId) => {
            pendingNodeSelection.current = null;
            setSelectedNodeId(nodeId);
            setSelectedEdgeId(null);
            setNodes((items) =>
              items.map((node) => ({
                ...node,
                selected: node.id === nodeId,
              })),
            );
            setEdges((items) => items.map((edge) => ({ ...edge, selected: false })));
          }}
          onSetNodeLocked={setNodeLocked}
          onDuplicateNode={duplicateNode}
          onDeleteNode={deleteNode}
          workflowRunBusy={workflowStartBusy}
          workflowMutationsAuthorized={workflows.mutationsAuthorized}
          agentRunBlockReason={agentRunBlockReason}
          onRunWorkflowScope={(scope) => void workflows.start(scope)}
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
          edgeConfigNodes={nodes}
          onUpdateEdgeType={updateEdgeType}
          onUpdateEdgeData={updateEdgeData}
          onAddNode={addNode}
          onAddExtensionNode={addExtensionNode}
          collaborationAwareness={collaborationCanvas.awareness}
          onCollaborationCursorMove={collaborationCanvas.updateCursor}
          onCollaborationCursorLeave={collaborationCanvas.clearCursor}
          collaborationGraphReadOnly={collaborationCanvas.graphReadOnly}
          inheritedLockedNodeIds={inheritedContextLockIds(nodes, protectedNodeIds)}
          deletionProtectedNodeIds={removalProtectedNodeIds}
          onAttachAgentContext={attachProjectFileContext}
          onContextDropError={onError}
        />
        </NodeCommentsProvider>
        </WorkflowRuntimeProvider>
        </AgentSessionProvider>
        <WorkspaceResizeHandle
          label="Resize details panel"
          className="inspector-resize"
          edge="end"
          range={sidebarLayout.inspector.range}
          width={sidebarLayout.inspector.width}
          onResize={sidebarLayout.inspector.resize}
          onReset={sidebarLayout.inspector.reset}
        />
        <WorkspaceInspector
          nodeRegistry={nodeRegistry}
          project={project}
          settings={settings}
          canvas={canvas}
          workflowExecution={workflowEvidenceExecution}
          nodes={nodes}
          selectedNode={inspectorSelectedNode}
          selectedNodeLockedByGroup={selectedNodeLockedByGroup}
          selectedNodeDeletionProtected={
            selectedNode !== null && removalProtectedNodeIds.has(selectedNode.id)
          }
          selectedEdge={selectedEdge}
          runnableAgents={runnableAgents}
          previewSession={selectedNode ? (previews.sessions[selectedNode.id] ?? null) : null}
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
          onAttachWhiteboardContext={attachWhiteboardContext}
          onFitGroupFrame={fitSelectedGroupFrame}
          onArrangeGroupFrame={arrangeSelectedGroupFrame}
          onUpdateEdgeType={updateEdgeType}
          onUpdateEdgeData={updateEdgeData}
          onDuplicateSelected={duplicateSelected}
          onDeleteSelected={deleteSelected}
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
              void workflows.start({
                kind: 'node',
                nodeId,
                includeUpstream: false,
              }),
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
