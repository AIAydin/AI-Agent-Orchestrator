import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
} from '@xyflow/react';
import { Bot, LayoutGrid } from 'lucide-react';

import type { AppSettings, CanvasDocument } from '../../../../shared/contracts.js';
import {
  NODE_KINDS,
  WORKSHOP_NODE_TYPES,
  type NodeKind,
  type WorkshopNode,
} from '../CanvasNode.js';
import type { ExtensionTemplate, WorkshopEdge } from './types.js';

interface WorkspaceCanvasProps {
  canvas: CanvasDocument | null;
  nodes: WorkshopNode[];
  edges: WorkshopEdge[];
  settings: AppSettings;
  extensionTemplates: ExtensionTemplate[];
  instance: ReactFlowInstance<WorkshopNode, WorkshopEdge> | null;
  onInstance: (instance: ReactFlowInstance<WorkshopNode, WorkshopEdge>) => void;
  onNodesChange: (changes: NodeChange<WorkshopNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<WorkshopEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  onNodeDragStart: () => void;
  onSelectionChange: (selection: OnSelectionChangeParams<WorkshopNode, WorkshopEdge>) => void;
  onAddNode: (kind: NodeKind, position?: { x: number; y: number }) => void;
  onAddExtensionNode: (template: ExtensionTemplate, position?: { x: number; y: number }) => void;
}

export function WorkspaceCanvas({
  canvas,
  nodes,
  edges,
  settings,
  extensionTemplates,
  instance,
  onInstance,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeDragStart,
  onSelectionChange,
  onAddNode,
  onAddExtensionNode,
}: WorkspaceCanvasProps) {
  return (
    <section
      className="canvas-region"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(event) => {
        event.preventDefault();
        const extensionKey = event.dataTransfer.getData('application/x-forgeboard-extension-node');
        const position = instance?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        if (extensionKey) {
          const template = extensionTemplates.find(({ key }) => key === extensionKey);
          if (template) onAddExtensionNode(template, position);
          return;
        }
        const kind = event.dataTransfer.getData('application/x-forgeboard-node') as NodeKind;
        if (!(NODE_KINDS as readonly string[]).includes(kind)) return;
        onAddNode(kind, position);
      }}
    >
      {canvas ? (
        <ReactFlow<WorkshopNode, WorkshopEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={WORKSHOP_NODE_TYPES}
          onInit={onInstance}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={onNodeDragStart}
          onSelectionChange={onSelectionChange}
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
                <button type="button" className="button primary" onClick={() => onAddNode('brief')}>
                  Add a product brief
                </button>
                <button type="button" className="button" onClick={() => onAddNode('task')}>
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
  );
}
