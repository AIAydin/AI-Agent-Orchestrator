import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  Activity,
  Bell,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Command,
  Copy,
  FileCode2,
  Files,
  GitBranch,
  History,
  Layers3,
  LayoutGrid,
  Lock,
  Maximize2,
  PanelBottomClose,
  PanelBottomOpen,
  Play,
  Redo2,
  Search,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  Undo2,
  Unlock,
  X,
} from 'lucide-react';

import type {
  AgentDetection,
  AppSettings,
  AuditEvent,
  CanvasDocument,
  Project,
  RunAdapterId,
  RunDisclosure,
  RunEventEnvelope,
} from '../../../shared/contracts.js';
import { CommandPalette } from './CommandPalette.js';
import {
  NODE_DEFINITIONS,
  NODE_KINDS,
  WORKSHOP_NODE_TYPES,
  type NodeKind,
  type WorkshopNode,
} from './CanvasNode.js';
import { unwrap } from '../lib/ipc.js';

type EdgeKind = 'context' | 'execute' | 'output' | 'review' | 'revision' | 'dependency';
type WorkshopEdge = Edge<{ edgeType: EdgeKind }>;
type DrawerTab = 'activity' | 'changes' | 'checks' | 'audit';

interface Snapshot {
  nodes: WorkshopNode[];
  edges: WorkshopEdge[];
}

interface WorkspaceProps {
  project: Project;
  settings: AppSettings;
  agents: AgentDetection[];
  onClose: () => void;
  onOpenSettings: () => void;
  onError: (message: string) => void;
}

export function Workspace(props: WorkspaceProps) {
  return (
    <ReactFlowProvider>
      <WorkspaceInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkspaceInner({
  project,
  settings,
  agents,
  onClose,
  onOpenSettings,
  onError,
}: WorkspaceProps) {
  const [canvas, setCanvas] = useState<CanvasDocument | null>(null);
  const [nodes, setNodes] = useState<WorkshopNode[]>([]);
  const [edges, setEdges] = useState<WorkshopEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [railTab, setRailTab] = useState<'project' | 'nodes'>('project');
  const [activityOpen, setActivityOpen] = useState(true);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('activity');
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditState, setAuditState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [auditRefresh, setAuditRefresh] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [instance, setInstance] = useState<ReactFlowInstance<WorkshopNode, WorkshopEdge> | null>(
    null,
  );
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [events, setEvents] = useState<string[]>(['Project health scan completed locally.']);
  const [disclosure, setDisclosure] = useState<RunDisclosure | null>(null);
  const [preparingRun, setPreparingRun] = useState(false);
  const [approvingRun, setApprovingRun] = useState(false);
  const [runInput, setRunInput] = useState('');
  const loaded = useRef(false);

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
            data: node.data as WorkshopNode['data'],
          })),
        );
        setEdges(
          document.edges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed },
            data: { edgeType: edge.type },
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
              ...(update.summary ? { lastRunSummary: update.summary } : {}),
              ...(update.changedFiles === undefined ? {} : { changedFiles: update.changedFiles }),
            },
          };
        }),
      );
      const activity = update.activity;
      if (activity) {
        setEvents((items) => [activity, ...items].slice(0, 80));
      }
    });
  }, []);

  useEffect(() => {
    if (drawerTab !== 'audit') return;
    let current = true;
    setAuditState('loading');
    void window.forgeboard.audit
      .list({ limit: 100 })
      .then((result) => {
        if (!current) return;
        setAuditEvents(unwrap(result));
        setAuditState('idle');
      })
      .catch(() => {
        if (current) setAuditState('error');
      });
    return () => {
      current = false;
    };
  }, [auditRefresh, drawerTab]);

  useEffect(() => {
    if (!canvas || !loaded.current) return;
    setSaveState('saving');
    const timer = window.setTimeout(() => {
      const next: CanvasDocument = {
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
          type: edge.data?.edgeType ?? 'context',
        })),
        viewport: instance?.getViewport() ?? canvas.viewport,
        updatedAt: new Date().toISOString(),
      };
      void window.forgeboard.canvas
        .save(next)
        .then((result) => {
          unwrap(result);
          setSaveState('saved');
        })
        .catch(() => setSaveState('error'));
    }, settings.autosaveIntervalMs);
    return () => window.clearTimeout(timer);
  }, [canvas, edges, instance, nodes, settings.autosaveIntervalMs]);

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
  });

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

  const addNode = useCallback(
    (kind: NodeKind, position?: { x: number; y: number }) => {
      record();
      const definition = NODE_DEFINITIONS[kind];
      const id = crypto.randomUUID();
      const offset = nodes.length * 24;
      setNodes((items) => [
        ...items,
        {
          id,
          type: 'workshop',
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
      setEvents((items) => [`Added ${definition.label} node.`, ...items].slice(0, 30));
    },
    [nodes.length, record],
  );

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const runnableAgents = agents.filter(
    (agent): agent is AgentDetection & { id: RunAdapterId } =>
      agent.installed && isRunAdapterId(agent.id),
  );
  const selectedAdapter = selectedNode
    ? (selectedNode.data.adapterId ??
      (isRunAdapterId(settings.defaultAgent) ? settings.defaultAgent : 'test-agent'))
    : 'test-agent';
  const selectedPermission = selectedNode
    ? (selectedNode.data.permissionProfile ??
      (settings.defaultPermissionProfile === 'plan-read-only'
        ? 'plan-read-only'
        : 'worktree-write'))
    : 'worktree-write';
  const filteredTemplates = NODE_KINDS.filter((kind) =>
    NODE_DEFINITIONS[kind].label.toLowerCase().includes(search.toLowerCase()),
  );
  const filteredNodes = nodes.filter((node) =>
    `${node.data.title} ${NODE_DEFINITIONS[node.data.kind].label}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const changeReports = nodes.flatMap((node) => {
    const files = node.data.changedFiles ?? [];
    return files.length
      ? [{ nodeId: node.id, title: node.data.title, status: node.data.status, files }]
      : [];
  });
  const checkCommands = [
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
  ] as const;

  function onNodesChange(changes: NodeChange<WorkshopNode>[]) {
    setNodes((items) => applyNodeChanges(changes, items));
  }
  function onEdgesChange(changes: EdgeChange<WorkshopEdge>[]) {
    if (changes.some((change) => change.type === 'remove')) record();
    setEdges((items) => applyEdgeChanges(changes, items));
  }
  function onConnect(connection: Connection) {
    record();
    setEdges((items) =>
      addEdge(
        {
          ...connection,
          id: crypto.randomUUID(),
          type: 'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { edgeType: 'context' },
          label: 'context',
        },
        items,
      ),
    );
    setEvents((items) => ['Connected nodes with a context edge.', ...items].slice(0, 30));
  }
  function updateSelected(data: Partial<WorkshopNode['data']>) {
    if (!selectedNode) return;
    setNodes((items) =>
      items.map((node) =>
        node.id === selectedNode.id ? { ...node, data: { ...node.data, ...data } } : node,
      ),
    );
  }
  function updateNodeData(nodeId: string, data: Partial<WorkshopNode['data']>) {
    setNodes((items) =>
      items.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node,
      ),
    );
  }
  function duplicateSelected() {
    if (!selectedNode) return;
    record();
    const id = crypto.randomUUID();
    setNodes((items) => [
      ...items,
      {
        ...selectedNode,
        id,
        position: { x: selectedNode.position.x + 32, y: selectedNode.position.y + 32 },
        selected: false,
        data: { ...selectedNode.data, title: `${selectedNode.data.title} copy` },
      },
    ]);
    setSelectedNodeId(id);
  }
  function deleteSelected() {
    if (!selectedNode) return;
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
        edge.id === selectedEdge.id ? { ...edge, label: edgeType, data: { edgeType } } : edge,
      ),
    );
  }

  async function prepareSelectedRun() {
    if (!selectedNode) return;
    const prompt = (selectedNode.data.prompt ?? selectedNode.data.description).trim();
    if (!prompt) {
      onError('Add a prompt before reviewing this run.');
      return;
    }
    setPreparingRun(true);
    updateNodeData(selectedNode.id, { status: 'queued', transcript: '', lastRunSummary: '' });
    try {
      const result = await window.forgeboard.runs.prepare({
        projectId: project.id,
        repositoryPath: project.path,
        nodeId: selectedNode.id,
        adapterId: selectedAdapter,
        prompt,
        permissionProfile: selectedPermission,
      });
      const next = unwrap(result);
      updateNodeData(selectedNode.id, { runId: next.runId, status: 'waiting' });
      setDisclosure(next);
      setEvents((items) =>
        [`Prepared ${next.provider}; waiting for explicit launch approval.`, ...items].slice(0, 80),
      );
    } catch (cause) {
      updateNodeData(selectedNode.id, { status: 'failed' });
      onError(cause instanceof Error ? cause.message : 'Could not prepare the agent run.');
    } finally {
      setPreparingRun(false);
    }
  }

  async function approvePreparedRun() {
    if (!disclosure) return;
    setApprovingRun(true);
    try {
      unwrap(await window.forgeboard.runs.approve(disclosure.runId));
      updateNodeData(disclosure.nodeId, { status: 'running' });
      setEvents((items) =>
        [`Approved and launched ${disclosure.provider} in ${disclosure.cwd}.`, ...items].slice(
          0,
          80,
        ),
      );
      setDisclosure(null);
    } catch (cause) {
      updateNodeData(disclosure.nodeId, { status: 'failed' });
      onError(cause instanceof Error ? cause.message : 'The approved agent could not launch.');
    } finally {
      setApprovingRun(false);
    }
  }

  async function cancelPreparedRun() {
    if (!disclosure) return;
    try {
      unwrap(await window.forgeboard.runs.terminate(disclosure.runId));
      updateNodeData(disclosure.nodeId, { status: 'cancelled' });
      setDisclosure(null);
      setEvents((items) => ['Cancelled the prepared run before launch.', ...items].slice(0, 80));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not cancel the prepared run.');
    }
  }

  async function controlRun(action: 'interrupt' | 'terminate') {
    const runId = selectedNode?.data.runId;
    if (!runId || !selectedNode) return;
    try {
      const result =
        action === 'interrupt'
          ? await window.forgeboard.runs.interrupt(runId)
          : await window.forgeboard.runs.terminate(runId);
      unwrap(result);
      updateNodeData(selectedNode.id, { status: 'waiting' });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : `Could not ${action} this run.`);
    }
  }

  async function sendRunInput() {
    const runId = selectedNode?.data.runId;
    if (!runId || !runInput.trim()) return;
    try {
      unwrap(await window.forgeboard.runs.sendInput(runId, `${runInput}\n`));
      setRunInput('');
      setEvents((items) => ['Sent interactive input to the local agent.', ...items].slice(0, 80));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not send agent input.');
    }
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
      {
        id: 'fit',
        label: 'Fit canvas to content',
        section: 'View',
        shortcut: 'F',
        run: () =>
          void instance?.fitView({ padding: 0.18, duration: settings.reducedMotion ? 0 : 240 }),
      },
      {
        id: 'settings',
        label: 'Open settings',
        section: 'Application',
        shortcut: '⌘,',
        run: onOpenSettings,
      },
      { id: 'close', label: 'Close project', section: 'Project', run: onClose },
    ],
    [addNode, instance, onClose, onOpenSettings, settings.reducedMotion],
  );

  return (
    <main className="workspace-shell">
      <header className="command-bar">
        <div className="window-drag-space" />
        <button className="project-switcher" type="button" onClick={onClose}>
          <span className="brand-mark tiny">F</span>
          <span>
            <strong>{project.name}</strong>
            <small>{canvas?.name ?? 'Loading canvas'}</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <span className="toolbar-separator" />
        <button
          className="icon-button"
          type="button"
          onClick={undo}
          disabled={!past.length}
          aria-label="Undo"
        >
          <Undo2 size={16} />
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={redo}
          disabled={!future.length}
          aria-label="Redo"
        >
          <Redo2 size={16} />
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={() =>
            void instance?.fitView({ padding: 0.18, duration: settings.reducedMotion ? 0 : 240 })
          }
          aria-label="Fit canvas"
        >
          <Maximize2 size={16} />
        </button>
        <div className="command-spacer" />
        <span className={`autosave-state ${saveState}`}>
          <CircleDot size={12} />
          {saveState === 'saved' ? 'Saved locally' : saveState}
        </span>
        <div className="agent-activity">
          <span className="avatar-stack">
            {agents
              .filter((agent) => agent.installed)
              .slice(0, 3)
              .map((agent) => (
                <span key={agent.id}>{agent.label[0]}</span>
              ))}
          </span>
          <small>local tools</small>
        </div>
        <button className="command-trigger" type="button" onClick={() => setPaletteOpen(true)}>
          <Command size={14} /> Commands <kbd>⌘K</kbd>
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="Notifications"
          aria-expanded={notificationsOpen}
          title="Local notifications"
          onClick={() => setNotificationsOpen((open) => !open)}
        >
          <Bell size={16} />
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <Settings size={16} />
        </button>
      </header>

      <div className={`workspace-grid ${activityOpen ? '' : 'activity-closed'}`}>
        <aside className="project-rail">
          <div className="rail-tabs">
            <button
              className={railTab === 'project' ? 'active' : ''}
              type="button"
              onClick={() => setRailTab('project')}
            >
              <Files size={15} /> Project
            </button>
            <button
              className={railTab === 'nodes' ? 'active' : ''}
              type="button"
              onClick={() => setRailTab('nodes')}
            >
              <Layers3 size={15} /> Nodes
            </button>
          </div>
          <div className="rail-search">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={railTab === 'project' ? 'Find node templates' : 'Find canvas nodes'}
            />
          </div>
          {railTab === 'project' ? (
            <>
              <section className="repository-summary">
                <header>
                  <GitBranch size={14} />
                  <strong>{project.health.branch ?? 'Not a Git repository'}</strong>
                  <span className={project.health.dirty ? 'dirty-dot' : 'clean-dot'} />
                </header>
                <small>{project.path}</small>
                {project.health.frameworks.length > 0 && (
                  <div>
                    {project.health.frameworks.map((framework) => (
                      <span key={framework}>{framework}</span>
                    ))}
                  </div>
                )}
              </section>
              <section className="template-section">
                <header>
                  <h2>Node templates</h2>
                  <span>{filteredTemplates.length}</span>
                </header>
                <div className="template-list">
                  {filteredTemplates.map((kind) => {
                    const definition = NODE_DEFINITIONS[kind];
                    const Icon = definition.icon;
                    return (
                      <button
                        type="button"
                        key={kind}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData('application/x-forgeboard-node', kind);
                          event.dataTransfer.effectAllowed = 'copy';
                        }}
                        onClick={() => addNode(kind)}
                      >
                        <span style={{ color: definition.color }}>
                          <Icon size={15} />
                        </span>
                        <span>
                          <strong>{definition.label}</strong>
                          <small>{definition.description}</small>
                        </span>
                        <ChevronRight size={13} />
                      </button>
                    );
                  })}
                </div>
              </section>
            </>
          ) : (
            <section className="rail-node-section">
              <header>
                <h2>Canvas nodes</h2>
                <span>{filteredNodes.length}</span>
              </header>
              <div className="rail-node-list">
                {filteredNodes.map((node) => {
                  const definition = NODE_DEFINITIONS[node.data.kind];
                  const Icon = definition.icon;
                  return (
                    <button
                      type="button"
                      key={node.id}
                      onClick={() => {
                        setSelectedNodeId(node.id);
                        void instance?.setCenter(node.position.x, node.position.y, {
                          zoom: 1.15,
                          duration: settings.reducedMotion ? 0 : 220,
                        });
                      }}
                    >
                      <span style={{ color: node.data.color }}>
                        <Icon size={14} />
                      </span>
                      <span>
                        <strong>{node.data.title}</strong>
                        <small>{definition.label}</small>
                      </span>
                      <span className={`run-status ${node.data.status}`} title={node.data.status} />
                    </button>
                  );
                })}
                {!filteredNodes.length && <p>No matching nodes on this canvas.</p>}
              </div>
            </section>
          )}
          <footer>
            <ShieldStatus project={project} />
          </footer>
        </aside>

        <section
          className="canvas-region"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(event) => {
            event.preventDefault();
            const kind = event.dataTransfer.getData('application/x-forgeboard-node') as NodeKind;
            if (!NODE_KINDS.includes(kind)) return;
            const position = instance?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
            addNode(kind, position);
          }}
        >
          {canvas ? (
            <ReactFlow<WorkshopNode, WorkshopEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={WORKSHOP_NODE_TYPES}
              onInit={setInstance}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeDragStart={record}
              onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => {
                setSelectedNodeId(selectedNodes[0]?.id ?? null);
                setSelectedEdgeId(selectedEdges[0]?.id ?? null);
              }}
              fitView
              snapToGrid={settings.canvasSnapToGrid}
              snapGrid={[settings.canvasGridSize, settings.canvasGridSize]}
              minZoom={0.15}
              maxZoom={2.5}
              deleteKeyCode={['Backspace', 'Delete']}
              multiSelectionKeyCode={['Meta', 'Control']}
              selectionOnDrag
              panOnScroll
              defaultEdgeOptions={{
                type: 'smoothstep',
                markerEnd: { type: MarkerType.ArrowClosed },
              }}
            >
              <Background
                color="var(--canvas-grid)"
                gap={20}
                size={1}
                variant={BackgroundVariant.Dots}
              />
              <Controls position="bottom-left" showInteractive={false} />
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                nodeColor={(node) =>
                  typeof node.data.color === 'string' ? node.data.color : '#82909b'
                }
                maskColor="var(--minimap-mask)"
              />
              <Panel position="top-left" className="canvas-title">
                <LayoutGrid size={14} />
                <span>{canvas.name}</span>
                <small>
                  {nodes.length} nodes · {edges.length} connections
                </small>
              </Panel>
              {nodes.length === 0 && (
                <Panel position="top-center" className="canvas-empty">
                  <span className="empty-orbit">
                    <Bot size={22} />
                  </span>
                  <h2>Shape the work before it runs</h2>
                  <p>
                    Add a brief, task, and agent from the rail. Connect them to make context and
                    dependencies explicit.
                  </p>
                  <div>
                    <button
                      type="button"
                      className="button primary"
                      onClick={() => addNode('brief')}
                    >
                      Add a product brief
                    </button>
                    <button type="button" className="button" onClick={() => addNode('task')}>
                      Add a task
                    </button>
                  </div>
                </Panel>
              )}
            </ReactFlow>
          ) : (
            <div className="canvas-loading">Loading local canvas…</div>
          )}
        </section>

        <aside className="inspector">
          <header>
            <div>
              <span>Inspector</span>
              <small>
                {selectedNode
                  ? NODE_DEFINITIONS[selectedNode.data.kind].label
                  : selectedEdge
                    ? 'Connection'
                    : 'Canvas'}
              </small>
            </div>
            {(selectedNode || selectedEdge) && (
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  setSelectedNodeId(null);
                  setSelectedEdgeId(null);
                }}
                aria-label="Clear selection"
              >
                <X size={15} />
              </button>
            )}
          </header>
          {selectedNode ? (
            <div className="inspector-content">
              <label>
                Title
                <input
                  value={selectedNode.data.title}
                  onFocus={record}
                  onChange={(event) => updateSelected({ title: event.target.value })}
                />
              </label>
              <label>
                Description
                <textarea
                  rows={4}
                  value={selectedNode.data.description}
                  onFocus={record}
                  onChange={(event) => updateSelected({ description: event.target.value })}
                />
              </label>
              <label>
                Accent colour
                <input
                  type="color"
                  value={selectedNode.data.color}
                  onFocus={record}
                  onChange={(event) => updateSelected({ color: event.target.value })}
                />
              </label>
              {selectedNode.data.kind === 'agent' && (
                <section className="agent-run-config" aria-label="Agent run configuration">
                  <header>
                    <div>
                      <Bot size={14} />
                      <h3>Agent run</h3>
                    </div>
                    <span>Approval required</span>
                  </header>
                  <label>
                    Installed adapter
                    <select
                      value={selectedAdapter}
                      disabled={selectedNode.data.status === 'running'}
                      onChange={(event) =>
                        updateSelected({ adapterId: event.target.value as RunAdapterId })
                      }
                    >
                      {runnableAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.label} {agent.version ? `(${agent.version})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Permission profile
                    <select
                      value={selectedPermission}
                      disabled={selectedNode.data.status === 'running'}
                      onChange={(event) =>
                        updateSelected({
                          permissionProfile: event.target.value as
                            | 'plan-read-only'
                            | 'worktree-write',
                        })
                      }
                    >
                      <option value="plan-read-only">
                        Plan only · primary checkout · no writes
                      </option>
                      <option value="worktree-write">Worktree write · isolated branch</option>
                    </select>
                  </label>
                  <label>
                    Prompt
                    <textarea
                      rows={6}
                      value={selectedNode.data.prompt ?? selectedNode.data.description}
                      disabled={selectedNode.data.status === 'running'}
                      placeholder="Describe the concrete outcome for this agent…"
                      onChange={(event) => updateSelected({ prompt: event.target.value })}
                    />
                  </label>
                  {selectedNode.data.status === 'running' ? (
                    <div className="live-run-controls">
                      <div>
                        <input
                          value={runInput}
                          placeholder="Send interactive input"
                          aria-label="Agent input"
                          onChange={(event) => setRunInput(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void sendRunInput();
                          }}
                        />
                        <button type="button" onClick={() => void sendRunInput()}>
                          Send
                        </button>
                      </div>
                      <button type="button" onClick={() => void controlRun('interrupt')}>
                        <Square size={12} /> Interrupt
                      </button>
                      <button
                        type="button"
                        className="danger-text"
                        onClick={() => void controlRun('terminate')}
                      >
                        <Trash2 size={12} /> Terminate
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="button primary review-run-button"
                      disabled={preparingRun || runnableAgents.length === 0}
                      onClick={() => void prepareSelectedRun()}
                    >
                      <ShieldCheck size={14} />
                      {preparingRun ? 'Preparing exact launch…' : 'Review & run'}
                    </button>
                  )}
                  <p>
                    Nothing launches from this button alone. Forgeboard first shows the exact
                    command, folder, context, environment names, and permissions for approval.
                  </p>
                </section>
              )}
              <div className="inspector-actions">
                <button
                  type="button"
                  onClick={() => {
                    record();
                    updateSelected({ locked: !selectedNode.data.locked });
                  }}
                >
                  {selectedNode.data.locked ? <Unlock size={14} /> : <Lock size={14} />}
                  {selectedNode.data.locked ? 'Unlock' : 'Lock'}
                </button>
                <button type="button" onClick={duplicateSelected}>
                  <Copy size={14} />
                  Duplicate
                </button>
                <button type="button" className="danger-text" onClick={deleteSelected}>
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
              <section className="context-box">
                <header>
                  <h3>Context attachments</h3>
                  <span>0</span>
                </header>
                <p>
                  Drop an approved file, brief, diagram, or task onto this node. Exact attachments
                  are reviewed before any agent launch.
                </p>
              </section>
              <section className="run-history">
                <header>
                  <History size={14} />
                  <h3>Run history</h3>
                </header>
                {selectedNode.data.transcript ? (
                  <pre>{selectedNode.data.transcript}</pre>
                ) : (
                  <p>No runs yet. Forgeboard never fabricates agent output.</p>
                )}
                {selectedNode.data.lastRunSummary && (
                  <strong>{selectedNode.data.lastRunSummary}</strong>
                )}
              </section>
            </div>
          ) : selectedEdge ? (
            <div className="inspector-content">
              <label>
                Connection behavior
                <select
                  value={selectedEdge.data?.edgeType ?? 'context'}
                  onChange={(event) => updateEdgeType(event.target.value as EdgeKind)}
                >
                  <option value="context">Context</option>
                  <option value="execute">Execute</option>
                  <option value="output">Output</option>
                  <option value="review">Review</option>
                  <option value="revision">Revision</option>
                  <option value="dependency">Dependency</option>
                </select>
              </label>
              <div className="edge-explanation">
                <strong>{selectedEdge.data?.edgeType ?? 'context'}</strong>
                <p>{edgeExplanation(selectedEdge.data?.edgeType ?? 'context')}</p>
              </div>
            </div>
          ) : (
            <div className="inspector-empty">
              <LayoutGrid size={22} />
              <h3>Nothing selected</h3>
              <p>Select a node or connection to configure its local behavior.</p>
              <dl>
                <div>
                  <dt>Canvas</dt>
                  <dd>{canvas?.name}</dd>
                </div>
                <div>
                  <dt>Grid</dt>
                  <dd>
                    {settings.canvasSnapToGrid
                      ? `${settings.canvasGridSize} px snap`
                      : 'Free placement'}
                  </dd>
                </div>
                <div>
                  <dt>Storage</dt>
                  <dd>Local SQLite</dd>
                </div>
              </dl>
            </div>
          )}
        </aside>

        <section className="activity-drawer">
          <header>
            <div className="activity-tabs" role="tablist" aria-label="Workspace details">
              <button
                className={drawerTab === 'activity' ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={drawerTab === 'activity'}
                onClick={() => setDrawerTab('activity')}
              >
                <Activity size={14} /> Activity
              </button>
              <button
                className={drawerTab === 'changes' ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={drawerTab === 'changes'}
                onClick={() => setDrawerTab('changes')}
              >
                <GitBranch size={14} /> Changes
              </button>
              <button
                className={drawerTab === 'checks' ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={drawerTab === 'checks'}
                onClick={() => setDrawerTab('checks')}
              >
                <CheckCircle2 size={14} /> Checks
              </button>
              <button
                className={drawerTab === 'audit' ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={drawerTab === 'audit'}
                onClick={() => setDrawerTab('audit')}
              >
                <ShieldCheck size={14} /> Audit
              </button>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={() => setActivityOpen(false)}
              aria-label="Close activity drawer"
            >
              <PanelBottomClose size={16} />
            </button>
          </header>
          {drawerTab === 'activity' && (
            <div className="event-stream" role="tabpanel" aria-label="Activity">
              {events.map((event, index) => (
                <div key={`${event}-${index}`}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <p>{event}</p>
                  <small>local</small>
                </div>
              ))}
            </div>
          )}
          {drawerTab === 'changes' && (
            <div className="drawer-panel" role="tabpanel" aria-label="Changes">
              <header className="drawer-panel-summary">
                <div>
                  <strong>Run-reported file changes</strong>
                  <small>Persisted on the agent node from its latest run summary.</small>
                </div>
                <span>
                  {changeReports.reduce((total, report) => total + report.files.length, 0)} files
                </span>
              </header>
              {changeReports.length ? (
                <div className="change-report-list">
                  {changeReports.map((report) => (
                    <article key={report.nodeId}>
                      <header>
                        <strong>{report.title}</strong>
                        <span className={`drawer-status ${report.status}`}>{report.status}</span>
                      </header>
                      <ul>
                        {report.files.map((file) => (
                          <li key={file}>
                            <FileCode2 size={12} /> <code>{file}</code>
                          </li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              ) : (
                <DrawerEmpty>No completed run has reported file changes.</DrawerEmpty>
              )}
            </div>
          )}
          {drawerTab === 'checks' && (
            <div className="drawer-panel" role="tabpanel" aria-label="Checks">
              <header className="drawer-panel-summary">
                <div>
                  <strong>Configured project checks</strong>
                  <small>Configuration only; this view never assumes a command has run.</small>
                </div>
              </header>
              <div className="check-command-list">
                {checkCommands.map(({ id, label, command, detectedScript }) => {
                  const configured = command.executable.trim().length > 0;
                  return (
                    <article key={id}>
                      <header>
                        <strong>{label}</strong>
                        <span className={`check-state ${configured ? 'not-run' : 'unconfigured'}`}>
                          {configured ? 'Not run' : 'Not configured'}
                        </span>
                      </header>
                      {configured ? (
                        <code>{formatCommand(command.executable, command.arguments)}</code>
                      ) : detectedScript ? (
                        <small>
                          Project script detected: <code>{detectedScript}</code>. Choose it in
                          Settings before running.
                        </small>
                      ) : (
                        <small>Configure this command in Settings.</small>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          )}
          {drawerTab === 'audit' && (
            <div className="drawer-panel" role="tabpanel" aria-label="Audit">
              <header className="drawer-panel-summary">
                <div>
                  <strong>Local audit log</strong>
                  <small>Newest first. Secret-bearing metadata is not exposed to this view.</small>
                </div>
                <button type="button" onClick={() => setAuditRefresh((value) => value + 1)}>
                  Refresh
                </button>
              </header>
              {auditState === 'loading' && !auditEvents.length ? (
                <DrawerEmpty>Loading local audit events…</DrawerEmpty>
              ) : auditState === 'error' ? (
                <DrawerEmpty>Forgeboard could not read the local audit log.</DrawerEmpty>
              ) : auditEvents.length ? (
                <div className="audit-event-list">
                  {auditEvents.map((event) => (
                    <article key={event.sequence}>
                      <time dateTime={event.occurredAt}>
                        {new Date(event.occurredAt).toLocaleString()}
                      </time>
                      <strong>{event.category}</strong>
                      <span>{event.action}</span>
                      <small className={`audit-outcome ${event.outcome}`}>{event.outcome}</small>
                    </article>
                  ))}
                </div>
              ) : (
                <DrawerEmpty>No local audit events have been recorded yet.</DrawerEmpty>
              )}
            </div>
          )}
        </section>
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
        <section className="notification-popover" aria-label="Local notifications">
          <header>
            <strong>Local notifications</strong>
            <button
              type="button"
              onClick={() => setNotificationsOpen(false)}
              aria-label="Close notifications"
            >
              <X size={13} />
            </button>
          </header>
          {events.slice(0, 6).map((event, index) => (
            <p key={`${event}-${index}`}>{event}</p>
          ))}
        </section>
      )}
      {disclosure && (
        <RunApprovalDialog
          disclosure={disclosure}
          prompt={
            nodes.find((node) => node.id === disclosure.nodeId)?.data.prompt ??
            nodes.find((node) => node.id === disclosure.nodeId)?.data.description ??
            ''
          }
          busy={approvingRun}
          onCancel={() => void cancelPreparedRun()}
          onApprove={() => void approvePreparedRun()}
        />
      )}
    </main>
  );
}

interface RunApprovalDialogProps {
  disclosure: RunDisclosure;
  prompt: string;
  busy: boolean;
  onCancel: () => void;
  onApprove: () => void;
}

function DrawerEmpty({ children }: { children: string }) {
  return <p className="drawer-empty">{children}</p>;
}

function RunApprovalDialog({
  disclosure,
  prompt,
  busy,
  onCancel,
  onApprove,
}: RunApprovalDialogProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal run-approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-approval-title"
      >
        <header>
          <span className="modal-title-icon">
            <ShieldCheck size={19} />
          </span>
          <div>
            <span className="eyebrow">Human approval gate</span>
            <h2 id="run-approval-title">Review the exact agent launch</h2>
            <p>Forgeboard has prepared this run, but no agent process has started.</p>
          </div>
        </header>
        <div className="run-disclosure-scroll">
          {disclosure.primaryWasDirty && (
            <div className="run-warning">
              The primary checkout already has changes. This run uses the disclosed location and
              does not silently overwrite them.
            </div>
          )}
          {disclosure.warnings.map((warning) => (
            <div className="run-warning" key={warning}>
              {warning}
            </div>
          ))}
          <dl className="run-disclosure-grid">
            <div>
              <dt>Provider</dt>
              <dd>{disclosure.provider}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>{disclosure.runtime.toUpperCase()}</dd>
            </div>
            <div className="wide">
              <dt>Executable and arguments</dt>
              <dd>
                <code>{formatCommand(disclosure.executable, disclosure.arguments)}</code>
              </dd>
            </div>
            <div className="wide">
              <dt>Working directory</dt>
              <dd>
                <code>{disclosure.cwd}</code>
              </dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{disclosure.branch ?? 'Current checkout'}</dd>
            </div>
            <div>
              <dt>Base commit</dt>
              <dd>
                <code>{disclosure.baseCommit?.slice(0, 12) ?? 'Not available'}</code>
              </dd>
            </div>
            <div className="wide">
              <dt>Prompt</dt>
              <dd className="prompt-preview">{prompt}</dd>
            </div>
            <div className="wide">
              <dt>Permission enforcement</dt>
              <dd>
                <strong>{disclosure.permissionProfile.name}</strong> ·{' '}
                {disclosure.permissionProfile.mode} · {disclosure.permissionProfile.enforcement}
                <br />
                Read: {disclosure.permissionProfile.readRoots.join(', ') || 'none'}
                <br />
                Write: {disclosure.permissionProfile.writeRoots.join(', ') || 'none'}
                <br />
                Network: {disclosure.permissionProfile.network}
              </dd>
            </div>
            <div className="wide">
              <dt>Environment variable names</dt>
              <dd>
                {disclosure.environmentVariableNames.length
                  ? disclosure.environmentVariableNames.join(', ')
                  : 'No inherited variables'}
              </dd>
            </div>
            <div className="wide">
              <dt>Context attachments</dt>
              <dd>
                {disclosure.contextAttachments.length
                  ? disclosure.contextAttachments
                      .map((attachment) => `${attachment.kind}: ${attachment.path}`)
                      .join(', ')
                  : 'None'}
              </dd>
            </div>
          </dl>
        </div>
        <footer>
          <button className="button" type="button" disabled={busy} onClick={onCancel}>
            Cancel before launch
          </button>
          <button className="button primary" type="button" disabled={busy} onClick={onApprove}>
            <Play size={14} /> {busy ? 'Launching…' : 'Approve & launch'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ShieldStatus({ project }: { project: Project }) {
  return (
    <div className="rail-safety">
      <span className={project.health.sensitiveWarnings.length ? 'warning' : 'safe'}>
        {project.health.sensitiveWarnings.length ? '!' : '✓'}
      </span>
      <div>
        <strong>
          {project.health.sensitiveWarnings.length
            ? 'Sensitive files protected'
            : 'Context guard active'}
        </strong>
        <small>
          {project.health.sensitiveWarnings.length
            ? `${project.health.sensitiveWarnings.length} warning${project.health.sensitiveWarnings.length === 1 ? '' : 's'} found`
            : 'Ignored and credential files excluded'}
        </small>
      </div>
    </div>
  );
}

function edgeExplanation(kind: EdgeKind): string {
  return {
    context: 'Offers the source as explicit context. It is not attached until launch review.',
    execute: 'Allows source completion to queue the destination after its approval rules pass.',
    output: 'Publishes a branch, diff, preview, check result, or artifact to the destination.',
    review: 'Routes source output to a reviewer and records structured findings.',
    revision: 'Returns actionable failed-review feedback through a bounded retry loop.',
    dependency: 'Blocks the destination task until the upstream task succeeds.',
  }[kind];
}

function isRunAdapterId(value: string): value is RunAdapterId {
  return ['test-agent', 'codex', 'claude', 'gemini', 'opencode'].includes(value);
}

function formatCommand(executable: string, arguments_: string[]): string {
  return [executable, ...arguments_]
    .map((part) => (/^[A-Za-z0-9_./:=@+-]+$/u.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

interface RunEventUpdate {
  status?: WorkshopNode['data']['status'];
  transcript?: string;
  summary?: string;
  activity?: string;
  changedFiles?: string[];
}

function summarizeRunEvent(event: RunEventEnvelope): RunEventUpdate {
  const payload = asRecord(event.payload);
  if (event.kind === 'run-error') {
    const message = typeof payload?.message === 'string' ? payload.message : 'Agent run failed.';
    return { status: 'failed', summary: message, activity: message };
  }
  if (event.kind === 'run-summary') {
    const status = typeof payload?.status === 'string' ? payload.status : 'failed';
    const changedFiles = Array.isArray(payload?.changedFiles)
      ? payload.changedFiles.filter((value): value is string => typeof value === 'string')
      : [];
    const summary = `${status}${
      changedFiles.length
        ? ` · ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}`
        : ' · no file changes'
    }`;
    return {
      status: runStatus(status),
      summary,
      activity: `Run ${summary}.`,
      changedFiles,
    };
  }

  const type = typeof payload?.type === 'string' ? payload.type : '';
  if (type === 'lifecycle') {
    const phase = typeof payload?.phase === 'string' ? payload.phase : 'updated';
    const status =
      phase === 'starting' || phase === 'running'
        ? 'running'
        : phase === 'interrupting' || phase === 'terminating'
          ? 'waiting'
          : undefined;
    return {
      ...(status ? { status } : {}),
      activity: `Agent ${phase}.`,
    };
  }
  if (type === 'stream') {
    const data = typeof payload?.data === 'string' ? payload.data : '';
    const trimmed = data.trim();
    return {
      ...(trimmed.startsWith('{') && trimmed.endsWith('}') ? {} : { transcript: data }),
      ...(trimmed ? { activity: `Agent output: ${trimmed.slice(0, 160)}` } : {}),
    };
  }
  if (type === 'message') {
    const message = asRecord(payload?.payload);
    if (message?.type === 'output' && typeof message.data === 'string') {
      return { transcript: message.data, activity: `Agent output: ${message.data.slice(0, 160)}` };
    }
    if (message?.type === 'file-written' && typeof message.path === 'string') {
      return { activity: `Agent wrote ${message.path}.` };
    }
    if (message?.type === 'input-requested' && typeof message.prompt === 'string') {
      return { status: 'waiting', activity: `Agent requested input: ${message.prompt}` };
    }
    return {};
  }
  if (type === 'result') {
    const result = asRecord(payload?.result);
    const status = typeof result?.status === 'string' ? result.status : 'failed';
    return { status: runStatus(status), activity: `Agent process ${status}.` };
  }
  return {};
}

function runStatus(value: string): WorkshopNode['data']['status'] {
  if (value === 'succeeded') return 'succeeded';
  if (value === 'interrupted' || value === 'terminated' || value === 'cancelled')
    return 'cancelled';
  return value === 'running' ? 'running' : 'failed';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
