// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasNode, type WorkshopNode, type WorkshopNodeData } from './CanvasNode.js';
import {
  CanvasNodeInteractionProvider,
  setCanvasNodeCollapsed,
} from './interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';

// The terminal node face is registered (Task 3 of sub-plan 2c) and this suite's placeholder
// `nodeData()` defaults to `kind: 'terminal'` as its generic-presentation fixture. Mounting the
// real TerminalNodeFace here would require the full terminal/agent-session provider stack (and
// window.forgeboard.terminal) that these tests never set up. Stubbing the registry to always
// return null decouples this suite from every registered face — including file/diff, registered
// by sibling tasks — so CanvasNode always renders its generic body here, exactly as these
// collapse/resize/lock assertions expect.
vi.mock('./faces/node-face-registry.js', () => ({
  nodeFaceForKind: () => null,
}));

vi.mock('@xyflow/react', () => ({
  Handle: ({
    id,
    type,
    className,
    position,
  }: {
    id: string;
    type: string;
    className?: string;
    position?: string;
  }) => (
    <span data-testid={`handle-${type}-${id}`} className={className} data-position={position} />
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
      name: 'Terminal: Implement search',
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
      minWidth: '400',
      minHeight: '320',
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

  it('shows the node name as the header’s primary text for a faceless kind, with the kind icon beside it', () => {
    const { container } = renderNode(nodeData({ kind: 'terminal', title: 'Implement search' }));

    const header = container.querySelector('header');
    expect(header?.querySelector('.node-title')?.textContent).toBe('Implement search');
    expect(screen.getByRole('img', { name: 'Terminal' })).toBeTruthy();
  });

  it('shows the node name as the header’s primary text for a Face-based kind too, with the kind icon beside it', () => {
    const { container } = renderNode(
      nodeData({ kind: 'brief', title: 'Search redesign brief', description: '' }),
    );

    const header = container.querySelector('header');
    expect(header?.querySelector('.node-title')?.textContent).toBe('Search redesign brief');
    expect(screen.getByRole('img', { name: 'Product brief' })).toBeTruthy();
  });

  it('marks agent nodes as provider-tinted windows and makes the whole collapsed node draggable', () => {
    renderNode(nodeData({ kind: 'agent', adapterId: 'claude', collapsed: true }));

    const node = screen.getByRole('article', { name: 'Agent: Implement search' });
    expect(node.classList.contains('agent-window')).toBe(true);
    expect(node.classList.contains('agent-drag-handle')).toBe(true);
    expect(node.getAttribute('data-provider')).toBe('claude');
  });

  it('renders the text kind frameless: no handles, no collapse, rotation transform', () => {
    renderNode(nodeData({ kind: 'text', rotationDeg: 30, text: 'Hi' }));

    expect(screen.queryByRole('button', { name: /Collapse|Expand/ })).toBeNull();
    const article = screen.getByRole('article');
    expect(article.className).toContain('text-node');
    expect(article.getAttribute('style')).toContain('--text-rotation: 30deg');
    expect(document.querySelectorAll('.node-handle')).toHaveLength(0);
  });

  it('shows the text rotate handle only while selected and mutable', () => {
    renderNode(nodeData({ kind: 'text' }), { selected: true });
    expect(screen.getByRole('button', { name: 'Rotate text' })).toBeTruthy();

    cleanup();
    renderNode(nodeData({ kind: 'text' }), { selected: false });
    expect(screen.queryByRole('button', { name: 'Rotate text' })).toBeNull();

    cleanup();
    renderNode(nodeData({ kind: 'text', locked: true }), { selected: true });
    expect(screen.queryByRole('button', { name: 'Rotate text' })).toBeNull();
  });

  it('shows size controls in the text node header, mutating fontSize on click', () => {
    const updateNodeData = vi.fn();
    render(
      <CanvasNodeInteractionProvider readOnly={false} setCollapsed={vi.fn()}>
        <AgentSessionProvider value={{ ...sessionValue(), updateNodeData }}>
          <CanvasNode {...nodeProps(nodeData({ kind: 'text', fontSize: 's' }), true)} />
        </AgentSessionProvider>
      </CanvasNodeInteractionProvider>,
    );

    const large = screen.getByRole('button', { name: 'Large text' });
    fireEvent.click(large);
    expect(updateNodeData).toHaveBeenCalledWith('node-1', { fontSize: 'l' });
  });

  it('disables size controls for a locked text node and enables them once unlocked and selected', () => {
    renderNode(nodeData({ kind: 'text', locked: true }), { selected: true });
    expect(screen.getByRole('button', { name: 'Small text' })).toHaveProperty('disabled', true);

    cleanup();
    renderNode(nodeData({ kind: 'text', locked: false }), { selected: true });
    expect(screen.getByRole('button', { name: 'Small text' })).toHaveProperty('disabled', false);
  });
});

describe('CanvasNode connection handles', () => {
  const kinds: ReadonlyArray<Partial<WorkshopNodeData>> = [
    { kind: 'agent', adapterId: 'codex' },
    { kind: 'agent', adapterId: 'claude' },
    { kind: 'agent', adapterId: 'gemini' },
    { kind: 'file' },
    { kind: 'whiteboard' },
    { kind: 'terminal' },
    { kind: 'web-preview' },
    { kind: 'group-frame' },
  ];

  it('gives every node kind and provider the same start dot and end acceptor', () => {
    for (const overrides of kinds) {
      renderNode(nodeData(overrides));

      const target = screen.getByTestId('handle-target-input');
      const source = screen.getByTestId('handle-source-output');
      // One shared class — never a provider- or kind-specific one — so the CSS
      // that paints them cannot diverge per node.
      expect(target.className).toBe('node-handle');
      expect(source.className).toBe('node-handle');
      expect(target.dataset['position']).toBe('left');
      expect(source.dataset['position']).toBe('right');

      cleanup();
    }
  });

  it('renders the handles outside the node surface so clipped faces cannot cut them', () => {
    for (const overrides of kinds) {
      const { container } = renderNode(nodeData(overrides));

      const surface = container.querySelector('.canvas-node');
      expect(surface).not.toBeNull();
      // Agent windows, previews, terminals and the document faces all clip with
      // `overflow: hidden`; a handle inside that box renders as a half-moon.
      expect(surface?.contains(screen.getByTestId('handle-target-input'))).toBe(false);
      expect(surface?.contains(screen.getByTestId('handle-source-output'))).toBe(false);

      cleanup();
    }
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
      <AgentSessionProvider value={sessionValue()}>
        <CanvasNode {...nodeProps(data, selected)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>
  );
}

/**
 * Minimal in-canvas services stub. Faces mounted here (e.g. the terminal node,
 * since these tests default to `kind: 'terminal'` for generic presentation
 * coverage) read this context, even though these tests don't exercise it.
 */
function sessionValue(): AgentSessionContextValue {
  return {
    graphReadOnly: false,
    updateNodeData: vi.fn(),
    recordHistory: vi.fn(),
    nodeRoster: [],
    checkProducers: [],
  } as unknown as AgentSessionContextValue;
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
    kind: 'terminal',
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
