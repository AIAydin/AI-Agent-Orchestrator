// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { TextNodeFace } from './TextNodeFace.js';
import { requestTextEdit } from './text-edit-bus.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

function sessionValue(): AgentSessionContextValue {
  return {
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'text',
    title: 'Text',
    description: 'A floating text label',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#8f9bb3',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <TextNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('TextNodeFace', () => {
  it('starts editing when mounted empty and writes text changes', () => {
    renderFace();
    const editor = screen.getByLabelText('Text content');
    expect(recordHistory).toHaveBeenCalledTimes(1);
    fireEvent.change(editor, { target: { value: 'Move fast' } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { text: 'Move fast' });
  });

  it('shows committed text and re-enters editing on double click', () => {
    renderFace({ text: 'Hello' });
    const display = screen.getByText('Hello');
    fireEvent.doubleClick(display);
    expect(screen.getByLabelText('Text content')).toBeTruthy();
  });

  it('shows a placeholder for committed empty text and none while locked', () => {
    renderFace({ text: '', locked: true });
    expect(screen.getByText('Type…')).toBeTruthy();
    expect(screen.queryByLabelText('Text content')).toBeNull();
  });

  it('enters editing when the edit bus targets this node', () => {
    renderFace({ text: 'Hi' });
    act(() => {
      requestTextEdit('n1');
    });
    expect(screen.getByLabelText('Text content')).toBeTruthy();
  });

  it('caps text at 10k characters', () => {
    renderFace();
    const editor = screen.getByLabelText('Text content');
    fireEvent.change(editor, { target: { value: 'x'.repeat(10_050) } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { text: 'x'.repeat(10_000) });
  });
});
