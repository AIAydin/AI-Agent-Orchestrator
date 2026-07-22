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

function sessionValue(
  roster: AgentSessionContextValue['nodeRoster'] = [],
): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    nodeRoster: roster,
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

function renderFace(
  overrides: Partial<WorkshopNodeData> = {},
  roster: AgentSessionContextValue['nodeRoster'] = [],
) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue(roster)}>
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

  it('edits done conditions in place', () => {
    renderFace({
      acceptanceCriteria: [{ id: 'a1', description: 'Works end to end', satisfied: false }],
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark Works end to end as done' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      acceptanceCriteria: [{ id: 'a1', description: 'Works end to end', satisfied: true }],
    });
  });

  it('saves and restores versions from the history popover', () => {
    renderFace({
      markdown: '# v2',
      versions: [
        { id: 'v1', createdAt: '2026-07-19T10:00:00.000Z', markdown: '# v1', authorId: 'local-user' },
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

  it('toggles canvas attachments from the roster', () => {
    renderFace({}, [
      { id: 'file-1', title: 'Spec file', kind: 'file', locked: false },
      { id: 'n1', title: 'Login brief', kind: 'brief', locked: false },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Attach Spec file' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', { attachmentIds: ['file-1'] });
    // The brief itself is never offered as an attachment candidate.
    expect(screen.queryByRole('checkbox', { name: 'Attach Login brief' })).toBeNull();
  });

  it('adds a prompt variable in place', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Add prompt variable' }));
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', { variables: { variable_1: '' } });
  });

  it('edits and removes prompt variables', () => {
    renderFace({ variables: { tone: 'friendly' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Variable value tone' }), {
      target: { value: 'formal' },
    });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { variables: { tone: 'formal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove variable tone' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', { variables: {} });
  });
});
