// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import type { FileTargetEntry } from '../../runs/agent-session/AgentSessionContext.js';
import { TaskNodeFace } from './TaskNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
let fileTargets: FileTargetEntry[] = [];

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  fileTargets = [];
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    nodeRoster: [
      { id: 'agent-1', title: 'Builder', kind: 'agent', locked: false },
      { id: 'file-1', title: 'Spec', kind: 'file', locked: false },
    ],
    checkProducers: [],
    fileTargets,
  } as unknown as AgentSessionContextValue;
}

const specFile = {
  projectId: 'p1',
  relativePath: 'src/spec.ts',
  kind: 'file' as const,
  missing: false,
};

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'task',
    title: 'Build login',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#58a6a6',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <TaskNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('TaskNodeFace', () => {
  it('edits status, assignee, and priority as compact rows', () => {
    renderFace();
    fireEvent.change(screen.getByLabelText('Task status'), { target: { value: 'in-progress' } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { taskStatus: 'in-progress' });
    fireEvent.change(screen.getByLabelText('Assigned agent'), { target: { value: 'agent-1' } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { assigneeId: 'agent-1' });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'urgent' } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { priority: 'urgent' });
  });

  it('offers only agent nodes as assignees', () => {
    renderFace();
    const options = [...screen.getByLabelText('Assigned agent').querySelectorAll('option')].map(
      (option) => option.value,
    );
    expect(options).toEqual(['', 'agent-1']);
  });

  it('edits done conditions in place', () => {
    renderFace({
      acceptanceCriteria: [{ id: 'a1', description: 'Tests pass', satisfied: false }],
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark Tests pass as done' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      acceptanceCriteria: [{ id: 'a1', description: 'Tests pass', satisfied: true }],
    });
  });

  it('disables every control for read-only nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByLabelText('Task status')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Assigned agent')).toHaveProperty('disabled', true);
  });

  it('relates a file node when its box is checked', () => {
    fileTargets = [{ nodeId: 'file-1', title: 'Spec', file: specFile }];
    renderFace();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Relate src/spec.ts' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', { relatedFiles: [specFile] });
  });

  it('unrelates an already-related file when unchecked', () => {
    fileTargets = [{ nodeId: 'file-1', title: 'Spec', file: specFile }];
    renderFace({ relatedFiles: [specFile] });
    const box = screen.getByRole('checkbox', { name: 'Relate src/spec.ts' });
    expect(box).toHaveProperty('checked', true);
    fireEvent.click(box);
    expect(updateNodeData).toHaveBeenCalledWith('n1', { relatedFiles: [] });
  });

  it('offers no related-files picker without file targets', () => {
    renderFace();
    expect(screen.queryByRole('checkbox', { name: 'Relate src/spec.ts' })).toBeNull();
  });
});
