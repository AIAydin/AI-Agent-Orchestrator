// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkshopNodeData } from './CanvasNode.js';
import { CanvasNodeInteractionProvider } from './interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';
import { GroupFrameNodeFace } from './GroupFrameNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
const fitGroupFrame = vi.fn();
const arrangeGroupFrame = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  fitGroupFrame.mockClear();
  arrangeGroupFrame.mockClear();
});

function sessionValue(): AgentSessionContextValue {
  return {
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    fitGroupFrame,
    arrangeGroupFrame,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'group-frame',
    title: 'Feature group',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#8d7de8',
    ...overrides,
  } as unknown as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <GroupFrameNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('GroupFrameNodeFace', () => {
  it('shows the member count', () => {
    renderFace({ childNodeIds: ['a', 'b'] });
    expect(screen.getByText('2 members')).toBeTruthy();
  });

  it('changes the member layout in place', () => {
    renderFace({ childNodeIds: ['a'] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Member layout' }), {
      target: { value: 'grid' },
    });
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', { layout: 'grid' });
  });

  it('fits the group to its members', () => {
    renderFace({ childNodeIds: ['a'] });
    fireEvent.click(screen.getByRole('button', { name: 'Fit to members' }));
    expect(fitGroupFrame).toHaveBeenCalledWith('n1');
  });

  it('arranges members for a non-freeform layout', () => {
    renderFace({ childNodeIds: ['a'], layout: 'grid' });
    fireEvent.click(screen.getByRole('button', { name: 'Arrange members' }));
    expect(arrangeGroupFrame).toHaveBeenCalledWith('n1', 'grid');
  });

  it('disables arrange while the layout is freeform', () => {
    renderFace({ childNodeIds: ['a'], layout: 'freeform' });
    const arrange = screen.getByRole('button', { name: 'Arrange members' });
    expect(arrange.hasAttribute('disabled')).toBe(true);
  });

  it('disables the fit button when the group has no members', () => {
    renderFace();
    const fit = screen.getByRole('button', { name: 'Fit to members' });
    expect(fit.hasAttribute('disabled')).toBe(true);
  });
});
