// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const renderDiagram = vi.hoisted(() => vi.fn());
vi.mock('./mermaid-renderer.js', () => ({
  renderMermaidDiagram: renderDiagram,
}));

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { DiagramNodeFace } from './DiagramNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  renderDiagram.mockReset();
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
    kind: 'diagram',
    title: 'System map',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#7888d8',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <DiagramNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('DiagramNodeFace', () => {
  it('opens in the editor when there is no source and persists edits', () => {
    renderFace();
    const editor = screen.getByRole('textbox', { name: 'Mermaid source' });
    fireEvent.focus(editor);
    fireEvent.change(editor, { target: { value: 'flowchart LR\nA-->B' } });
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', { mermaidSource: 'flowchart LR\nA-->B' });
  });

  it('renders the sanitized diagram on the face when source exists', async () => {
    renderDiagram.mockResolvedValue(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered</text></svg>',
    );
    renderFace({ mermaidSource: 'flowchart LR\nA-->B' });
    expect(screen.queryByRole('textbox', { name: 'Mermaid source' })).toBeNull();
    expect(await screen.findByRole('img', { name: 'System map diagram' })).toBeTruthy();
  });

  it('reports render failures on the face', async () => {
    renderDiagram.mockRejectedValue(new Error('Parse error on line 2'));
    renderFace({ mermaidSource: 'not mermaid' });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Parse error on line 2',
    );
  });

  it('locks the editor for read-only nodes but keeps the source viewable', () => {
    renderFace({ mermaidSource: 'flowchart LR\nA-->B', locked: true });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mermaid source' }));
    const editor = screen.getByRole('textbox', { name: 'Mermaid source' });
    expect(editor).toHaveProperty('readOnly', true);
  });
});
