/**
 * jsdom implements neither `PointerEvent` nor pointer capture, and gives every element a
 * zero-sized bounding rect. Component tests that drive the whiteboard need all three
 * supplied before the pointer maths can be exercised.
 *
 * Imported only by tests; nothing in the shipped renderer references this module.
 */

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
