// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useKeyedStable } from './use-keyed-stable.js';

describe('useKeyedStable', () => {
  it('keeps the previous reference while the key is unchanged', () => {
    const first = [{ id: 'a' }];
    const { result, rerender } = renderHook(
      ({ value, key }: { value: readonly { id: string }[]; key: string }) =>
        useKeyedStable(value, key),
      { initialProps: { value: first, key: 'a' } },
    );
    expect(result.current).toBe(first);
    rerender({ value: [{ id: 'a' }], key: 'a' });
    expect(result.current).toBe(first);
  });

  it('adopts the new value when the key changes', () => {
    const first = [{ id: 'a' }];
    const second = [{ id: 'b' }];
    const { result, rerender } = renderHook(
      ({ value, key }: { value: readonly { id: string }[]; key: string }) =>
        useKeyedStable(value, key),
      { initialProps: { value: first, key: 'a' } },
    );
    rerender({ value: second, key: 'b' });
    expect(result.current).toBe(second);
  });
});
