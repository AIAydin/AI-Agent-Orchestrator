/**
 * jsdom implements neither `PointerEvent` nor pointer capture, and gives every element a
 * zero-sized bounding rect. Component tests that drive the whiteboard need all three
 * supplied before the pointer maths can be exercised.
 *
 * Imported only by tests; nothing in the shipped renderer references this module.
 */

import { fireEvent } from '@testing-library/react';

class JsdomPointerEvent extends MouseEvent {
  public readonly pointerId: number;

  public constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

/** Installs the pointer APIs jsdom lacks, so `fireEvent.pointerDown` carries coordinates. */
export function installPointerSupport(): void {
  Object.defineProperty(globalThis, 'PointerEvent', {
    configurable: true,
    writable: true,
    value: JsdomPointerEvent,
  });
  Object.defineProperty(Element.prototype, 'setPointerCapture', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  Object.defineProperty(Element.prototype, 'releasePointerCapture', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
}

/**
 * Replays the default action jsdom leaves out: a `mousedown` moves focus to the nearest
 * focusable ancestor of whatever the pointer landed on.
 *
 * Without it a test can press on the drawing surface and never see the focus move that a
 * real browser performs a beat later — which is exactly how a text editor that mounts
 * during the press, and dies to the blur that press causes, passes its unit tests.
 *
 * Returns the disposer.
 */
export function installMouseFocusDefault(): () => void {
  const focusOnMouseDown = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element) || event.defaultPrevented) return;
    const focusable = target.closest('[tabindex], a[href], button, input, select, textarea');
    if (focusable === null || !('focus' in focusable)) return;
    (focusable as { focus: () => void }).focus();
  };
  document.addEventListener('mousedown', focusOnMouseDown);
  return () => {
    document.removeEventListener('mousedown', focusOnMouseDown);
  };
}

/**
 * Dispatches the full event sequence a browser produces for one primary-button click,
 * in the real order: pointer events first, then their mouse-event counterparts.
 *
 * Component tests that fire only `pointerDown` cannot observe anything that happens to
 * the DOM between the press and the release.
 */
export function clickSurface(element: Element, clientX: number, clientY: number): void {
  const at = { clientX, clientY, pointerId: 1, button: 0 };
  fireEvent.pointerDown(element, { ...at, buttons: 1 });
  fireEvent.mouseDown(element, { ...at, buttons: 1 });
  fireEvent.pointerUp(element, { ...at, buttons: 0 });
  fireEvent.mouseUp(element, { ...at, buttons: 0 });
  fireEvent.click(element, { ...at, buttons: 0, detail: 1 });
}

/** Gives an element a real rect, so viewBox mapping produces meaningful coordinates. */
export function stubBoundingRect(element: Element, width = 960, height = 640): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}
