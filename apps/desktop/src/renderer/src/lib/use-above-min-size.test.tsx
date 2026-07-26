// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useRef, type JSX } from 'react';

import { useAboveMinSize } from './use-above-min-size.js';

afterEach(cleanup);

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- width/height document the rendered probe's intended box; the hook call below fixes the min at 100x100.
function Probe({ width, height }: { width: number; height: number }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const above = useAboveMinSize(ref, { width: 100, height: 100 });
  return (
    <div ref={ref} data-testid="probe">
      {above ? 'above' : 'below'}
    </div>
  );
}

/**
 * Mocks the layout box the hook reads. `scale` emulates an ancestor CSS zoom
 * transform: it changes what `getBoundingClientRect()` would report while
 * leaving `offsetWidth`/`offsetHeight` — the layout box — untouched.
 */
function installResizeObserver(width: number, height: number, scale = 1): void {
  class MockResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      Object.defineProperty(target, 'offsetWidth', { configurable: true, value: width });
      Object.defineProperty(target, 'offsetHeight', { configurable: true, value: height });
      vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
        width: width * scale,
        height: height * scale,
      } as DOMRect);
      this.callback([], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
}

describe('useAboveMinSize', () => {
  it('reports true once the observed box meets both minimums', () => {
    installResizeObserver(200, 200);
    render(<Probe width={200} height={200} />);
    expect(screen.getByTestId('probe').textContent).toBe('above');
    vi.unstubAllGlobals();
  });

  it('reports false when either dimension is under the minimum', () => {
    installResizeObserver(80, 200);
    render(<Probe width={80} height={200} />);
    expect(screen.getByTestId('probe').textContent).toBe('below');
    vi.unstubAllGlobals();
  });

  it('ignores the canvas zoom transform: a big node stays above when zoomed out', () => {
    // React Flow scales nodes with a CSS transform, so a rect-based measurement
    // would read 130x130 here and wrongly hide the content.
    installResizeObserver(200, 200, 0.65);
    render(<Probe width={200} height={200} />);
    expect(screen.getByTestId('probe').textContent).toBe('above');
    vi.unstubAllGlobals();
  });

  it('defaults to true when ResizeObserver is unavailable', () => {
    const original = globalThis.ResizeObserver;
    // @ts-expect-error deliberately removing the global for the fallback path
    delete globalThis.ResizeObserver;
    render(<Probe width={10} height={10} />);
    expect(screen.getByTestId('probe').textContent).toBe('above');
    globalThis.ResizeObserver = original;
  });
});
