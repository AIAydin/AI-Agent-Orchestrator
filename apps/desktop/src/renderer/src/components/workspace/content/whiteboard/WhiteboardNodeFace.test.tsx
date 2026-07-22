// @vitest-environment jsdom

import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { installPointerSupport, stubBoundingRect } from './drawing/pointer-testing.js';
import { WhiteboardNodeFace } from './WhiteboardNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
const attachWhiteboardContext = vi.fn();
const exportSvg = vi.fn();

beforeAll(installPointerSupport);
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

interface PersistedPatch {
  excalidraw: { elements: { id: string; type: string; width: number; isDeleted?: boolean }[] };
  annotationIds: string[];
}

function lastPatch(): PersistedPatch {
  return updateNodeData.mock.calls.at(-1)?.[1] as PersistedPatch;
}

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

/** Controlled host that feeds updateNodeData patches back into `data`, so state that
 * depends on persisted excalidraw content (selection, export) is testable. */
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

function canvas(): SVGSVGElement {
  const surface = screen.getByRole('application', {
    name: 'Whiteboard canvas',
  }) as unknown as SVGSVGElement;
  stubBoundingRect(surface);
  return surface;
}

/** Picks a tool, then drags across the canvas. */
function drag(tool: string, from: [number, number], to: [number, number]): void {
  fireEvent.click(screen.getByRole('button', { name: tool }));
  const surface = canvas();
  fireEvent.pointerDown(surface, { clientX: from[0], clientY: from[1], pointerId: 1 });
  fireEvent.pointerMove(surface, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(surface, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

describe('WhiteboardNodeFace drawing', () => {
  it('renders the drawing canvas as the face body', () => {
    renderFace();
    expect(screen.getByRole('application', { name: 'Whiteboard canvas' })).toBeTruthy();
  });

  it('creates a shape spanning the drag and records history once', () => {
    renderFace();
    drag('Draw rectangle', [100, 100], [300, 250]);

    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(updateNodeData.mock.calls.at(-1)?.[0]).toBe('n1');
    expect(lastPatch().excalidraw.elements).toMatchObject([
      { type: 'rectangle', x: 100, y: 100, width: 200, height: 150 },
    ]);
  });

  it('records a freehand stroke', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Draw freehand' }));
    const surface = canvas();
    fireEvent.pointerDown(surface, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 60, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 90, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 90, clientY: 80, pointerId: 1 });

    expect(lastPatch().excalidraw.elements).toMatchObject([{ type: 'freedraw' }]);
  });

  it('persists nothing while a drag is still in flight', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Draw ellipse' }));
    const surface = canvas();
    fireEvent.pointerDown(surface, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 200, clientY: 200, pointerId: 1 });

    expect(updateNodeData).not.toHaveBeenCalled();
  });
});

describe('WhiteboardNodeFace inline text', () => {
  it('commits typed text at the clicked point and tracks the annotation', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }));
    fireEvent.pointerDown(canvas(), { clientX: 40, clientY: 60, pointerId: 1 });

    const input = screen.getByRole('textbox', { name: 'Whiteboard text' });
    fireEvent.change(input, { target: { value: 'Login screen' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const patch = lastPatch();
    expect(patch.excalidraw.elements).toMatchObject([{ type: 'text', x: 40, y: 60 }]);
    expect(patch.annotationIds).toEqual([patch.excalidraw.elements[0]?.id]);
  });

  it('discards the draft on Escape', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }));
    fireEvent.pointerDown(canvas(), { clientX: 40, clientY: 60, pointerId: 1 });

    const input = screen.getByRole('textbox', { name: 'Whiteboard text' });
    fireEvent.change(input, { target: { value: 'Discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(updateNodeData).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Whiteboard text' })).toBeNull();
  });
});

describe('WhiteboardNodeFace locking', () => {
  it('disables every tool and the popover for locked nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByRole('button', { name: 'Whiteboard tools' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Draw rectangle' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Draw freehand' })).toHaveProperty('disabled', true);
  });

  it('ignores drags on a locked node', () => {
    renderFace({ locked: true });
    const surface = canvas();
    fireEvent.pointerDown(surface, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 200, clientY: 200, pointerId: 1 });

    expect(updateNodeData).not.toHaveBeenCalled();
  });
});

describe('WhiteboardNodeFace popover', () => {
  it('still edits the selected element geometry precisely', () => {
    render(<ControlledFace />);
    drag('Draw rectangle', [100, 100], [300, 250]);
    fireEvent.click(screen.getByRole('button', { name: 'Whiteboard tools' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'width' }), {
      target: { value: '321' },
    });

    expect(lastPatch().excalidraw.elements.some((element) => element.width === 321)).toBe(true);
  });

  it('deletes the selected element', () => {
    render(<ControlledFace />);
    drag('Draw rectangle', [100, 100], [300, 250]);
    fireEvent.click(screen.getByRole('button', { name: 'Whiteboard tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected element' }));

    expect(lastPatch().excalidraw.elements.every((element) => element.isDeleted === true)).toBe(
      true,
    );
  });

  it('exports the whiteboard as an SVG through the native bridge', async () => {
    render(<ControlledFace />);
    drag('Draw rectangle', [100, 100], [300, 250]);
    fireEvent.click(screen.getByRole('button', { name: 'Whiteboard tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export SVG image' }));

    await waitFor(() => {
      expect(exportSvg).toHaveBeenCalledTimes(1);
    });
    const input = exportSvg.mock.calls[0]?.[0] as { fileName: string; svg: string };
    expect(input.fileName).toBe('Mockup.svg');
    expect(input.svg).toContain('rx="6"');
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
