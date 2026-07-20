// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasNode, type WorkshopNode, type WorkshopNodeData } from './CanvasNode.js';
import {
  CanvasNodeInteractionProvider,
  setCanvasNodeCollapsed,
} from './interactions/CanvasNodeInteractionContext.js';

vi.mock('@xyflow/react', () => ({
  Handle: ({ id, type }: { id: string; type: string }) => (
    <span data-testid={`handle-${type}-${id}`} />
  ),
  NodeResizer: ({
    isVisible,
    minHeight,
    minWidth,
    onResizeStart,
  }: {
    isVisible: boolean;
    minHeight: number;
    minWidth: number;
    onResizeStart?: () => void;
  }) => (
    <span
      data-testid="node-resizer"
      data-visible={String(isVisible)}
      data-min-height={String(minHeight)}
      data-min-width={String(minWidth)}
      onMouseDown={onResizeStart}
    />
  ),
  Position: { Left: 'left', Right: 'right' },
  useReactFlow: vi.fn(),
  useStore: vi.fn(),
  useUpdateNodeInternals: vi.fn(),
}));

afterEach(cleanup);

describe('CanvasNode presentation interactions', () => {
  it('offers an accessible collapse action and selected-node resize controls', () => {
    const setCollapsed = vi.fn();
    const onResizeStart = vi.fn();
    renderNode(nodeData(), { selected: true, setCollapsed, onResizeStart });

    const node = screen.getByRole('article', {
      name: 'Task: Implement search',
    });
    expect(node.getAttribute('aria-roledescription')).toBe('canvas node');
    expect(screen.getByText('Build the local index.')).toBeTruthy();
    const collapse = screen.getByRole('button', {
      name: 'Collapse Implement search',
    });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    expect(collapse).toHaveProperty('disabled', false);
    expect(resizer()).toMatchObject({
      visible: 'true',
      minWidth: '210',
      minHeight: '92',
    });

    fireEvent.click(collapse);
    expect(setCollapsed).toHaveBeenCalledWith('node-1', true);
    fireEvent.mouseDown(screen.getByTestId('node-resizer'));
    expect(onResizeStart).toHaveBeenCalledOnce();
    expect(onResizeStart).toHaveBeenCalledWith('node-1');
  });

  it('keeps edge handles and a visible title while collapsed, but removes the body and resizer', () => {
    const onResizeStart = vi.fn();
    renderNode(nodeData({ collapsed: true }), {
      selected: true,
      onResizeStart,
    });

    expect(
      screen.getByRole('button', { name: 'Expand Implement search' }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(screen.getByText('Implement search')).toBeTruthy();
    expect(screen.queryByText('Build the local index.')).toBeNull();
    expect(screen.getByTestId('handle-target-input')).toBeTruthy();
    expect(screen.getByTestId('handle-source-output')).toBeTruthy();
    expect(resizer().visible).toBe('false');
    fireEvent.mouseDown(screen.getByTestId('node-resizer'));
    expect(onResizeStart).not.toHaveBeenCalled();
  });

  it('exposes resize controls only when the node is selected', () => {
    const onResizeStart = vi.fn();
    renderNode(nodeData(), { selected: false, onResizeStart });

    expect(resizer().visible).toBe('false');
    fireEvent.mouseDown(screen.getByTestId('node-resizer'));
    expect(onResizeStart).not.toHaveBeenCalled();
  });

  it('fails closed for locked and collaboration-read-only nodes', () => {
    const lockedChange = vi.fn();
    const view = renderNode(nodeData({ locked: true }), {
      selected: true,
      setCollapsed: lockedChange,
    });

    const lockedButton = screen.getByRole('button', {
      name: 'Collapse Implement search',
    });
    expect(lockedButton).toHaveProperty('disabled', true);
    const lockedReason = screen.getByRole('tooltip', {
      name: /Unlock this node/u,
    });
    expect(lockedButton.getAttribute('aria-describedby')).toBe(lockedReason.id);
    fireEvent.click(lockedButton);
    expect(lockedChange).not.toHaveBeenCalled();
    expect(resizer().visible).toBe('false');

    const readOnlyChange = vi.fn();
    view.rerender(
      renderedNode(nodeData(), {
        readOnly: true,
        selected: true,
        setCollapsed: readOnlyChange,
      }),
    );
    const readOnlyButton = screen.getByRole('button', {
      name: 'Collapse Implement search',
    });
    expect(readOnlyButton).toHaveProperty('disabled', true);
    const readOnlyReason = screen.getByRole('tooltip', {
      name: /collaboration role/u,
    });
    expect(readOnlyButton.getAttribute('aria-describedby')).toBe(readOnlyReason.id);
    fireEvent.click(readOnlyButton);
    expect(readOnlyChange).not.toHaveBeenCalled();
    expect(resizer().visible).toBe('false');
  });

  it('gives group frames group semantics and reserves manual resizing for non-auto-fit frames', () => {
    renderNode(
      nodeData({
        kind: 'group-frame',
        title: 'Review stage',
        purpose: 'workflow-stage',
        layout: 'grid',
        autoFit: true,
      }),
      { selected: true },
    );

    const frame = screen.getByRole('group', { name: 'Group: Review stage' });
    expect(frame.classList.contains('group-frame')).toBe(true);
    expect(frame.getAttribute('aria-roledescription')).toBe('group');
    expect(frame.getAttribute('data-node-kind')).toBe('group-frame');
    expect(resizer()).toMatchObject({
      visible: 'false',
      minWidth: '360',
      minHeight: '240',
    });

    cleanup();
    renderNode(nodeData({ kind: 'group-frame', title: 'Manual frame', autoFit: false }), {
      selected: true,
    });
    expect(resizer()).toMatchObject({
      visible: 'true',
      minWidth: '360',
      minHeight: '240',
    });
  });

  it('changes only serializable collapsed data and rejects locked or read-only mutation', () => {
    const target = workshopNode('target', nodeData());
    const other = workshopNode('other', nodeData({ title: 'Other' }));
    const nodes = [target, other];
    const next = setCanvasNodeCollapsed(nodes, target.id, true, false);

    expect(next).not.toBe(nodes);
    expect(next[0]).not.toBe(target);
    expect(next[0]?.data.collapsed).toBe(true);
    expect(next[1]).toBe(other);
    expect(target.data.collapsed).toBe(false);
    expect(Object.values(next[0]?.data ?? {}).some((value) => typeof value === 'function')).toBe(
      false,
    );

    const locked = workshopNode('locked', nodeData({ locked: true }));
    const lockedNodes = [locked];
    expect(setCanvasNodeCollapsed(lockedNodes, locked.id, true, false)).toBe(lockedNodes);
    const readOnlyNodes = [target];
    expect(setCanvasNodeCollapsed(readOnlyNodes, target.id, true, true)).toBe(readOnlyNodes);
  });

  it('marks agent nodes as provider-tinted windows and keeps collapsed agents draggable', () => {
    renderNode(nodeData({ kind: 'agent', adapterId: 'claude', collapsed: true }));

    const node = screen.getByRole('article', { name: 'Agent: Implement search' });
    expect(node.classList.contains('agent-window')).toBe(true);
    expect(node.classList.contains('agent-drag-handle')).toBe(true);
    expect(node.getAttribute('data-provider')).toBe('claude');
  });
});

function renderNode(
  data: WorkshopNodeData,
  options: {
    readonly readOnly?: boolean;
    readonly selected?: boolean;
    readonly setCollapsed?: (nodeId: string, collapsed: boolean) => void;
    readonly onResizeStart?: (nodeId: string) => void;
  } = {},
) {
  return render(renderedNode(data, options));
}

function renderedNode(
  data: WorkshopNodeData,
  {
    readOnly = false,
    selected = false,
    setCollapsed = vi.fn(),
    onResizeStart,
  }: {
    readonly readOnly?: boolean;
    readonly selected?: boolean;
    readonly setCollapsed?: (nodeId: string, collapsed: boolean) => void;
    readonly onResizeStart?: (nodeId: string) => void;
  },
) {
  return (
    <CanvasNodeInteractionProvider
      readOnly={readOnly}
      setCollapsed={setCollapsed}
      onResizeStart={onResizeStart}
    >
      <CanvasNode {...nodeProps(data, selected)} />
    </CanvasNodeInteractionProvider>
  );
}

function nodeProps(data: WorkshopNodeData, selected: boolean): NodeProps<WorkshopNode> {
  return {
    id: 'node-1',
    data,
    type: 'workshop',
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    selected,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'task',
    title: 'Implement search',
    description: 'Build the local index.',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#445566',
    ...overrides,
  };
}

function workshopNode(id: string, data: WorkshopNodeData): WorkshopNode {
  return { id, type: 'workshop', position: { x: 0, y: 0 }, data };
}

function resizer(): {
  readonly visible: string | undefined;
  readonly minWidth: string | undefined;
  readonly minHeight: string | undefined;
} {
  const element = screen.getByTestId('node-resizer');
  return {
    visible: element.dataset['visible'],
    minWidth: element.dataset['minWidth'],
    minHeight: element.dataset['minHeight'],
  };
}
