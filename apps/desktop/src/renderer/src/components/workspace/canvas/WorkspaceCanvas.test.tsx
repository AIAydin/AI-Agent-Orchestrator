// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type CanvasDocument,
} from '../../../../../shared/application/contracts.js';
import type { WorkshopNode } from './CanvasNode.js';
import { WorkspaceCanvas } from './WorkspaceCanvas.js';

const mocks = vi.hoisted(() => ({ reactFlowProps: null as unknown }));

vi.mock('@xyflow/react', () => ({
  Background: ({ gap }: { gap: number }) => <output data-testid="grid-guide-gap">{gap}</output>,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => null,
  Handle: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  MiniMap: () => null,
  Panel: ({
    children,
    className,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    className?: string;
    'aria-label'?: string;
  }) => (
    <div className={className} aria-label={ariaLabel}>
      {children}
    </div>
  ),
  Position: { Bottom: 'bottom', Left: 'left', Right: 'right', Top: 'top' },
  ReactFlow: (props: Record<string, unknown>) => {
    mocks.reactFlowProps = props;
    return (
      <div
        data-testid="react-flow"
        onKeyDownCapture={props['onKeyDownCapture'] as React.KeyboardEventHandler<HTMLDivElement>}
      >
        <div className="react-flow__node" data-testid="focusable-node" tabIndex={0}>
          <input name="node-editor" aria-label="Node editor" />
        </div>
        {props['children'] as React.ReactNode}
      </div>
    );
  },
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(cleanup);

describe('WorkspaceCanvas keyboard and alignment interaction', () => {
  it('moves focused selections by the requested step and excludes editable node controls', () => {
    const onKeyboardMove = vi.fn(() => ({
      selectedNodeIds: ['dragged'],
      movedNodeIds: ['dragged'],
      lockedNodeIds: [],
    }));
    render(<WorkspaceCanvas {...props(onKeyboardMove)} />);

    fireEvent.keyDown(screen.getByTestId('focusable-node'), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    expect(onKeyboardMove).toHaveBeenLastCalledWith({ x: 10, y: 0 }, true);
    expect(screen.getByText(/Moved 1 selected node right 10 pixels/u)).toBeTruthy();

    fireEvent.keyDown(screen.getByTestId('focusable-node'), {
      key: 'ArrowDown',
      repeat: true,
    });
    expect(onKeyboardMove).toHaveBeenLastCalledWith({ x: 0, y: 1 }, false);

    fireEvent.keyDown(screen.getByLabelText('Node editor'), { key: 'ArrowLeft' });
    expect(onKeyboardMove).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByTestId('focusable-node'), {
      key: 'ArrowLeft',
      ctrlKey: true,
    });
    expect(onKeyboardMove).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Canvas keyboard shortcuts').textContent).toMatch(
      /Shift\+Arrows move 10 px/u,
    );
    const flowProps = mocks.reactFlowProps as {
      snapGrid: [number, number];
      nodesFocusable: boolean;
      autoPanOnNodeFocus: boolean;
      'aria-label': string;
    };
    expect(flowProps.snapGrid).toEqual([
      Number(screen.getByTestId('grid-guide-gap').textContent),
      Number(screen.getByTestId('grid-guide-gap').textContent),
    ]);
    expect(flowProps.nodesFocusable).toBe(true);
    expect(flowProps.autoPanOnNodeFocus).toBe(true);
    expect(flowProps['aria-label']).toBe('Canvas canvas');
  });

  it('renders viewport alignment guides only while a node is being dragged near a peer', () => {
    const view = render(<WorkspaceCanvas {...props(vi.fn())} />);
    const flowProps = mocks.reactFlowProps as {
      onNodeDrag: (event: unknown, node: WorkshopNode, nodes: WorkshopNode[]) => void;
      onNodeDragStop: () => void;
    };
    const [dragged] = nodes();
    if (dragged === undefined) throw new Error('Missing dragged test node.');

    act(() => flowProps.onNodeDrag({}, dragged, [dragged]));
    expect(view.container.querySelector('.canvas-alignment-guide.vertical')).not.toBeNull();
    expect(view.container.querySelector('.canvas-alignment-guide.horizontal')).not.toBeNull();

    act(() => flowProps.onNodeDragStop());
    expect(view.container.querySelector('.canvas-alignment-guide')).toBeNull();
  });

  it('disables graph mutation controls for reviewer and viewer collaboration roles', () => {
    const onKeyboardMove = vi.fn();
    render(<WorkspaceCanvas {...props(onKeyboardMove)} collaborationGraphReadOnly />);
    const flowProps = mocks.reactFlowProps as {
      nodesDraggable: boolean;
      nodesConnectable: boolean;
      deleteKeyCode: null | string[];
    };
    expect(flowProps.nodesDraggable).toBe(false);
    expect(flowProps.nodesConnectable).toBe(false);
    expect(flowProps.deleteKeyCode).toBeNull();
    fireEvent.keyDown(screen.getByTestId('focusable-node'), { key: 'ArrowRight' });
    expect(onKeyboardMove).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot edit the shared graph/u)).toBeTruthy();
  });
});

function props(
  onKeyboardMove: ReturnType<typeof vi.fn>,
): React.ComponentProps<typeof WorkspaceCanvas> {
  return {
    canvas: canvas(),
    nodes: nodes(),
    edges: [],
    settings: AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: '/tmp/worktrees',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      previewPortStart: 41_000,
      previewPortEnd: 41_999,
      transcriptRetentionDays: 30,
      collaborationEnabled: false,
      collaborationUrl: '',
    }),
    extensionTemplates: [],
    instance: {
      getZoom: () => 1,
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    } as React.ComponentProps<typeof WorkspaceCanvas>['instance'],
    onInstance: vi.fn(),
    onNodesChange: vi.fn(),
    onEdgesChange: vi.fn(),
    onConnect: vi.fn(),
    onNodeDragStart: vi.fn(),
    onKeyboardMove,
    onSelectionChange: vi.fn(),
    onAddNode: vi.fn(),
    onAddExtensionNode: vi.fn(),
    collaborationAwareness: [],
    onCollaborationCursorMove: vi.fn(),
    onCollaborationCursorLeave: vi.fn(),
    collaborationGraphReadOnly: false,
  };
}

function nodes(): WorkshopNode[] {
  return [node('dragged', 101, 99), node('target', 100, 100)];
}

function node(id: string, x: number, y: number): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x, y },
    width: 100,
    height: 50,
    data: {
      kind: 'task',
      title: id,
      description: id,
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
    },
  };
}

function canvas(): CanvasDocument {
  return {
    id: '70000000-0000-4000-8000-000000000002',
    projectId: '70000000-0000-4000-8000-000000000001',
    name: 'Canvas',
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: '2026-07-15T12:00:00.000Z',
  };
}
