// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RAIL_WIDTH_RANGE } from './sidebar-resize.js';
import { WorkspaceResizeHandle } from './WorkspaceResizeHandle.js';

// jsdom does not implement PointerEvent, so fireEvent would otherwise fall
// back to a plain Event and drop the button/pointerId/clientX details.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}
if (typeof window.PointerEvent === 'undefined') {
  (window as unknown as { PointerEvent: typeof TestPointerEvent }).PointerEvent = TestPointerEvent;
}

afterEach(() => {
  cleanup();
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

function renderHandle(overrides: { onResize?: (width: number) => void; onReset?: () => void }) {
  render(
    <WorkspaceResizeHandle
      label="Resize project rail"
      className="rail-resize"
      edge="start"
      range={RAIL_WIDTH_RANGE}
      width={260}
      onResize={overrides.onResize ?? vi.fn()}
      onReset={overrides.onReset ?? vi.fn()}
    />,
  );
  return screen.getByRole('separator', { name: 'Resize project rail' });
}

describe('WorkspaceResizeHandle', () => {
  it('exposes focusable separator semantics with the current width', () => {
    const handle = renderHandle({});
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.getAttribute('aria-valuemin')).toBe(String(RAIL_WIDTH_RANGE.min));
    expect(handle.getAttribute('aria-valuemax')).toBe(String(RAIL_WIDTH_RANGE.max));
    expect(handle.getAttribute('aria-valuenow')).toBe('260');
  });

  it('requests keyboard adjustments in 16px steps and 64px with Shift', () => {
    const onResize = vi.fn<(width: number) => void>();
    const handle = renderHandle({ onResize });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'End' });
    fireEvent.keyDown(handle, { key: 'Tab' });
    expect(onResize.mock.calls.map(([width]) => width)).toEqual([
      276,
      196,
      RAIL_WIDTH_RANGE.min,
      RAIL_WIDTH_RANGE.max,
    ]);
  });

  it('tracks pointer drags relative to the width at pointerdown', () => {
    const onResize = vi.fn<(width: number) => void>();
    const handle = renderHandle({ onResize });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 260 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    expect(handle.getAttribute('data-dragging')).toBe('true');
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 300 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 220 });
    // Moves from another pointer are ignored.
    fireEvent.pointerMove(handle, { pointerId: 8, clientX: 900 });
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 220 });
    expect(onResize.mock.calls.map(([width]) => width)).toEqual([300, 220]);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(handle.hasAttribute('data-dragging')).toBe(false);
  });

  it('ignores non-primary buttons and moves without an active drag', () => {
    const onResize = vi.fn<(width: number) => void>();
    const handle = renderHandle({ onResize });
    fireEvent.pointerDown(handle, { button: 2, pointerId: 3, clientX: 260 });
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 400 });
    expect(onResize).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('');
  });

  it('resets to the default width on double-click', () => {
    const onReset = vi.fn();
    const handle = renderHandle({ onReset });
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
