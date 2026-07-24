// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkspaceSidebarLayout } from '../useWorkspaceSidebarLayout.js';

const STORAGE_KEY = 'forgeboard.view-preferences.v1';

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Pick<Storage, 'clear' | 'getItem' | 'removeItem' | 'setItem'>,
  });
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useWorkspaceSidebarLayout', () => {
  it('defaults legacy preferences to an open project sidebar', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ railWidth: 320 }));

    const { result } = renderHook(() => useWorkspaceSidebarLayout());

    expect(result.current.rail.collapsed).toBe(false);
  });

  it('restores and persists the project sidebar visibility', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ railWidth: null, railCollapsed: true }),
    );
    const { result } = renderHook(() => useWorkspaceSidebarLayout());

    expect(result.current.rail.collapsed).toBe(true);

    act(() => {
      result.current.rail.toggleCollapsed();
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.rail.collapsed).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      railCollapsed: false,
    });
  });
});
