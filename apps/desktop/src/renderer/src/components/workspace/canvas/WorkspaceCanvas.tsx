import { useState } from 'react';
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
  type OnNodeDrag,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
} from '@xyflow/react';
import { Bot, LayoutGrid } from 'lucide-react';

import type { AppSettings, CanvasDocument } from '../../../../../shared/application/contracts.js';
import type { CollaborationAwarenessEntry } from '../../../../../shared/collaboration/index.js';
import { NODE_KINDS, WORKSHOP_NODE_TYPES, type NodeKind, type WorkshopNode } from './CanvasNode.js';
import { CollaborationPresence } from '../collaboration/CollaborationPresence.js';
import { CollaboratorRoster } from '../collaboration/presence/CollaboratorRoster.js';
import {
  hasWorkspaceContextDrag,
  readWorkspaceContextDrag,
  type WorkspaceContextDragPayload,
} from '../context-dnd/contracts.js';
import { resolveFileNodeContextDrop } from '../context-dnd/node-drag-link.js';
import type { ExtensionTemplate, WorkshopEdge } from '../model/types.js';
import { initialWorkshopNodeDimensions } from '../model/node-persistence.js';
import { AlignmentGuides } from './interactions/AlignmentGuides.js';
import {
  alignmentGuidesForDrag,
  type CanvasAlignmentGuides,
} from './interactions/alignment-guides.js';
import {
  keyboardMovementForKey,
  type CanvasKeyboardMovement,
  type CanvasKeyboardMoveSummary,
} from './interactions/keyboard-navigation.js';
import { visibleCanvasDropPosition } from './interactions/drop-position.js';
import { CanvasNodeInteractionProvider } from './interactions/CanvasNodeInteractionContext.js';

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
  onNodeDragStop: (node: WorkshopNode, draggedNodes: readonly WorkshopNode[]) => void;
  onSetNodeCollapsed: (nodeId: string, collapsed: boolean) => void;
  onNodeResizeStart: (nodeId: string) => void;
  onKeyboardMove: (
    movement: CanvasKeyboardMovement,
    recordUndoCheckpoint: boolean,
  ) => CanvasKeyboardMoveSummary;
  onSelectionChange: (selection: OnSelectionChangeParams<WorkshopNode, WorkshopEdge>) => void;
  onAddNode: (kind: NodeKind, position?: { x: number; y: number }) => void;
  onAddExtensionNode: (template: ExtensionTemplate, position?: { x: number; y: number }) => void;
  onAttachAgentContext: (
    targetNodeId: string,
    payload: WorkspaceContextDragPayload,
  ) => Promise<void>;
  onContextDropError: (message: string) => void;
  collaborationAwareness: readonly CollaborationAwarenessEntry[];
  onCollaborationCursorMove: (position: { readonly x: number; readonly y: number }) => void;
  onCollaborationCursorLeave: () => void;
  collaborationGraphReadOnly: boolean;
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
  onNodeDragStop: onWorkspaceNodeDragStop,
  onSetNodeCollapsed,
  onNodeResizeStart,
  onKeyboardMove,
  onSelectionChange,
  onAddNode,
  onAddExtensionNode,
  onAttachAgentContext,
  onContextDropError,
  collaborationAwareness,
  onCollaborationCursorMove,
  onCollaborationCursorLeave,
  collaborationGraphReadOnly,
}: WorkspaceCanvasProps) {
  const [alignmentGuides, setAlignmentGuides] = useState<CanvasAlignmentGuides>({});
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState({
    message: '',
    sequence: 0,
  });
  const onNodeDrag: OnNodeDrag<WorkshopNode> = (_event, node, draggedNodes) => {
    const activeNodes = (draggedNodes.length > 0 ? draggedNodes : [node]).filter(
      (activeNode) => !activeNode.data.locked,
    );
    const zoom = instance?.getZoom() ?? 1;
    setAlignmentGuides(alignmentGuidesForDrag(activeNodes, nodes, 6 / Math.max(zoom, 0.01)));
  };
  const onNodeDragStop: OnNodeDrag<WorkshopNode> = (_event, node, draggedNodes) => {
    setAlignmentGuides({});
    if (canvas === null || collaborationGraphReadOnly) return;
    onWorkspaceNodeDragStop(node, draggedNodes);
    const resolution = resolveFileNodeContextDrop({
      projectId: canvas.projectId,
      source: node,
      draggedNodes,
      nodes,
    });
    if (resolution === null) return;
    if (!resolution.ok) {
      onContextDropError(resolution.message);
      return;
    }
    void Promise.resolve()
      .then(() => onAttachAgentContext(resolution.targetNodeId, resolution.payload))
      .catch((cause: unknown) => {
        onContextDropError(
          cause instanceof Error ? cause.message : 'The File node could not be attached.',
        );
      });
  };

  return (
    <section
      className="canvas-region"
      onPointerMove={(event) => {
        const position = instance?.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });
        if (position !== undefined) onCollaborationCursorMove(position);
      }}
      onPointerLeave={onCollaborationCursorLeave}
      onDragOver={(event) => {
        if (hasWorkspaceContextDrag(event.dataTransfer)) {
          const target = contextDropTarget(event.target, nodes);
          if (
            collaborationGraphReadOnly ||
            target === null ||
            target.data.kind !== 'agent' ||
            target.data.locked
          ) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(event) => {
        if (hasWorkspaceContextDrag(event.dataTransfer)) {
          if (collaborationGraphReadOnly) {
            onContextDropError('This collaboration role cannot edit the shared graph.');
            return;
          }
          const payload = readWorkspaceContextDrag(event.dataTransfer);
          if (payload === null) {
            onContextDropError('That drag did not contain a valid Forgeboard project file.');
            return;
          }
          const target = contextDropTarget(event.target, nodes);
          if (target === null || target.data.kind !== 'agent') {
            onContextDropError('Project files can only be attached to an Agent node.');
            return;
          }
          if (target.data.locked) {
            onContextDropError('Unlock the Agent node before changing its context.');
            return;
          }
          event.preventDefault();
          void Promise.resolve()
            .then(() => onAttachAgentContext(target.id, payload))
            .catch((cause: unknown) => {
              onContextDropError(
                cause instanceof Error ? cause.message : 'The file could not be attached.',
              );
            });
          return;
        }
        event.preventDefault();
        if (collaborationGraphReadOnly) return;
        const extensionKey = event.dataTransfer.getData('application/x-forgeboard-extension-node');
        const dropPosition = (kind: NodeKind) =>
          instance === null
            ? undefined
            : visibleCanvasDropPosition({
                pointer: { x: event.clientX, y: event.clientY },
                canvasBounds: event.currentTarget.getBoundingClientRect(),
                nodeDimensions: initialWorkshopNodeDimensions(kind),
                screenToFlowPosition: (point, options) =>
                  instance.screenToFlowPosition(point, options),
              });
        if (extensionKey) {
          const template = extensionTemplates.find(({ key }) => key === extensionKey);
          if (template) onAddExtensionNode(template, dropPosition('extension'));
          return;
        }
        const kind = event.dataTransfer.getData('application/x-forgeboard-node') as NodeKind;
        if (!(NODE_KINDS as readonly string[]).includes(kind)) return;
        onAddNode(kind, dropPosition(kind));
      }}
    >
      {canvas ? (
        <CanvasNodeInteractionProvider
          readOnly={collaborationGraphReadOnly}
          setCollapsed={onSetNodeCollapsed}
          onResizeStart={onNodeResizeStart}
        >
          <ReactFlow<WorkshopNode, WorkshopEdge>
            aria-label={`${canvas.name} canvas`}
            nodes={nodes}
            edges={edges}
            nodeTypes={WORKSHOP_NODE_TYPES}
            onInit={onInstance}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={() => {
              setAlignmentGuides({});
              onNodeDragStart();
            }}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onSelectionChange={onSelectionChange}
            onKeyDownCapture={(event) => {
              const target = event.target;
              if (!(target instanceof Element)) return;
              if (
                target.closest('input, textarea, select, [contenteditable="true"]') !== null ||
                target.closest('.react-flow__node, .react-flow__nodesselection-rect') === null
              ) {
                return;
              }
              const movement = keyboardMovementForKey(event.key, event.shiftKey);
              if (movement === null) return;
              if (collaborationGraphReadOnly) {
                event.preventDefault();
                event.stopPropagation();
                setKeyboardAnnouncement(({ sequence }) => ({
                  message: 'This collaboration role cannot edit the shared graph.',
                  sequence: sequence + 1,
                }));
                return;
              }
              if (event.altKey || event.ctrlKey || event.metaKey) {
                event.stopPropagation();
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              const result = onKeyboardMove(movement, !event.repeat);
              const distance = Math.abs(movement.x || movement.y);
              const direction =
                movement.x < 0 ? 'left' : movement.x > 0 ? 'right' : movement.y < 0 ? 'up' : 'down';
              if (result.movedNodeIds.length > 0) {
                const lockedSuffix =
                  result.lockedNodeIds.length === 0
                    ? ''
                    : ` ${result.lockedNodeIds.length} locked selected node${
                        result.lockedNodeIds.length === 1 ? '' : 's'
                      } stayed in place.`;
                setKeyboardAnnouncement(({ sequence }) => ({
                  message: `Moved ${result.movedNodeIds.length} canvas node${
                    result.movedNodeIds.length === 1 ? '' : 's'
                  } ${direction} ${distance} pixel${distance === 1 ? '' : 's'}.${lockedSuffix}`,
                  sequence: sequence + 1,
                }));
              } else if (result.lockedNodeIds.length > 0) {
                setKeyboardAnnouncement(({ sequence }) => ({
                  message: 'Locked selected nodes cannot be moved.',
                  sequence: sequence + 1,
                }));
              } else {
                setKeyboardAnnouncement(({ sequence }) => ({
                  message: 'Press Enter or Space to select the focused node before moving it.',
                  sequence: sequence + 1,
                }));
              }
            }}
            fitView
            fitViewOptions={{ maxZoom: 1.25 }}
            nodesDraggable={!collaborationGraphReadOnly}
            nodesConnectable={!collaborationGraphReadOnly}
            nodesFocusable
            autoPanOnNodeFocus
            elevateNodesOnSelect={false}
            snapToGrid={settings.canvasSnapToGrid}
            snapGrid={[settings.canvasGridSize, settings.canvasGridSize]}
            minZoom={0.15}
            maxZoom={2.5}
            deleteKeyCode={collaborationGraphReadOnly ? null : ['Backspace', 'Delete']}
            multiSelectionKeyCode={['Meta', 'Control']}
            selectionOnDrag
            panOnScroll
            defaultEdgeOptions={{
              type: 'smoothstep',
              markerEnd: { type: MarkerType.ArrowClosed },
            }}
            ariaLabelConfig={{
              'node.a11yDescription.default':
                'Press Enter or Space to select a focused node. Arrow keys move selected unlocked nodes by one pixel; hold Shift to move ten pixels. Press Delete to remove an unlocked selection or Escape to cancel.',
              'node.a11yDescription.keyboardDisabled':
                'Press Enter or Space to select a focused node. Arrow keys move selected unlocked nodes by one pixel; hold Shift to move ten pixels. Press Delete to remove an unlocked selection or Escape to cancel.',
            }}
          >
            <Background
              color="var(--canvas-grid)"
              gap={settings.canvasGridSize}
              size={1}
              variant={BackgroundVariant.Dots}
            />
            <AlignmentGuides guides={alignmentGuides} zoom={instance?.getZoom() ?? 1} />
            <CollaborationPresence awareness={collaborationAwareness} nodes={nodes} />
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
            <Panel position="top-right">
              <CollaboratorRoster awareness={collaborationAwareness} />
            </Panel>
            <Panel
              position="bottom-center"
              className="canvas-keyboard-hint"
              aria-label="Canvas keyboard shortcuts"
            >
              Tab focus · Enter/Space select · Arrows move 1 px · Shift+Arrows move 10 px
            </Panel>
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              <span key={keyboardAnnouncement.sequence}>{keyboardAnnouncement.message}</span>
            </span>
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
                    disabled={collaborationGraphReadOnly}
                    onClick={() => onAddNode('brief')}
                  >
                    Add a product brief
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={collaborationGraphReadOnly}
                    onClick={() => onAddNode('task')}
                  >
                    Add a task
                  </button>
                </div>
              </Panel>
            )}
          </ReactFlow>
        </CanvasNodeInteractionProvider>
      ) : (
        <div className="canvas-loading">Loading local canvas…</div>
      )}
    </section>
  );
}

function contextDropTarget(
  eventTarget: EventTarget | null,
  nodes: readonly WorkshopNode[],
): WorkshopNode | null {
  if (!(eventTarget instanceof Element)) return null;
  const nodeElement = eventTarget.closest('.react-flow__node[data-id]');
  const nodeId = nodeElement?.getAttribute('data-id');
  if (nodeId === null || nodeId === undefined) return null;
  return nodes.find((node) => node.id === nodeId) ?? null;
}
