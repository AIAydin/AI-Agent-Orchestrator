// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkflowEventEnvelope,
  WorkflowExecutionView,
  WorkflowInteractionEventEnvelope,
} from '../../../../../../shared/workflow/contracts.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { useWorkspaceWorkflowRuntime } from '../../shell/runtime/useWorkspaceWorkflowRuntime.js';
import { TestNodeFace } from '../test-node/TestNodeFace.js';
import { useWorkflowRuns } from '../useWorkflowRuns.js';
import { WorkflowRuntimeProvider } from '../WorkflowRuntimeContext.js';

const PROJECT_ID = 'test-node-project';
const CANVAS_ID = 'test-node-canvas';
const NODE_ID = 'test-node';
const EXECUTION_ID = 'test-node-execution';
const FLUSH_CANVAS = () => Promise.resolve(true);
const REVIEW_GATES = new Map();

const list = vi.fn();
const start = vi.fn();
const approveNode = vi.fn();
const cancelNode = vi.fn();
const onError = vi.fn();
const updateNodeData = vi.fn();
let eventListener: ((event: WorkflowEventEnvelope) => void) | null = null;
let interactionListener: ((event: WorkflowInteractionEventEnvelope) => void) | null = null;

beforeEach(() => {
  for (const mock of [list, start, approveNode, cancelNode, onError, updateNodeData]) {
    mock.mockReset();
  }
  list.mockResolvedValue({ ok: true, value: [] });
  cancelNode.mockResolvedValue({ ok: true, value: execution({ status: 'cancelling' }) });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      workflows: {
        list,
        start,
        approveNode,
        approveHuman: vi.fn(),
        decideReview: vi.fn(),
        resolveRevisionEscape: vi.fn(),
        cancel: vi.fn(),
        cancelNode,
        sendInput: vi.fn(),
        interrupt: vi.fn(),
        onEvent: vi.fn((listener: (event: WorkflowEventEnvelope) => void) => {
          eventListener = listener;
          return () => {
            eventListener = null;
          };
        }),
        onInteractionEvent: vi.fn((listener: (event: WorkflowInteractionEventEnvelope) => void) => {
          interactionListener = listener;
          return () => {
            interactionListener = null;
          };
        }),
      },
    },
  });
});

afterEach(() => {
  eventListener = null;
  interactionListener = null;
  cleanup();
});

describe('Test node Run', () => {
  it('runs the configured command straight away and never waits on an approval surface', async () => {
    start.mockResolvedValue({ ok: true, value: execution() });
    await renderFace();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        canvasId: CANVAS_ID,
        scope: { kind: 'node', nodeId: NODE_ID, includeUpstream: false },
      }),
    );
    expect(approveNode).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveProperty('textContent', 'Running'),
    );
    expect(screen.queryByText(/approval/iu)).toBeNull();
    expect(screen.queryByText(/Workflows/u)).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('streams live output onto the node and settles on the exit result', async () => {
    start.mockResolvedValue({ ok: true, value: execution() });
    await renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(interactionListener).not.toBeNull());

    act(() => {
      interactionListener?.({
        executionId: EXECUTION_ID,
        nodeId: NODE_ID,
        attempt: 1,
        sequence: 0,
        occurredAt: '2026-07-20T10:00:01.000Z',
        kind: 'stream',
        channel: 'stdout',
        text: '2 passing, 1 failing\n',
        truncated: false,
      });
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Test output')).toHaveProperty(
        'textContent',
        '2 passing, 1 failing\n',
      ),
    );

    act(() => {
      eventListener?.({
        type: 'node-completed',
        occurredAt: '2026-07-20T10:00:02.000Z',
        nodeId: NODE_ID,
        payload: {},
        execution: execution({
          status: 'failed',
          revision: 2,
          updatedAt: '2026-07-20T10:00:02.000Z',
          nodeRuns: [
            {
              nodeId: NODE_ID,
              status: 'failed',
              attempt: 1,
              queuedAt: '2026-07-20T10:00:00.000Z',
              statusReason: 'Exact check "Unit tests" failed with exit code 1.',
              resumable: false,
            },
          ],
          testResults: [
            {
              nodeId: NODE_ID,
              attempt: 1,
              executionId: EXECUTION_ID,
              checkExecutionId: 'check-1',
              status: 'failed',
              exitCode: 1,
              output: '2 passing, 1 failing\n',
              outputTruncated: false,
              summary: null,
              artifacts: [],
              startedAt: '2026-07-20T10:00:00.000Z',
              endedAt: '2026-07-20T10:00:02.000Z',
            },
          ],
        }),
      });
    });

    await waitFor(() => expect(screen.getByRole('status')).toHaveProperty('textContent', 'Failed'));
    expect(screen.getByText('Exact check "Unit tests" failed with exit code 1.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy();
  });

  it('stops the live attempt from the same control', async () => {
    start.mockResolvedValue({ ok: true, value: execution() });
    await renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(cancelNode).toHaveBeenCalledWith({
        executionId: EXECUTION_ID,
        nodeId: NODE_ID,
        attempt: 1,
        confirmed: true,
      }),
    );
  });

  it('never starts a run while the command is only being configured', async () => {
    await renderFace();

    fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), {
      target: { value: 'pnpm test --watch=false' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Runs the unit suite' },
    });

    expect(updateNodeData).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(approveNode).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Not run');
  });
});

async function renderFace() {
  const view = render(<Harness />);
  await waitFor(() => expect(list).toHaveBeenCalled());
  return view;
}

function Harness() {
  const [, setEvents] = useState<string[]>([]);
  const workflows = useWorkflowRuns({
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    flushCanvas: FLUSH_CANVAS,
    setEvents,
    onError,
    mutationsAuthorized: true,
  });
  const runtime = useWorkspaceWorkflowRuntime({
    workflows,
    reviewGates: REVIEW_GATES,
    requestDecision: vi.fn(),
  });
  return (
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <WorkflowRuntimeProvider value={runtime}>
          <TestNodeFace id={NODE_ID} data={nodeData()} />
        </WorkflowRuntimeProvider>
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>
  );
}

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: PROJECT_ID },
    graphReadOnly: false,
    updateNodeData,
    recordHistory: vi.fn(),
    reportError: vi.fn(),
  } as unknown as AgentSessionContextValue;
}

function nodeData(): WorkshopNodeData {
  return {
    kind: 'test',
    title: 'Unit tests',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#64a774',
    command: { executable: 'pnpm', arguments: ['test'] },
  } as WorkshopNodeData;
}

function execution(overrides: Partial<WorkflowExecutionView> = {}): WorkflowExecutionView {
  return {
    schemaVersion: 1,
    id: EXECUTION_ID,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    status: 'running',
    revision: 1,
    scope: { kind: 'node', nodeId: NODE_ID, includeUpstream: false },
    planNodeIds: [NODE_ID],
    nodeRuns: [
      {
        nodeId: NODE_ID,
        status: 'running',
        attempt: 1,
        queuedAt: '2026-07-20T10:00:00.000Z',
        startedAt: '2026-07-20T10:00:00.500Z',
        resumable: false,
      },
    ],
    edges: [],
    approvals: [],
    humanDecisions: [],
    revisionEscapes: [],
    scheduling: {
      runnableNodeIds: [],
      waitingNodeIds: [],
      waitingForApprovalNodeIds: [],
      blockedNodeIds: [],
      activeNodeIds: [NODE_ID],
    },
    cancellationRequested: false,
    testResults: [],
    canvasUpdatedAt: '2026-07-20T10:00:00.000Z',
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:00:01.000Z',
    ...overrides,
  } as WorkflowExecutionView;
}
