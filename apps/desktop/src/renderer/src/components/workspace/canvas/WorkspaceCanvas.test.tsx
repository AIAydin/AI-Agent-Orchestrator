// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type CanvasDocument,
} from '../../../../../shared/application/contracts.js';
import type { WorkshopNode } from './CanvasNode.js';
import { WorkspaceCanvas } from './WorkspaceCanvas.js';
import { WORKSPACE_CONTEXT_DRAG_MIME } from '../context-dnd/contracts.js';
import type { ExtensionTemplate } from '../model/types.js';
import { onTextEditRequest } from '../content/text/text-edit-bus.js';

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
    const renderedNodes = props['nodes'] as WorkshopNode[];
    return (
      <div
        data-testid="react-flow"
        onKeyDownCapture={props['onKeyDownCapture'] as React.KeyboardEventHandler<HTMLDivElement>}
        onContextMenu={(event) =>
          (
            props['onNodeContextMenu'] as
              | ((event: React.MouseEvent, node: WorkshopNode) => void)
              | undefined
          )?.(event, renderedNodes[0]!)
        }
      >
        <div className="react-flow__pane">
          {renderedNodes.map((node, index) => (
            <div
              className="react-flow__node"
              data-id={node.id}
              data-testid={index === 0 ? 'focusable-node' : `canvas-node-${node.id}`}
              key={node.id}
              tabIndex={0}
            >
              {index === 0 ? <input name="node-editor" aria-label="Node editor" /> : null}
            </div>
          ))}
          {props['children'] as React.ReactNode}
        </div>
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
    expect(screen.getByText(/Moved 1 canvas node right 10 pixels/u)).toBeTruthy();

    fireEvent.keyDown(screen.getByTestId('focusable-node'), {
      key: 'ArrowDown',
      repeat: true,
    });
    expect(onKeyboardMove).toHaveBeenLastCalledWith({ x: 0, y: 1 }, false);

    fireEvent.keyDown(screen.getByLabelText('Node editor'), {
      key: 'ArrowLeft',
    });
    expect(onKeyboardMove).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByTestId('focusable-node'), {
      key: 'ArrowLeft',
      ctrlKey: true,
    });
    expect(onKeyboardMove).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Canvas keyboard shortcuts').textContent).toMatch(
      /Context Menu\/Shift\+F10 actions/u,
    );
    const flowProps = mocks.reactFlowProps as {
      snapGrid: [number, number];
      nodesFocusable: boolean;
      autoPanOnNodeFocus: boolean;
      fitView?: boolean;
      defaultViewport: { x: number; y: number; zoom: number };
      'aria-label': string;
    };
    expect(flowProps.snapGrid).toEqual([
      Number(screen.getByTestId('grid-guide-gap').textContent),
      Number(screen.getByTestId('grid-guide-gap').textContent),
    ]);
    expect(flowProps.nodesFocusable).toBe(true);
    expect(flowProps.autoPanOnNodeFocus).toBe(true);
    expect(flowProps.fitView).toBeUndefined();
    expect(flowProps.defaultViewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(flowProps['aria-label']).toBe('Canvas canvas');
    expect(
      (mocks.reactFlowProps as { ariaLabelConfig: Record<string, string> }).ariaLabelConfig[
        'node.a11yDescription.default'
      ],
    ).toContain('Context Menu key or Shift+F10');
  });

  it('renders viewport alignment guides only while a node is being dragged near a peer', () => {
    const view = render(<WorkspaceCanvas {...props(vi.fn())} />);
    const flowProps = mocks.reactFlowProps as {
      onNodeDrag: (event: unknown, node: WorkshopNode, nodes: WorkshopNode[]) => void;
      onNodeDragStop: (event: unknown, node: WorkshopNode, nodes: WorkshopNode[]) => void;
    };
    const [dragged] = nodes();
    if (dragged === undefined) throw new Error('Missing dragged test node.');

    act(() => flowProps.onNodeDrag({}, dragged, [dragged]));
    expect(view.container.querySelector('.canvas-alignment-guide.vertical')).not.toBeNull();
    expect(view.container.querySelector('.canvas-alignment-guide.horizontal')).not.toBeNull();

    act(() => flowProps.onNodeDragStop({}, dragged, [dragged]));
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
    fireEvent.keyDown(screen.getByTestId('focusable-node'), {
      key: 'ArrowRight',
    });
    expect(onKeyboardMove).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot edit the shared canvas/u)).toBeTruthy();
  });

  it('reports a bounded completed viewport move for autosave but not for read-only roles', () => {
    const canvasProps = props(vi.fn());
    render(<WorkspaceCanvas {...canvasProps} />);
    const flowProps = mocks.reactFlowProps as {
      onMoveEnd: (event: unknown, viewport: { x: number; y: number; zoom: number }) => void;
    };

    act(() => flowProps.onMoveEnd({}, { x: -220, y: 48, zoom: 9 }));
    expect(canvasProps.onViewportChange).toHaveBeenCalledWith({
      x: -220,
      y: 48,
      zoom: 2.5,
    });

    cleanup();
    const readOnlyProps = props(vi.fn());
    readOnlyProps.collaborationGraphReadOnly = true;
    render(<WorkspaceCanvas {...readOnlyProps} />);
    const readOnlyFlowProps = mocks.reactFlowProps as typeof flowProps;
    act(() => readOnlyFlowProps.onMoveEnd({}, { x: 1, y: 2, zoom: 1.2 }));
    expect(readOnlyProps.onViewportChange).not.toHaveBeenCalled();
  });

  it('explicitly restores the saved viewport without fitting content', async () => {
    const canvasProps = props(vi.fn());
    if (canvasProps.canvas === null) throw new Error('Missing test canvas.');
    canvasProps.canvas = {
      ...canvasProps.canvas,
      viewport: { x: -310, y: 77, zoom: 1.6 },
    };
    render(<WorkspaceCanvas {...canvasProps} />);

    await waitFor(() =>
      expect(canvasProps.instance?.setViewport).toHaveBeenCalledWith(
        { x: -310, y: 77, zoom: 1.6 },
        { duration: 0 },
      ),
    );
    expect(mocks.reactFlowProps).not.toHaveProperty('fitView', true);
  });
});

describe('WorkspaceCanvas pane double-click text creation', () => {
  it('disables ReactFlow double-click-to-zoom so pane double-clicks are free to create nodes', () => {
    render(<WorkspaceCanvas {...props(vi.fn())} />);
    expect((mocks.reactFlowProps as { zoomOnDoubleClick: boolean }).zoomOnDoubleClick).toBe(false);
  });

  it('creates a text node when the pane is double-clicked', () => {
    const canvasProps = props(vi.fn());
    const { container } = render(<WorkspaceCanvas {...canvasProps} />);
    const pane = container.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();

    fireEvent.doubleClick(pane as Element, { clientX: 400, clientY: 300 });

    expect(canvasProps.onAddNode).toHaveBeenCalledWith(
      'text',
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
  });

  it('does not create a text node when a node element is double-clicked', () => {
    const canvasProps = props(vi.fn());
    render(<WorkspaceCanvas {...canvasProps} />);

    fireEvent.doubleClick(screen.getByTestId('focusable-node'), { clientX: 400, clientY: 300 });

    expect(canvasProps.onAddNode).not.toHaveBeenCalled();
  });

  it('does not create a text node from a pane double-click on a read-only canvas', () => {
    const canvasProps = props(vi.fn());
    canvasProps.collaborationGraphReadOnly = true;
    const { container } = render(<WorkspaceCanvas {...canvasProps} />);
    const pane = container.querySelector('.react-flow__pane');

    fireEvent.doubleClick(pane as Element, { clientX: 400, clientY: 300 });

    expect(canvasProps.onAddNode).not.toHaveBeenCalled();
  });
});

describe('WorkspaceCanvas Enter-to-edit', () => {
  it('opens the text editor when Enter is pressed on a focused text node', () => {
    const canvasProps = props(vi.fn());
    canvasProps.nodes = [node('text-1', 101, 99, 'text'), node('target', 100, 100)];
    render(<WorkspaceCanvas {...canvasProps} />);
    const seen = vi.fn();
    const unsubscribe = onTextEditRequest(seen);

    fireEvent.keyDown(screen.getByTestId('focusable-node'), { key: 'Enter' });

    expect(seen).toHaveBeenCalledWith('text-1');
    unsubscribe();
  });

  it('leaves non-text nodes alone when Enter is pressed', () => {
    const onKeyboardMove = vi.fn();
    const canvasProps = props(onKeyboardMove);
    render(<WorkspaceCanvas {...canvasProps} />);
    const seen = vi.fn();
    const unsubscribe = onTextEditRequest(seen);

    fireEvent.keyDown(screen.getByTestId('focusable-node'), { key: 'Enter' });

    expect(seen).not.toHaveBeenCalled();
    expect(onKeyboardMove).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('ignores Enter typed inside an editable control on the focused node', () => {
    const canvasProps = props(vi.fn());
    canvasProps.nodes = [node('text-1', 101, 99, 'text'), node('target', 100, 100)];
    render(<WorkspaceCanvas {...canvasProps} />);
    const seen = vi.fn();
    const unsubscribe = onTextEditRequest(seen);

    fireEvent.keyDown(screen.getByLabelText('Node editor'), { key: 'Enter' });

    expect(seen).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('does not open the editor for a locked text node or a read-only canvas', () => {
    const seen = vi.fn();
    const unsubscribe = onTextEditRequest(seen);

    const lockedNode = node('text-1', 101, 99, 'text');
    const canvasProps = props(vi.fn());
    canvasProps.nodes = [
      { ...lockedNode, data: { ...lockedNode.data, locked: true } },
      node('target', 100, 100),
    ];
    render(<WorkspaceCanvas {...canvasProps} />);
    fireEvent.keyDown(screen.getByTestId('focusable-node'), { key: 'Enter' });
    expect(seen).not.toHaveBeenCalled();
    cleanup();

    const readOnlyProps = props(vi.fn());
    readOnlyProps.nodes = [node('text-1', 101, 99, 'text'), node('target', 100, 100)];
    readOnlyProps.collaborationGraphReadOnly = true;
    render(<WorkspaceCanvas {...readOnlyProps} />);
    fireEvent.keyDown(screen.getByTestId('focusable-node'), { key: 'Enter' });
    expect(seen).not.toHaveBeenCalled();

    unsubscribe();
  });
});

describe('WorkspaceCanvas node context menu', () => {
  it('opens for right-click and dispatches an explicit-node action', () => {
    const canvasProps = props(vi.fn());
    const view = render(<WorkspaceCanvas {...canvasProps} />);
    const region = canvasRegion(view.container);
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue(canvasBounds());

    fireEvent.contextMenu(screen.getByTestId('react-flow'), {
      clientX: 200,
      clientY: 160,
    });
    expect(canvasProps.onInspectNode).toHaveBeenCalledWith('dragged');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(canvasProps.onDuplicateNode).toHaveBeenCalledWith('dragged');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it.each([
    { key: 'ContextMenu', shiftKey: false },
    { key: 'F10', shiftKey: true },
  ])('opens from $key and restores node focus on Escape', ({ key, shiftKey }) => {
    const canvasProps = props(vi.fn());
    const view = render(<WorkspaceCanvas {...canvasProps} />);
    vi.spyOn(canvasRegion(view.container), 'getBoundingClientRect').mockReturnValue(canvasBounds());
    const target = screen.getByTestId('focusable-node');
    target.focus();

    fireEvent.keyDown(target, { key, shiftKey });
    const menu = screen.getByRole('menu', { name: 'Actions for dragged' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Inspect' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(target);
  });

  it('keeps protected and read-only mutations unavailable', () => {
    const canvasProps = props(vi.fn());
    canvasProps.collaborationGraphReadOnly = true;
    canvasProps.deletionProtectedNodeIds = new Set(['dragged']);
    const view = render(<WorkspaceCanvas {...canvasProps} />);
    vi.spyOn(canvasRegion(view.container), 'getBoundingClientRect').mockReturnValue(canvasBounds());
    fireEvent.contextMenu(screen.getByTestId('react-flow'));

    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Duplicate' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Delete' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Inspect' }).disabled).toBe(
      false,
    );
    const run = screen.getByRole<HTMLButtonElement>('menuitem', {
      name: 'Run with dependencies',
    });
    expect(run.disabled).toBe(true);
    expect(
      document.getElementById(run.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toMatch(/cannot edit the shared graph/u);
  });

  it('runs the exact context target with upstream dependencies regardless of prior selection', () => {
    const canvasProps = props(vi.fn());
    canvasProps.nodes = [
      node('context-agent', 101, 99, 'agent'),
      { ...node('previous-selection', 100, 100, 'agent'), selected: true },
    ];
    const view = render(<WorkspaceCanvas {...canvasProps} />);
    vi.spyOn(canvasRegion(view.container), 'getBoundingClientRect').mockReturnValue(canvasBounds());

    fireEvent.contextMenu(screen.getByTestId('react-flow'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run with dependencies' }));

    expect(canvasProps.onRunWorkflowScope).toHaveBeenCalledOnce();
    expect(canvasProps.onRunWorkflowScope).toHaveBeenCalledWith({
      kind: 'node',
      nodeId: 'context-agent',
      includeUpstream: true,
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('uses group eligibility and keeps an unassigned Task disabled with its exact reason', () => {
    const groupProps = props(vi.fn());
    const group = node('delivery-group', 101, 99, 'group-frame');
    groupProps.nodes = [
      { ...group, data: { ...group.data, childNodeIds: ['agent'] } },
      node('agent', 100, 100, 'agent'),
    ];
    const groupView = render(<WorkspaceCanvas {...groupProps} />);
    vi.spyOn(canvasRegion(groupView.container), 'getBoundingClientRect').mockReturnValue(
      canvasBounds(),
    );
    fireEvent.contextMenu(screen.getByTestId('react-flow'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run with dependencies' }));
    expect(groupProps.onRunWorkflowScope).toHaveBeenCalledWith({
      kind: 'group',
      groupId: 'delivery-group',
      includeUpstream: true,
    });
    groupView.unmount();

    const taskProps = props(vi.fn());
    taskProps.nodes = [node('unassigned-task', 101, 99, 'task')];
    const taskView = render(<WorkspaceCanvas {...taskProps} />);
    vi.spyOn(canvasRegion(taskView.container), 'getBoundingClientRect').mockReturnValue(
      canvasBounds(),
    );
    fireEvent.contextMenu(screen.getByTestId('react-flow'));
    const taskRun = screen.getByRole<HTMLButtonElement>('menuitem', {
      name: 'Run with dependencies',
    });
    expect(taskRun.disabled).toBe(true);
    expect(taskRun.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip', {
        name: 'Choose an agent for this task before running it.',
      }).id,
    );
    expect(taskProps.onRunWorkflowScope).not.toHaveBeenCalled();
  });

  it('disables Run while another workflow action is busy', () => {
    const canvasProps = props(vi.fn());
    canvasProps.nodes = [node('agent', 101, 99, 'agent')];
    canvasProps.workflowRunBusy = true;
    const view = render(<WorkspaceCanvas {...canvasProps} />);
    vi.spyOn(canvasRegion(view.container), 'getBoundingClientRect').mockReturnValue(canvasBounds());
    fireEvent.contextMenu(screen.getByTestId('react-flow'));

    const run = screen.getByRole<HTMLButtonElement>('menuitem', {
      name: 'Run with dependencies',
    });
    expect(run.disabled).toBe(true);
    expect(run.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip', {
        name: 'Another workflow action is already in progress.',
      }).id,
    );
    fireEvent.click(run);
    expect(canvasProps.onRunWorkflowScope).not.toHaveBeenCalled();
  });

  it('disables Run for workflow-read-only authority independently of graph editing', () => {
    const canvasProps = props(vi.fn());
    canvasProps.nodes = [node('agent', 101, 99, 'agent')];
    canvasProps.workflowMutationsAuthorized = false;
    expect(canvasProps.collaborationGraphReadOnly).toBe(false);
    const view = render(<WorkspaceCanvas {...canvasProps} />);
    vi.spyOn(canvasRegion(view.container), 'getBoundingClientRect').mockReturnValue(canvasBounds());
    fireEvent.contextMenu(screen.getByTestId('react-flow'));

    const run = screen.getByRole<HTMLButtonElement>('menuitem', {
      name: 'Run with dependencies',
    });
    expect(run.disabled).toBe(true);
    expect(run.getAttribute('aria-describedby')).toBe(
      screen.getByRole('tooltip', {
        name: 'This collaboration role can inspect workflow history but cannot start execution.',
      }).id,
    );
    fireEvent.click(run);
    expect(canvasProps.onRunWorkflowScope).not.toHaveBeenCalled();
  });
});

describe('WorkspaceCanvas palette drops', () => {
  it('preserves pointer snapping while measuring panned viewport bounds without snapping', () => {
    const canvasProps = props(vi.fn());
    const pan = { x: -138.5, y: 0 };
    const zoom = 2.5;
    const grid = 128;
    const screenToFlowPosition = vi.fn(
      (point: { x: number; y: number }, options?: { snapToGrid: boolean }) => {
        const position = {
          x: (point.x - pan.x) / zoom,
          y: (point.y - pan.y) / zoom,
        };
        if (options?.snapToGrid === false) return position;
        return {
          x: grid * Math.round(position.x / grid),
          y: grid * Math.round(position.y / grid),
        };
      },
    );
    canvasProps.instance = {
      getZoom: () => zoom,
      setViewport: vi.fn().mockResolvedValue(true),
      screenToFlowPosition,
    } as unknown as React.ComponentProps<typeof WorkspaceCanvas>['instance'];
    const view = render(<WorkspaceCanvas {...canvasProps} />);
    const region = canvasRegion(view.container);
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue(canvasBounds());

    fireEvent(
      region,
      paletteDropEvent(paletteDataTransfer('application/x-forgeboard-node', 'task')),
    );

    expect(screenToFlowPosition).toHaveBeenNthCalledWith(1, { x: 900, y: 700 }, undefined);
    expect(screenToFlowPosition).toHaveBeenNthCalledWith(
      2,
      { x: 16, y: 16 },
      { snapToGrid: false },
    );
    expect(screenToFlowPosition).toHaveBeenNthCalledWith(
      3,
      { x: 984, y: 734 },
      { snapToGrid: false },
    );
    const position = vi.mocked(canvasProps.onAddNode).mock.calls[0]?.[1];
    expect(position?.x).toBeCloseTo(109);
    expect(position?.y).toBeCloseTo(13.6);
  });

  it('uses the rendered group-frame and extension dimensions when clamping drops', () => {
    const groupProps = props(vi.fn());
    const groupView = render(<WorkspaceCanvas {...groupProps} />);
    const groupRegion = canvasRegion(groupView.container);
    vi.spyOn(groupRegion, 'getBoundingClientRect').mockReturnValue(canvasBounds());

    fireEvent(
      groupRegion,
      paletteDropEvent(paletteDataTransfer('application/x-forgeboard-node', 'group-frame')),
    );

    expect(groupProps.onAddNode).toHaveBeenCalledWith('group-frame', {
      x: 464,
      y: 374,
    });
    groupView.unmount();

    const extensionProps = props(vi.fn());
    const template = extensionTemplate();
    extensionProps.extensionTemplates = [template];
    const extensionView = render(<WorkspaceCanvas {...extensionProps} />);
    const extensionRegion = canvasRegion(extensionView.container);
    vi.spyOn(extensionRegion, 'getBoundingClientRect').mockReturnValue(canvasBounds());

    fireEvent(
      extensionRegion,
      paletteDropEvent(
        paletteDataTransfer('application/x-forgeboard-extension-node', template.key),
      ),
    );

    expect(extensionProps.onAddExtensionNode).toHaveBeenCalledWith(template, {
      x: 664,
      y: 554,
    });
  });
});

describe('WorkspaceCanvas Agent context drops', () => {
  it('links a configured File node dropped directly on an Agent after preserving its move', async () => {
    const onAttachAgentContext = vi.fn().mockResolvedValue(undefined);
    const canvasProps = props(vi.fn());
    const source = fileNode('source', 220, 115);
    canvasProps.nodes = [source, node('agent', 200, 100, 'agent')];
    canvasProps.onAttachAgentContext = onAttachAgentContext;
    render(<WorkspaceCanvas {...canvasProps} />);
    const flowProps = mocks.reactFlowProps as {
      onNodeDragStop: (event: unknown, node: WorkshopNode, nodes: WorkshopNode[]) => void;
    };

    act(() => flowProps.onNodeDragStop({}, source, [source]));

    expect(canvasProps.onNodeDragStop).toHaveBeenCalledWith(source, [source]);
    await waitFor(() =>
      expect(onAttachAgentContext).toHaveBeenCalledWith('agent', {
        schemaVersion: 1,
        kind: 'project-file',
        projectId: canvas().projectId,
        relativePath: 'src/context.ts',
        sourceNodeId: 'source',
      }),
    );
    expect(canvasProps.onNodesChange).not.toHaveBeenCalled();
    expect(canvasProps.onContextDropError).not.toHaveBeenCalled();
  });

  it('attaches a strict project-file payload dropped on an unlocked Agent node', async () => {
    const onAttachAgentContext = vi.fn().mockResolvedValue(undefined);
    const canvasProps = props(vi.fn());
    canvasProps.nodes = [node('source', 101, 99), node('agent', 100, 100, 'agent')];
    canvasProps.onAttachAgentContext = onAttachAgentContext;
    render(<WorkspaceCanvas {...canvasProps} />);
    const dataTransfer = contextDataTransfer();
    const target = screen.getByTestId('canvas-node-agent');

    fireEvent.dragOver(target, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(fireEvent.drop(target, { dataTransfer })).toBe(false);

    await waitFor(() =>
      expect(onAttachAgentContext).toHaveBeenCalledWith('agent', contextPayload()),
    );
    expect(canvasProps.onContextDropError).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'malformed payload',
      configure: (canvasProps: ReturnType<typeof props>) => {
        canvasProps.nodes = [node('source', 101, 99), node('agent', 100, 100, 'agent')];
      },
      dataTransfer: () => contextDataTransfer('{"schemaVersion":1,"kind":"project-file"}'),
      target: 'canvas-node-agent',
      message: /valid Forgeboard project file/u,
    },
    {
      label: 'non-Agent target',
      configure: (canvasProps: ReturnType<typeof props>) => {
        canvasProps.nodes = [node('source', 101, 99), node('task', 100, 100)];
      },
      dataTransfer: () => contextDataTransfer(),
      target: 'canvas-node-task',
      message: /only be attached to an Agent node/u,
    },
    {
      label: 'locked Agent',
      configure: (canvasProps: ReturnType<typeof props>) => {
        canvasProps.nodes = [
          node('source', 101, 99),
          {
            ...node('agent', 100, 100, 'agent'),
            data: { ...node('agent', 100, 100, 'agent').data, locked: true },
          },
        ];
      },
      dataTransfer: () => contextDataTransfer(),
      target: 'canvas-node-agent',
      message: /Unlock the Agent node/u,
    },
    {
      label: 'read-only collaboration graph',
      configure: (canvasProps: ReturnType<typeof props>) => {
        canvasProps.nodes = [node('source', 101, 99), node('agent', 100, 100, 'agent')];
        canvasProps.collaborationGraphReadOnly = true;
      },
      dataTransfer: () => contextDataTransfer(),
      target: 'canvas-node-agent',
      message: /cannot edit the shared canvas/u,
    },
  ])('rejects a $label', async ({ configure, dataTransfer, target, message }) => {
    const canvasProps = props(vi.fn());
    configure(canvasProps);
    render(<WorkspaceCanvas {...canvasProps} />);

    expect(
      fireEvent.drop(screen.getByTestId(target), {
        dataTransfer: dataTransfer(),
      }),
    ).toBe(true);

    expect(canvasProps.onAttachAgentContext).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(canvasProps.onContextDropError).toHaveBeenCalledWith(expect.stringMatching(message)),
    );
  });

  it('reports asynchronous attachment failures', async () => {
    const canvasProps = props(vi.fn());
    canvasProps.nodes = [node('source', 101, 99), node('agent', 100, 100, 'agent')];
    canvasProps.onAttachAgentContext = vi.fn().mockRejectedValue(new Error('File policy changed.'));
    render(<WorkspaceCanvas {...canvasProps} />);

    fireEvent.drop(screen.getByTestId('canvas-node-agent'), {
      dataTransfer: contextDataTransfer(),
    });

    await waitFor(() =>
      expect(canvasProps.onContextDropError).toHaveBeenCalledWith('File policy changed.'),
    );
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
      setViewport: vi.fn().mockResolvedValue(true),
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    } as unknown as React.ComponentProps<typeof WorkspaceCanvas>['instance'],
    onInstance: vi.fn(),
    onViewportChange: vi.fn(),
    onNodesChange: vi.fn(),
    onEdgesChange: vi.fn(),
    onConnect: vi.fn(),
    onNodeDragStart: vi.fn(),
    onNodeDragStop: vi.fn(),
    onSetNodeCollapsed: vi.fn(),
    onNodeResizeStart: vi.fn(),
    onKeyboardMove,
    onSelectionChange: vi.fn(),
    edgeConfigNodes: nodes(),
    onUpdateEdgeType: vi.fn(),
    onUpdateEdgeData: vi.fn(),
    onInspectNode: vi.fn(),
    onSetNodeLocked: vi.fn(),
    onDuplicateNode: vi.fn(),
    onDeleteNode: vi.fn(),
    workflowRunBusy: false,
    workflowMutationsAuthorized: true,
    onRunWorkflowScope: vi.fn(),
    onAddNode: vi.fn(),
    onAddExtensionNode: vi.fn(),
    onAttachAgentContext: vi.fn().mockResolvedValue(undefined),
    onContextDropError: vi.fn(),
    collaborationAwareness: [],
    onCollaborationCursorMove: vi.fn(),
    onCollaborationCursorLeave: vi.fn(),
    collaborationGraphReadOnly: false,
    inheritedLockedNodeIds: new Set(),
    deletionProtectedNodeIds: new Set(),
  };
}

function nodes(): WorkshopNode[] {
  return [node('dragged', 101, 99), node('target', 100, 100)];
}

function node(
  id: string,
  x: number,
  y: number,
  kind: WorkshopNode['data']['kind'] = 'task',
): WorkshopNode {
  return {
    id,
    type: 'workshop',
    position: { x, y },
    width: 100,
    height: 50,
    data: {
      kind,
      title: id,
      description: id,
      status: 'idle',
      locked: false,
      collapsed: false,
      color: '#445566',
    },
  };
}

function fileNode(id: string, x: number, y: number): WorkshopNode {
  return {
    ...node(id, x, y, 'file'),
    width: 60,
    height: 40,
    data: {
      ...node(id, x, y, 'file').data,
      file: {
        projectId: canvas().projectId,
        relativePath: 'src/context.ts',
        kind: 'file',
        missing: false,
      },
    },
  };
}

function contextPayload() {
  return {
    schemaVersion: 1 as const,
    kind: 'project-file' as const,
    projectId: '70000000-0000-4000-8000-000000000001',
    relativePath: 'docs/brief.md',
    sourceNodeId: 'source',
  };
}

function contextDataTransfer(serialized = JSON.stringify(contextPayload())): DataTransfer {
  return {
    types: [WORKSPACE_CONTEXT_DRAG_MIME],
    getData: vi.fn((type: string) => (type === WORKSPACE_CONTEXT_DRAG_MIME ? serialized : '')),
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

function paletteDataTransfer(type: string, value: string): DataTransfer {
  return {
    types: [type],
    getData: vi.fn((requestedType: string) => (requestedType === type ? value : '')),
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

function paletteDropEvent(dataTransfer: DataTransfer): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: 900 },
    clientY: { value: 700 },
    dataTransfer: { value: dataTransfer },
  });
  return event;
}

function canvasRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>('.canvas-region');
  if (region === null) throw new Error('Missing canvas region.');
  return region;
}

function canvasBounds(): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1_000,
    bottom: 750,
    width: 1_000,
    height: 750,
    toJSON: () => ({}),
  };
}

function extensionTemplate(): ExtensionTemplate {
  const definition: ExtensionTemplate['definition'] = {
    id: 'decision',
    displayName: 'Decision',
    description: 'Records a bounded decision.',
    category: 'Planning',
    icon: 'note',
    color: '#4F46E5',
    capabilities: ['human-editable'],
    fields: [],
    ports: [],
  };
  return {
    key: 'example.notes:decision',
    definition,
    extension: {
      record: {
        schemaVersion: 1,
        extensionId: 'example.notes',
        version: '1.0.0',
        manifestDigest: 'a'.repeat(64),
        snapshotDigest: 'b'.repeat(64),
        grantedPermissions: ['canvas.data.persist', 'canvas.node.register'],
        sourcePath: '/tmp/example.notes',
        installedAt: '2026-07-14T16:00:00.000Z',
        updatedAt: '2026-07-14T16:00:00.000Z',
      },
      manifest: {
        schemaVersion: 1,
        id: 'example.notes',
        name: 'Example notes',
        version: '1.0.0',
        description: 'Adds decision notes.',
        publisher: 'Example',
        requestedPermissions: ['canvas.data.persist', 'canvas.node.register'],
        contributes: { agentAdapters: [], canvasNodeTypes: [definition] },
      },
      manifestJson: '{}',
      trustState: 'active',
      approvedAt: '2026-07-14T16:00:00.000Z',
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
