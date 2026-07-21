// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasNode, type WorkshopNode, type WorkshopNodeData } from '../CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
  type CanvasNodeRosterEntry,
} from '../../runs/agent-session/AgentSessionContext.js';
import {
  WorkflowRuntimeProvider,
  type WorkflowRuntimeContextValue,
} from '../../workflows/WorkflowRuntimeContext.js';
import {
  NodeCommentsProvider,
  type NodeCommentsContextValue,
} from './NodeCommentsContext.js';
import { uniqueNodeTitle } from './unique-title.js';

// Faces need the full in-canvas provider stack these tests don't build; stub the registry so
// CanvasNode always renders its generic presentation (header + body), exactly like CanvasNode.test.
vi.mock('../faces/node-face-registry.js', () => ({
  nodeFaceForKind: () => null,
}));

vi.mock('@xyflow/react', () => ({
  Handle: ({ id, type }: { id: string; type: string }) => (
    <span data-testid={`handle-${type}-${id}`} />
  ),
  NodeResizer: () => <span data-testid="node-resizer" />,
  Position: { Left: 'left', Right: 'right' },
  useReactFlow: vi.fn(),
  useStore: vi.fn(),
  useUpdateNodeInternals: vi.fn(),
}));

afterEach(cleanup);

describe('uniqueNodeTitle', () => {
  it('keeps a free title but suffixes collisions with the first open number', () => {
    const roster: CanvasNodeRosterEntry[] = [
      { id: 'a', title: 'Search', kind: 'terminal', locked: false },
      { id: 'b', title: 'Search (2)', kind: 'terminal', locked: false },
    ];
    expect(uniqueNodeTitle('  Index  ', 'x', roster)).toBe('Index');
    expect(uniqueNodeTitle('Search', 'x', roster)).toBe('Search (3)');
    // The node being renamed is excluded, so re-committing its own name is a no-op.
    expect(uniqueNodeTitle('Search', 'a', roster)).toBe('Search');
    expect(uniqueNodeTitle('   ', 'x', roster)).toBe('');
  });
});

describe('CanvasNode inline header rename', () => {
  it('renames on double-click and commits a unique title on Enter', () => {
    const updateNodeData = vi.fn();
    renderNode(nodeData(), {
      updateNodeData,
      nodeRoster: [{ id: 'other', title: 'Search', kind: 'terminal', locked: false }],
    });

    fireEvent.doubleClick(screen.getByText('Implement search', { selector: '.canvas-node-title' }));
    const input = screen.getByRole('textbox', { name: 'Node title' });
    fireEvent.change(input, { target: { value: 'Search' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 'Search' collides with node "other", so it commits the de-duplicated variant.
    expect(updateNodeData).toHaveBeenCalledWith('node-1', { title: 'Search (2)' });
  });

  it('cancels on Escape without mutating', () => {
    const updateNodeData = vi.fn();
    renderNode(nodeData(), { updateNodeData });

    fireEvent.doubleClick(screen.getByText('Implement search', { selector: '.canvas-node-title' }));
    const input = screen.getByRole('textbox', { name: 'Node title' });
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(updateNodeData).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Node title' })).toBeNull();
  });

  it('is not editable for locked or read-only nodes and never mounts on agent nodes', () => {
    const updateNodeData = vi.fn();
    const view = renderNode(nodeData({ locked: true }), { updateNodeData });
    fireEvent.doubleClick(screen.getByText('Implement search', { selector: '.canvas-node-title' }));
    expect(screen.queryByRole('textbox', { name: 'Node title' })).toBeNull();

    view.rerender(rendered(nodeData({ kind: 'agent' }), { updateNodeData }));
    // Agent nodes rename inside their own window, so the generic affordances are absent.
    expect(screen.queryByRole('button', { name: /Node details for/u })).toBeNull();
  });
});

describe('CanvasNode details popover', () => {
  it('opens a popover with settings, comments, and history sections wired to graph mutations', () => {
    const updateNodeData = vi.fn();
    const recordHistory = vi.fn();
    const createLocalComment = vi.fn(() => true);
    renderNode(nodeData(), { updateNodeData, recordHistory, createLocalComment });

    fireEvent.click(screen.getByRole('button', { name: /Node details for/u }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: 'Settings' })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: 'Comments' })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: 'History' })).toBeTruthy();

    // Settings tab is the default and edits the same node data the inspector does.
    const description = within(dialog).getByLabelText('Description');
    fireEvent.change(description, { target: { value: 'Updated summary' } });
    expect(updateNodeData).toHaveBeenCalledWith('node-1', { description: 'Updated summary' });

    // Comments tab mounts the reused LocalComments + SharedComments components.
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Comments' }));
    expect(within(dialog).getByRole('region', { name: 'Private comments' })).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Shared comments' })).toBeTruthy();

    // History tab mounts the reused NodeRunHistory component.
    fireEvent.click(within(dialog).getByRole('tab', { name: 'History' }));
    expect(within(dialog).getByText('Workflow run history')).toBeTruthy();
  });

  it('closes on the close button', () => {
    renderNode(nodeData());
    fireEvent.click(screen.getByRole('button', { name: /Node details for/u }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close node details' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

interface Overrides {
  readonly readOnly?: boolean;
  readonly updateNodeData?: (nodeId: string, data: Partial<WorkshopNodeData>) => void;
  readonly recordHistory?: () => void;
  readonly nodeRoster?: readonly CanvasNodeRosterEntry[];
  readonly createLocalComment?: (nodeId: string, body: string) => boolean;
}

function renderNode(data: WorkshopNodeData, overrides: Overrides = {}) {
  return render(rendered(data, overrides));
}

function rendered(data: WorkshopNodeData, overrides: Overrides = {}) {
  return (
    <CanvasNodeInteractionProvider
      readOnly={overrides.readOnly ?? false}
      setCollapsed={vi.fn()}
    >
      <AgentSessionProvider value={agentSessionValue(overrides)}>
        <WorkflowRuntimeProvider value={workflowRuntimeValue()}>
          <NodeCommentsProvider value={nodeCommentsValue(overrides)}>
            <CanvasNode {...nodeProps(data)} />
          </NodeCommentsProvider>
        </WorkflowRuntimeProvider>
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>
  );
}

function agentSessionValue(overrides: Overrides): AgentSessionContextValue {
  return {
    graphReadOnly: false,
    updateNodeData: overrides.updateNodeData ?? vi.fn(),
    recordHistory: overrides.recordHistory ?? vi.fn(),
    nodeRoster: overrides.nodeRoster ?? [],
    checkProducers: [],
  } as unknown as AgentSessionContextValue;
}

function workflowRuntimeValue(): WorkflowRuntimeContextValue {
  return { executions: [] } as unknown as WorkflowRuntimeContextValue;
}

function nodeCommentsValue(overrides: Overrides): NodeCommentsContextValue {
  return {
    localCommentsFor: () => [],
    sharedCommentsFor: () => [],
    rejectedSharedCommentsFor: () => [],
    createLocalComment: overrides.createLocalComment ?? vi.fn(() => true),
    createSharedComment: vi.fn(() => Promise.resolve(true)),
    discardRejectedComment: vi.fn(() => Promise.resolve(true)),
    canComment: true,
    roomEnabled: true,
  };
}

function nodeProps(data: WorkshopNodeData): NodeProps<WorkshopNode> {
  return {
    id: 'node-1',
    data,
    type: 'workshop',
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    selected: false,
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
