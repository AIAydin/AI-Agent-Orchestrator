import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { keyboardSidebarWidth, type SidebarEdge, type SidebarRange } from './sidebar-resize.js';

interface WorkspaceResizeHandleProps {
  readonly label: string;
  readonly className: string;
  /** Which side of the handle the resized sidebar sits on. */
  readonly edge: SidebarEdge;
  readonly range: SidebarRange;
  /** The sidebar's current effective width in pixels. */
  readonly width: number;
  readonly onResize: (width: number) => void;
  readonly onReset: () => void;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
}

function beginBodyDragFeedback(): void {
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function endBodyDragFeedback(): void {
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

/**
 * A VS Code-style vertical divider: drag with the pointer, nudge with the
 * arrow keys, jump with Home/End, and double-click to restore the default
 * width. Exposed as a focusable separator so assistive technology announces
 * the current width.
 */
export function WorkspaceResizeHandle({
  label,
  className,
  edge,
  range,
  width,
  onResize,
  onReset,
}: WorkspaceResizeHandleProps) {
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    return () => {
      if (drag.current !== null) endBodyDragFeedback();
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    setDragging(true);
    beginBodyDragFeedback();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    const delta = event.clientX - state.startX;
    onResize(state.startWidth + (edge === 'start' ? delta : -delta));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    endBodyDragFeedback();
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = keyboardSidebarWidth(event.key, event.shiftKey, width, range, edge);
    if (next === null) return;
    event.preventDefault();
    onResize(next);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={Math.round(width)}
      className={`workspace-resize-handle ${className}`}
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
