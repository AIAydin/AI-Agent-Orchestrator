// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useState, type JSX } from 'react';

import {
  createWhiteboardElement,
  parseWhiteboardDocument,
  type WhiteboardDocument,
  type WhiteboardElement,
} from '../model.js';
import { installPointerSupport, stubBoundingRect } from './pointer-testing.js';
import { useWhiteboardDrawing, type WhiteboardTool } from './useWhiteboardDrawing.js';
import { WhiteboardCanvas } from './WhiteboardCanvas.js';

beforeAll(installPointerSupport);
afterEach(cleanup);

const persist = vi.fn();

/** Hosts the canvas against the real hook, so the two are exercised together. */
function Harness({
  tool,
  readOnly = false,
  initial = [],
}: {
  readonly tool: WhiteboardTool;
  readonly readOnly?: boolean;
  readonly initial?: readonly WhiteboardElement[];
}): JSX.Element {
  const [document] = useState<WhiteboardDocument>(() => ({
    ...parseWhiteboardDocument({}),
    elements: [...initial],
  }));
  const drawing = useWhiteboardDrawing({
    document,
    annotationIds: [],
    readOnly,
    onRecordHistory: () => undefined,
    onPersist: persist,
  });
  if (drawing.tool !== tool) drawing.setTool(tool);
  return <WhiteboardCanvas drawing={drawing} readOnly={readOnly} />;
}

function prepareSurface(): SVGSVGElement {
  const surface = screen.getByRole('application', {
    name: 'Whiteboard canvas',
  }) as unknown as SVGSVGElement;
  stubBoundingRect(surface);
  return surface;
}

describe('WhiteboardCanvas drawing', () => {
  it('creates a shape spanning the drag', () => {
    persist.mockClear();
    render(<Harness tool="rectangle" />);
    const surface = prepareSurface();

    fireEvent.pointerDown(surface, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 300, clientY: 250, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 300, clientY: 250, pointerId: 1 });

    const document = persist.mock.calls[0]?.[0] as WhiteboardDocument;
    expect(document.elements[0]).toMatchObject({
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 200,
      height: 150,
    });
  });

  it('records a freehand stroke as a path', () => {
    persist.mockClear();
    render(<Harness tool="freedraw" />);
    const surface = prepareSurface();

    fireEvent.pointerDown(surface, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 60, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 60, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 60, clientY: 80, pointerId: 1 });

    const document = persist.mock.calls[0]?.[0] as WhiteboardDocument;
    expect(document.elements[0]).toMatchObject({ type: 'freedraw' });
    expect(document.elements[0]?.points).toHaveLength(3);
  });

  it('ignores a pointer move with no gesture in flight', () => {
    persist.mockClear();
    render(<Harness tool="rectangle" />);
    const surface = prepareSurface();

    fireEvent.pointerMove(surface, { clientX: 300, clientY: 250, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 300, clientY: 250, pointerId: 1 });

    expect(persist).not.toHaveBeenCalled();
  });
});

describe('WhiteboardCanvas selection', () => {
  const rectangle = createWhiteboardElement('rectangle', { x: 0, y: 0, width: 100, height: 100 });

  it('renders four resize handles for the selected element', () => {
    render(<Harness tool="select" initial={[rectangle]} />);
    const surface = prepareSurface();

    fireEvent.pointerDown(surface, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 50, clientY: 50, pointerId: 1 });

    expect(surface.querySelectorAll('[data-handle]')).toHaveLength(4);
  });

  it('resizes when a corner handle is dragged', () => {
    persist.mockClear();
    render(<Harness tool="select" initial={[rectangle]} />);
    const surface = prepareSurface();

    fireEvent.pointerDown(surface, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 50, clientY: 50, pointerId: 1 });

    const handle = surface.querySelector('[data-handle="se"]');
    expect(handle).not.toBeNull();
    if (handle === null) return;

    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 2 });
    fireEvent.pointerMove(surface, { clientX: 300, clientY: 200, pointerId: 2 });
    fireEvent.pointerUp(surface, { clientX: 300, clientY: 200, pointerId: 2 });

    const document = persist.mock.calls.at(-1)?.[0] as WhiteboardDocument;
    expect(document.elements[0]).toMatchObject({ x: 0, y: 0, width: 300, height: 200 });
  });

  it('renders no handles and accepts no gestures when read-only', () => {
    persist.mockClear();
    render(<Harness tool="select" readOnly initial={[rectangle]} />);
    const surface = prepareSurface();

    fireEvent.pointerDown(surface, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 90, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 90, clientY: 90, pointerId: 1 });

    expect(surface.querySelectorAll('[data-handle]')).toHaveLength(0);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('WhiteboardCanvas drawable area', () => {
  it('paints the background inside the viewBox rather than as a CSS background', () => {
    render(<Harness tool="select" />);
    const surface = prepareSurface();

    expect(surface.getAttribute('style')).toBeNull();
    const background = surface.querySelector('rect');
    expect(background?.getAttribute('width')).toBe('960');
    expect(background?.getAttribute('fill')).toBe('#ffffff');
  });
});
