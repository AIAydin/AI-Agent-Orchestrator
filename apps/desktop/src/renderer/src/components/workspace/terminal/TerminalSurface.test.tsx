// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalSurface, type TerminalSurfaceHandle } from './TerminalSurface.js';

const xterm = vi.hoisted(() => ({
  instances: [] as MockTerminal[],
  fits: [] as MockFitAddon[],
}));

vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }));

class MockFitAddon {
  readonly fit = vi.fn();

  constructor() {
    xterm.fits.push(this);
  }
}

class MockTerminal {
  readonly write = vi.fn();
  readonly clear = vi.fn();
  readonly clearSelection = vi.fn();
  readonly focus = vi.fn();
  readonly reset = vi.fn();
  readonly select = vi.fn();
  readonly scrollToLine = vi.fn();
  readonly dispose = vi.fn();
  readonly loadAddon = vi.fn();
  readonly open = vi.fn();
  readonly initialOptions: Record<string, unknown>;
  readonly options: { disableStdin?: boolean };
  readonly cols = 120;
  readonly rows = 40;
  readonly buffer = {
    active: {
      length: 2,
      getLine: (row: number) => ({
        translateToString: () => (row === 0 ? 'booted' : 'ready for input'),
      }),
    },
  };
  private dataListener: ((data: string) => void) | null = null;

  constructor(options: { disableStdin?: boolean } & Record<string, unknown>) {
    this.initialOptions = { ...options };
    this.options = { ...options };
    xterm.instances.push(this);
  }

  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose: vi.fn() };
  }

  emitData(data: string): void {
    this.dataListener?.(data);
  }
}

class MockResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(): void {
    this.callback([], this as unknown as ResizeObserver);
  }

  disconnect(): void {}

  unobserve(): void {}
}

beforeEach(() => {
  xterm.instances.length = 0;
  xterm.fits.length = 0;
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    value: 400,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TerminalSurface', () => {
  it('writes raw ANSI, forwards raw key data, fits/resizes, searches, and clears locally', async () => {
    const onInput = vi.fn();
    const onResize = vi.fn();
    const ref = createRef<TerminalSurfaceHandle>();
    const view = render(
      <TerminalSurface
        ref={ref}
        sessionId="session-1"
        output={[{ sequence: 1, data: '\u001b[32mready\u001b[0m\r\n' }]}
        inputEnabled
        onInput={onInput}
        onResize={onResize}
      />,
    );
    await waitFor(() => expect(xterm.instances).toHaveLength(1));
    const terminal = xterm.instances[0];
    expect(terminal?.write).toHaveBeenCalledWith('\u001b[32mready\u001b[0m\r\n');
    expect(terminal?.initialOptions).toMatchObject({
      cursorWidth: 2,
      fontSize: 13,
      fontWeightBold: '600',
      lineHeight: 1.32,
      minimumContrastRatio: 5.5,
      scrollSensitivity: 1,
      smoothScrollDuration: 0,
    });
    expect(xterm.fits[0]?.fit).toHaveBeenCalled();
    expect(onResize).toHaveBeenCalledWith(120, 40);

    terminal?.emitData('\u001b[A');
    expect(onInput).toHaveBeenCalledWith('\u001b[A');
    view.rerender(
      <TerminalSurface
        ref={ref}
        sessionId="session-1"
        output={[
          { sequence: 1, data: '\u001b[32mready\u001b[0m\r\n' },
          { sequence: 2, data: 'next\r\n' },
        ]}
        inputEnabled={false}
        onInput={onInput}
        onResize={onResize}
      />,
    );
    expect(terminal?.write).toHaveBeenCalledWith('next\r\n');
    terminal?.emitData('blocked');
    expect(onInput).toHaveBeenCalledTimes(1);

    expect(ref.current?.findNext('ready')).toBe(true);
    expect(terminal?.select).toHaveBeenCalledWith(0, 1, 5);
    ref.current?.clearDisplay();
    expect(terminal?.clear).toHaveBeenCalled();
    expect(terminal?.write).toHaveBeenCalledWith('\u001b[2J\u001b[H');

    view.rerender(
      <TerminalSurface
        ref={ref}
        sessionId="session-2"
        output={[{ sequence: 1, data: 'fresh session\r\n' }]}
        inputEnabled={false}
        onInput={onInput}
        onResize={onResize}
      />,
    );
    await waitFor(() => expect(xterm.instances).toHaveLength(2));
    expect(terminal?.dispose).toHaveBeenCalled();
    expect(xterm.instances[1]?.write).toHaveBeenCalledWith('fresh session\r\n');

    view.unmount();
    expect(xterm.instances[1]?.dispose).toHaveBeenCalled();
  });
});
