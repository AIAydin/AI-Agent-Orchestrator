import type { JSX, KeyboardEvent, PointerEvent } from 'react';

import {
  VIEW_BOX_HEIGHT,
  VIEW_BOX_WIDTH,
  type WhiteboardBounds,
  type WhiteboardPoint,
} from '../model.js';
import { handlePosition, hitTest, viewBoxPoint, type WhiteboardHandle } from './geometry.js';
import type { WhiteboardDrawing } from './useWhiteboardDrawing.js';
import { WhiteboardShape } from './WhiteboardShape.js';
import './drawing.css';

const HANDLES: readonly WhiteboardHandle[] = ['nw', 'ne', 'sw', 'se'];
/** Handle side length in viewBox units. */
const HANDLE_SIZE = 12;

/**
 * The interactive drawing surface.
 *
 * Hit-testing is centralised here rather than on each shape, so a pointer-down anywhere on
 * the surface takes one code path. `nodrag`/`nowheel` keep React Flow from panning, zooming,
 * or dragging the node out from under a stroke.
 */
export function WhiteboardCanvas({
  drawing,
  readOnly,
  className,
}: {
  readonly drawing: WhiteboardDrawing;
  readonly readOnly: boolean;
  readonly className?: string | undefined;
}): JSX.Element {
  const document = drawing.previewDocument;
  const elements = document.elements.filter((element) => !element.isDeleted);
  const selected = elements.find((element) => element.id === drawing.selectedId) ?? null;

  const pointOf = (event: PointerEvent<SVGSVGElement>): WhiteboardPoint =>
    viewBoxPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    if (readOnly) return;
    // Focus the surface so Delete/Backspace lands here, not on the workspace canvas.
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.beginGesture(pointOf(event), handleOf(event.target));
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    if (readOnly) return;
    drawing.extendGesture(pointOf(event));
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>): void => {
    if (event.key === 'Escape') {
      drawing.cancelGesture();
      return;
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    // With no shape selected the key bubbles on, so the workspace canvas can
    // still delete the whiteboard node itself.
    if (drawing.selectedId === null) return;
    // React Flow deletes selected nodes from a document-level keydown listener;
    // stopping propagation here is what keeps the node alive while a shape dies.
    event.preventDefault();
    event.stopPropagation();
    drawing.deleteSelected();
  };

  return (
    <svg
      className={`whiteboard-canvas${className === undefined ? '' : ` ${className}`}`}
      role="application"
      aria-label="Whiteboard canvas"
      tabIndex={0}
      viewBox={`0 0 ${String(VIEW_BOX_WIDTH)} ${String(VIEW_BOX_HEIGHT)}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        drawing.endGesture();
      }}
      onPointerCancel={() => {
        drawing.cancelGesture();
      }}
      onDoubleClick={(event) => {
        if (readOnly) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const hit = hitTest(elements, viewBoxPoint(rect, event.clientX, event.clientY));
        if (hit !== null) drawing.editText(hit);
      }}
      onKeyDown={onKeyDown}
    >
      {/* Painted inside the viewBox, so the white area is exactly the drawable area. */}
      <rect
        x={0}
        y={0}
        width={VIEW_BOX_WIDTH}
        height={VIEW_BOX_HEIGHT}
        fill={document.appState.viewBackgroundColor}
      />
      {elements.map((element) => (
        <WhiteboardShape
          key={element.id}
          element={element}
          selected={element.id === drawing.selectedId}
        />
      ))}
      {drawing.draftElement === null ? null : (
        <WhiteboardShape element={drawing.draftElement} selected={false} />
      )}
      {selected === null || readOnly ? null : <SelectionOverlay bounds={selected} />}
    </svg>
  );
}

function SelectionOverlay({ bounds }: { readonly bounds: WhiteboardBounds }): JSX.Element {
  return (
    <g aria-hidden="true">
      <rect
        className="whiteboard-canvas-outline"
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        fill="none"
      />
      {HANDLES.map((handle) => {
        const [x, y] = handlePosition(bounds, handle);
        return (
          <rect
            key={handle}
            className="whiteboard-canvas-handle"
            data-handle={handle}
            x={x - HANDLE_SIZE / 2}
            y={y - HANDLE_SIZE / 2}
            width={HANDLE_SIZE}
            height={HANDLE_SIZE}
          />
        );
      })}
    </g>
  );
}

/** Reads which resize handle a pointer landed on, if any. */
function handleOf(target: EventTarget): WhiteboardHandle | undefined {
  if (!(target instanceof Element)) return undefined;
  const value = target.getAttribute('data-handle');
  return HANDLES.find((handle) => handle === value);
}
