// @vitest-environment jsdom

import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { WhiteboardNodeFace } from './WhiteboardNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
const attachWhiteboardContext = vi.fn();
const exportSvg = vi.fn();

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'forgeboard');
});
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  attachWhiteboardContext.mockReset();
  exportSvg.mockReset();
  exportSvg.mockResolvedValue({ ok: true, value: { fileName: 'Mockup.svg' } });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { whiteboard: { exportSvg } },
  });
});

function sessionValue(
  roster: AgentSessionContextValue['nodeRoster'] = [],
): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    attachWhiteboardContext,
    nodeRoster: roster,
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

function renderFace(
  overrides: Partial<WorkshopNodeData> = {},
  roster: AgentSessionContextValue['nodeRoster'] = [],
) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue(roster)}>
        <WhiteboardNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

/** Controlled host that feeds updateNodeData patches back into `data`, so state
 * that depends on persisted excalidraw content (selection, export) is testable. */
function ControlledFace() {
  const [data, setData] = useState<WorkshopNodeData>(() => nodeData());
  const value = {
    project: { id: 'p1' },
    graphReadOnly: false,
    recordHistory,
    attachWhiteboardContext,
    nodeRoster: [],
    updateNodeData: (nodeId: string, patch: Partial<WorkshopNodeData>) => {
      updateNodeData(nodeId, patch);
      setData((current) => ({ ...current, ...patch }));
    },
  } as unknown as AgentSessionContextValue;
  return (
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={value}>
        <WhiteboardNodeFace id="n1" data={data} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>
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

  it('edits the selected element geometry from the popover', () => {
    render(<ControlledFace />);
    fireEvent.click(screen.getByRole('button', { name: 'Whiteboard tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'width' }), {
      target: { value: '321' },
    });
    const patch = updateNodeData.mock.calls.at(-1)?.[1] as {
      excalidraw: { elements: Array<{ width: number; isDeleted?: boolean }> };
    };
    expect(patch.excalidraw.elements.some((element) => element.width === 321)).toBe(true);
  });

  it('exports the whiteboard as an SVG through the native bridge', async () => {
    render(<ControlledFace />);
    fireEvent.click(screen.getByRole('button', { name: 'Whiteboard tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export SVG image' }));
    await waitFor(() => expect(exportSvg).toHaveBeenCalledTimes(1));
    const input = exportSvg.mock.calls[0]?.[0] as { fileName: string; svg: string };
    expect(input.fileName).toBe('Mockup.svg');
    expect(input.svg).toContain('<rect');
    expect(await screen.findByText('Exported Mockup.svg.')).toBeTruthy();
  });

  it('attaches the specification to an agent from the roster', () => {
    attachWhiteboardContext.mockReturnValue('Attached to Builder.');
    renderFace({}, [{ id: 'agent-1', title: 'Builder', kind: 'agent', locked: false }]);
    fireEvent.click(screen.getByRole('button', { name: 'Whiteboard tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Attach specification' }));
    expect(attachWhiteboardContext).toHaveBeenCalledWith('n1', 'agent-1');
    expect(screen.getByText('Attached to Builder.')).toBeTruthy();
  });
});
