// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { WhiteboardNodeFace } from './WhiteboardNodeFace.js';

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
    kind: 'whiteboard',
    title: 'Mockup',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#c482aa',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <WhiteboardNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('WhiteboardNodeFace', () => {
  it('renders the inert SVG preview as the face body', () => {
    renderFace();
    expect(screen.getByRole('img', { name: 'Inert whiteboard preview' })).toBeTruthy();
  });

  it('adds shapes from the toolbar popover and records history', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Whiteboard tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
    expect(recordHistory).toHaveBeenCalled();
    const call = updateNodeData.mock.calls.at(-1);
    expect(call?.[0]).toBe('n1');
    const patch = call?.[1] as {
      excalidraw: { elements: Array<{ type: string }> };
    };
    expect(patch.excalidraw.elements).toMatchObject([{ type: 'rectangle' }]);
  });

  it('adds annotations and tracks their ids', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Whiteboard tools' }));
    fireEvent.change(screen.getByLabelText('Annotation'), { target: { value: 'Header here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }));
    const patch = updateNodeData.mock.calls.at(-1)?.[1] as {
      excalidraw: { elements: Array<{ id: string; type: string }> };
      annotationIds: string[];
    };
    expect(patch.excalidraw.elements[0]?.type).toBe('text');
    expect(patch.annotationIds).toEqual([patch.excalidraw.elements[0]?.id]);
  });

  it('keeps the toolbar closed for locked nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByRole('button', { name: 'Whiteboard tools' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
