// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePeerTransitPulse } from './usePeerTransitPulse.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePeerTransitPulse', () => {
  it('adds an edge id to the pulsing set when an event fires, then removes it after durationMs', () => {
    vi.useFakeTimers();
    let emit: ((event: { edgeId: string }) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((cb: (event: { edgeId: string }) => void) => {
      emit = cb;
      return unsubscribe;
    });

    const { result } = renderHook(() => usePeerTransitPulse(subscribe, 1600));

    expect(result.current.has('edge-1')).toBe(false);

    act(() => {
      emit?.({ edgeId: 'edge-1' });
    });
    expect(result.current.has('edge-1')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1599);
    });
    expect(result.current.has('edge-1')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.has('edge-1')).toBe(false);
  });

  it('resets the timer instead of stacking duplicates when the same edge repeats', () => {
    vi.useFakeTimers();
    let emit: ((event: { edgeId: string }) => void) | undefined;
    const subscribe = vi.fn((cb: (event: { edgeId: string }) => void) => {
      emit = cb;
      return vi.fn();
    });

    const { result } = renderHook(() => usePeerTransitPulse(subscribe, 1600));

    act(() => {
      emit?.({ edgeId: 'edge-1' });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // Repeat event before the first timer would fire: should extend, not stack.
    act(() => {
      emit?.({ edgeId: 'edge-1' });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 2000ms since the first event, but only 1000ms since the reset -- still pulsing.
    expect(result.current.has('edge-1')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(600);
    });
    // Now 1600ms since the reset: removed.
    expect(result.current.has('edge-1')).toBe(false);
  });

  it('tracks multiple edges independently', () => {
    vi.useFakeTimers();
    let emit: ((event: { edgeId: string }) => void) | undefined;
    const subscribe = vi.fn((cb: (event: { edgeId: string }) => void) => {
      emit = cb;
      return vi.fn();
    });

    const { result } = renderHook(() => usePeerTransitPulse(subscribe, 1600));

    act(() => {
      emit?.({ edgeId: 'edge-1' });
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    act(() => {
      emit?.({ edgeId: 'edge-2' });
    });

    expect(result.current.has('edge-1')).toBe(true);
    expect(result.current.has('edge-2')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(800);
    });
    // edge-1 has now been pulsing for 1600ms: removed. edge-2 only 800ms: still pulsing.
    expect(result.current.has('edge-1')).toBe(false);
    expect(result.current.has('edge-2')).toBe(true);
  });

  it('subscribes exactly once and unsubscribes on unmount', () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);

    const { unmount, rerender } = renderHook(() => usePeerTransitPulse(subscribe, 1600));
    rerender();
    rerender();

    expect(subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('clears pending timers on unmount without throwing', () => {
    vi.useFakeTimers();
    let emit: ((event: { edgeId: string }) => void) | undefined;
    const subscribe = vi.fn((cb: (event: { edgeId: string }) => void) => {
      emit = cb;
      return vi.fn();
    });

    const { unmount } = renderHook(() => usePeerTransitPulse(subscribe, 1600));
    act(() => {
      emit?.({ edgeId: 'edge-1' });
    });

    unmount();

    expect(() => {
      act(() => {
        vi.advanceTimersByTime(2000);
      });
    }).not.toThrow();
  });

  it('defaults durationMs to 1600ms', () => {
    vi.useFakeTimers();
    let emit: ((event: { edgeId: string }) => void) | undefined;
    const subscribe = vi.fn((cb: (event: { edgeId: string }) => void) => {
      emit = cb;
      return vi.fn();
    });

    const { result } = renderHook(() => usePeerTransitPulse(subscribe));

    act(() => {
      emit?.({ edgeId: 'edge-1' });
    });
    act(() => {
      vi.advanceTimersByTime(1599);
    });
    expect(result.current.has('edge-1')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.has('edge-1')).toBe(false);
  });
});
