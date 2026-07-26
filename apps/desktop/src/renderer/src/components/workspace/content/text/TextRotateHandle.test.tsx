// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { TextRotateHandle } from './TextRotateHandle.js';

// jsdom does not implement PointerEvent, so fireEvent/dispatchEvent would
// otherwise fall back to a plain Event and drop the clientX/clientY details.
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

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function sessionValue(): AgentSessionContextValue {
  return {
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
  } as unknown as AgentSessionContextValue;
}

function renderHandle() {
  return render(
    <div className="canvas-node">
      <AgentSessionProvider value={sessionValue()}>
        <TextRotateHandle id="n1" />
      </AgentSessionProvider>
    </div>,
  );
}

describe('TextRotateHandle', () => {
  it('records history once and updates rotationDeg while dragging', () => {
    renderHandle();
    const handle = screen.getByRole('button', { name: 'Rotate text' });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 0 });
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 10, clientY: 10 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 15, clientY: 5 }),
    );

    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      rotationDeg: expect.any(Number),
    });
  });

  it('tears down window listeners on unmount so a stray pointermove is a no-op', () => {
    const view = renderHandle();
    const handle = screen.getByRole('button', { name: 'Rotate text' });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 0 });
    view.unmount();
    updateNodeData.mockClear();
    recordHistory.mockClear();

    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 20, clientY: 20 }),
    );

    expect(updateNodeData).not.toHaveBeenCalled();
    expect(recordHistory).not.toHaveBeenCalled();
  });
});
