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
  applyNodeChanges,
  MarkerType,
  ReactFlowProvider,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
} from '@xyflow/react';
import { PanelBottomOpen } from 'lucide-react';

import type { CanvasDocument, RunAdapterId } from '../../../shared/contracts.js';
import type { GitTargetInput } from '../../../shared/git-contracts.js';
import { unwrap } from '../lib/ipc.js';
import { NODE_DEFINITIONS, NODE_KINDS, type NodeKind, type WorkshopNode } from './CanvasNode.js';
import { CommandPalette } from './CommandPalette.js';
import { createExtensionNodeBinding, extensionTemplateKey } from './extension-nodes.js';
import { GitReviewDialog } from './git-review/GitReviewDialog.js';
import { CheckApprovalDialog } from './workspace/CheckApprovalDialog.js';
import { RunApprovalDialog } from './workspace/RunApprovalDialog.js';
import { WorkspaceActivityDrawer } from './workspace/WorkspaceActivityDrawer.js';
import { WorkspaceCanvas } from './workspace/WorkspaceCanvas.js';
import { WorkspaceCommandBar } from './workspace/WorkspaceCommandBar.js';
import { WorkspaceInspector } from './workspace/WorkspaceInspector.js';
import { WorkspaceNotifications } from './workspace/WorkspaceOverlays.js';
import { WorkspaceRail } from './workspace/WorkspaceRail.js';
import {
  createEdgeData,
  edgeDataForPersistence,
  type WorkshopEdgeData,
} from './workspace/edge-config.js';
import { hydrateNodeData, isRunAdapterId, summarizeRunEvent } from './workspace/helpers.js';
import type {
  CheckCommand,
  EdgeKind,
  ExtensionTemplate,
  Snapshot,
  WorkshopEdge,
  WorkspaceHandle,
  WorkspaceProps,
} from './workspace/types.js';
import { useAgentRunController } from './workspace/useAgentRunController.js';
import { useCanvasPersistence } from './workspace/useCanvasPersistence.js';
import { useProjectChecks } from './workspace/useProjectChecks.js';
import { useWorkspacePreviews } from './workspace/useWorkspacePreviews.js';

export const Workspace = forwardRef<WorkspaceHandle, WorkspaceProps>(
  function Workspace(props, ref) {
    return (
      <ReactFlowProvider>
        <WorkspaceInner {...props} ref={ref} />
      </ReactFlowProvider>
    );
  },
);

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
  const [nodes, setNodes] = useState<WorkshopNode[]>([]);
  const [edges, setEdges] = useState<WorkshopEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [railTab, setRailTab] = useState<'project' | 'nodes'>('project');
  const [activityOpen, setActivityOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [gitReviewTarget, setGitReviewTarget] = useState<GitTargetInput | null>(null);
  const [initializingGit, setInitializingGit] = useState(false);
  const [search, setSearch] = useState('');
  const [instance, setInstance] = useState<ReactFlowInstance<WorkshopNode, WorkshopEdge> | null>(
    null,
  );
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [events, setEvents] = useState<string[]>(['Project health scan completed locally.']);
  const loaded = useRef(false);
  const pendingNodeSelection = useRef<string | null>(null);
  const extensionDiscoveryRef = useRef(extensionDiscovery);

  useEffect(() => {
    loaded.current = false;
    void window.forgeboard.canvas
      .load(project.id)
      .then((result) => {
        const document = unwrap(result);
        setCanvas(document);
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
      items.map((node) => ({ ...node, data: hydrateNodeData(node.data, extensionDiscovery) })),
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

  const previews = useWorkspacePreviews({ projectId: project.id, nodes, setNodes, setEvents });

  const pendingCanvas = useMemo<CanvasDocument | null>(() => {
    if (!canvas || !loaded.current) return null;
    return {
      ...canvas,
      nodes: nodes.map(({ id, position, width, height, data }) => ({
        id,
        type: data.kind,
        position,
        ...(width === null || width === undefined ? {} : { width }),
        ...(height === null || height === undefined ? {} : { height }),
        data,
      })),
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
      viewport: instance?.getViewport() ?? canvas.viewport,
    };
  }, [canvas, edges, instance, nodes]);
  const { saveState, flushCanvas } = useCanvasPersistence({
    projectId: project.id,
    document: pendingCanvas,
    autosaveIntervalMs: settings.autosaveIntervalMs,
    onError,
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

  const record = useCallback(() => {
    setPast((items) => [...items.slice(-49), { nodes, edges }]);
    setFuture([]);
  }, [edges, nodes]);

  const undo = useCallback(() => {
    const snapshot = past.at(-1);
    if (!snapshot) return;
    setFuture((items) => [{ nodes, edges }, ...items].slice(0, 50));
    setPast((items) => items.slice(0, -1));
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setEvents((items) => ['Undid the last canvas change.', ...items].slice(0, 30));
  }, [edges, nodes, past]);

  const redo = useCallback(() => {
    const snapshot = future[0];
    if (!snapshot) return;
    setPast((items) => [...items, { nodes, edges }].slice(-50));
    setFuture((items) => items.slice(1));
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setEvents((items) => ['Redid a canvas change.', ...items].slice(0, 30));
  }, [edges, future, nodes]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
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
  }, [redo, undo]);

  const addNode = useCallback(
    (kind: NodeKind, position?: { x: number; y: number }) => {
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
          data: {
            kind,
            title: definition.label,
            description: definition.description,
            status: 'idle',
            locked: false,
            collapsed: false,
            color: definition.color,
          },
        },
      ]);
      setSelectedNodeId(id);
      window.setTimeout(() => {
        if (pendingNodeSelection.current === id) pendingNodeSelection.current = null;
      }, 250);
      setEvents((items) => [`Added ${definition.label} node.`, ...items].slice(0, 30));
    },
    [nodes.length, record],
  );

  const addExtensionNode = useCallback(
    (template: ExtensionTemplate, position?: { x: number; y: number }) => {
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
    [nodes.length, record],
  );

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const runnableAgents = agents.filter(
    (agent): agent is typeof agent & { id: RunAdapterId } =>
      agent.installed && isRunAdapterId(agent.id),
  );
  const selectedAdapter = selectedNode
    ? (selectedNode.data.adapterId ??
      (isRunAdapterId(settings.defaultAgent) ? settings.defaultAgent : 'test-agent'))
    : 'test-agent';
  const selectedPermission = selectedNode
    ? (selectedNode.data.permissionProfile ??
      (settings.defaultPermissionProfile === 'plan-read-only' ||
      (settings.defaultPermissionProfile === 'docker-isolated' &&
        settings.dockerEnabled &&
        selectedAdapter !== 'test-agent')
        ? settings.defaultPermissionProfile
        : 'worktree-write'))
    : 'worktree-write';

  const updateNodeData = useCallback((nodeId: string, data: Partial<WorkshopNode['data']>) => {
    setNodes((items) =>
      items.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node,
      ),
    );
  }, []);
  const runs = useAgentRunController({
    project,
    selectedNode,
    selectedAdapter,
    selectedPermission,
    updateNodeData,
    setEvents,
    onError,
  });
  const checks = useProjectChecks({ projectId: project.id, setEvents, onError });

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
    if (selectedNode) updateNodeData(selectedNode.id, data);
  }

  function duplicateSelected() {
    if (!selectedNode) return;
    record();
    const id = crypto.randomUUID();
    pendingNodeSelection.current = id;
    setNodes((items) => [
      ...items.map((node) => ({ ...node, selected: false })),
      {
        ...selectedNode,
        id,
        position: { x: selectedNode.position.x + 32, y: selectedNode.position.y + 32 },
        selected: true,
        data: { ...selectedNode.data, title: `${selectedNode.data.title} copy` },
      },
    ]);
    setSelectedNodeId(id);
    window.setTimeout(() => {
      if (pendingNodeSelection.current === id) pendingNodeSelection.current = null;
    }, 250);
  }

  function deleteSelected() {
    if (!selectedNode) return;
    if (selectedNode.data.kind === 'web-preview' || selectedNode.data.kind === 'mobile-preview') {
      void window.forgeboard.previews.stop({ projectId: project.id, nodeId: selectedNode.id });
    }
    record();
    setNodes((items) => items.filter((node) => node.id !== selectedNode.id));
    setEdges((items) =>
      items.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id),
    );
    setSelectedNodeId(null);
    setEvents((items) => [`Deleted ${selectedNode.data.title}.`, ...items].slice(0, 30));
  }

  function updateEdgeType(edgeType: EdgeKind) {
    if (!selectedEdge) return;
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
    if (!selectedEdge) return;
    record();
    setEdges((items) =>
      items.map((edge) =>
        edge.id === selectedEdge.id ? { ...edge, label: data.edgeType, data } : edge,
      ),
    );
  }

  const paletteActions = useMemo(
    () => [
      { id: 'add-agent', label: 'Add agent node', section: 'Canvas', run: () => addNode('agent') },
      { id: 'add-task', label: 'Add task node', section: 'Canvas', run: () => addNode('task') },
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
          void instance?.fitView({ padding: 0.18, duration: settings.reducedMotion ? 0 : 240 }),
      },
      {
        id: 'git-review',
        label: 'Review Git changes',
        section: 'Project',
        run: () => setGitReviewTarget({ kind: 'primary', projectId: project.id }),
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
      closeProject,
      extensionTemplates,
      instance,
      onOpenSettings,
      project.id,
      settings.reducedMotion,
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
        onCloseProject={() => void closeProject()}
        onUndo={undo}
        onRedo={redo}
        onFitCanvas={() =>
          void instance?.fitView({ padding: 0.18, duration: settings.reducedMotion ? 0 : 240 })
        }
        onOpenGitReview={() => setGitReviewTarget({ kind: 'primary', projectId: project.id })}
        onOpenCommands={() => setPaletteOpen(true)}
        onToggleNotifications={() => setNotificationsOpen((open) => !open)}
        onOpenSettings={onOpenSettings}
      />

      <div className={`workspace-grid ${activityOpen ? '' : 'activity-closed'}`}>
        <WorkspaceRail
          project={project}
          tab={railTab}
          search={search}
          templates={filteredTemplates}
          extensionTemplates={filteredExtensionTemplates}
          nodes={filteredNodes}
          initializingGit={initializingGit}
          onTabChange={setRailTab}
          onSearchChange={setSearch}
          onAddNode={addNode}
          onAddExtensionNode={addExtensionNode}
          onInitializeGit={() => void initializeGit()}
          onSelectNode={(node) => {
            setSelectedNodeId(node.id);
            void instance?.setCenter(node.position.x, node.position.y, {
              zoom: 1.15,
              duration: settings.reducedMotion ? 0 : 220,
            });
          }}
        />
        <WorkspaceCanvas
          canvas={canvas}
          nodes={nodes}
          edges={edges}
          settings={settings}
          extensionTemplates={extensionTemplates}
          instance={instance}
          onInstance={setInstance}
          onNodesChange={(changes: NodeChange<WorkshopNode>[]) =>
            setNodes((items) => applyNodeChanges(changes, items))
          }
          onEdgesChange={(changes: EdgeChange<WorkshopEdge>[]) => {
            if (changes.some((change) => change.type === 'remove')) record();
            setEdges((items) => applyEdgeChanges(changes, items));
          }}
          onConnect={(connection: Connection) => {
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
        />
        <WorkspaceInspector
          project={project}
          settings={settings}
          canvas={canvas}
          nodes={nodes}
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          runnableAgents={runnableAgents}
          selectedAdapter={selectedAdapter}
          selectedPermission={selectedPermission}
          previewSession={selectedNode ? (previews.sessions[selectedNode.id] ?? null) : null}
          runInput={runs.runInput}
          preparingRun={runs.preparingRun}
          onClearSelection={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
          }}
          onRecord={record}
          onUpdateSelected={updateSelected}
          onUpdateEdgeType={updateEdgeType}
          onUpdateEdgeData={updateEdgeData}
          onDuplicateSelected={duplicateSelected}
          onDeleteSelected={deleteSelected}
          onRunInputChange={runs.setRunInput}
          onSendRunInput={() => void runs.sendRunInput()}
          onControlRun={(action) => void runs.controlRun(action)}
          onPrepareRun={() => {
            updateSelected({
              permissionProfile: selectedPermission,
              lastRunPermissionProfile: selectedPermission,
              changedFiles: [],
            });
            void runs.prepareSelectedRun();
          }}
          onPreviewSession={(session) => {
            if (selectedNode) previews.updateSession(selectedNode.id, session);
          }}
          onOpenSettings={onOpenSettings}
          onError={onError}
        />
        <WorkspaceActivityDrawer
          events={events}
          changeReports={changeReports}
          checkCommands={checkCommands}
          latestChecks={checks.latestByCheckId}
          busyCheckId={checks.busyCheckId}
          onPrepareCheck={(checkId) => void checks.prepare(checkId)}
          onCancelCheck={(executionId) => void checks.cancel(executionId)}
          onOpenSettings={onOpenSettings}
          onOpenGitReview={(runId) =>
            setGitReviewTarget(
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
      {gitReviewTarget !== null && (
        <GitReviewDialog
          target={gitReviewTarget}
          projectName={project.name}
          onClose={() => setGitReviewTarget(null)}
          onError={onError}
        />
      )}
      {runs.disclosure && (
        <RunApprovalDialog
          disclosure={runs.disclosure}
          prompt={
            nodes.find((node) => node.id === runs.disclosure?.nodeId)?.data.prompt ??
            nodes.find((node) => node.id === runs.disclosure?.nodeId)?.data.description ??
            ''
          }
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
