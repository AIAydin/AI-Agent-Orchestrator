// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';
import { BriefNodeFace } from './BriefNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'brief',
    title: 'Login brief',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#8d7de8',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <BriefNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('BriefNodeFace', () => {
  it('adds checklist items in place', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Add checklist item' }));
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      checklist: [expect.objectContaining({ label: 'New requirement', checked: false })],
    });
  });

  it('toggles checklist completion in place', () => {
    renderFace({ checklist: [{ id: 'c1', label: 'Design ready', checked: false }] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete Design ready' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      checklist: [{ id: 'c1', label: 'Design ready', checked: true }],
    });
  });

  it('saves and restores versions from the history popover', () => {
    renderFace({
      markdown: '# v2',
      versions: [
        {
          id: 'v1',
          createdAt: '2026-07-19T10:00:00.000Z',
          markdown: '# v1',
          authorId: 'local-user',
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Version history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save brief version' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      versions: [
        expect.objectContaining({ markdown: '# v1' }),
        expect.objectContaining({ markdown: '# v2' }),
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Restore brief version/ }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', { markdown: '# v1' });
  });

  it('ignores legacy attachment, variable, and done-when data without rendering them', () => {
    renderFace({
      acceptanceCriteria: [{ id: 'a1', description: 'Works end to end', satisfied: false }],
      attachmentIds: ['file-1'],
      variables: { tone: 'friendly' },
    });
    expect(screen.queryByText('Done when')).toBeNull();
    expect(screen.queryByText('Attached items')).toBeNull();
    expect(screen.queryByText('Prompt variables')).toBeNull();
    expect(screen.getByText('Checklist')).toBeTruthy();
  });
});
