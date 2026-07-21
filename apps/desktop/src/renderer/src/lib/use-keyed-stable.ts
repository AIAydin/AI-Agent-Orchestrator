import { useRef } from 'react';

/**
 * Returns the same reference across renders until `key` changes. Used to keep
 * derived rosters referentially stable while the canvas nodes array identity
 * churns (drags, selection), so context values do not re-create per frame.
 */
export function useKeyedStable<T>(value: T, key: string): T {
  const ref = useRef<{ key: string; value: T }>({ key, value });
  if (ref.current.key !== key) ref.current = { key, value };
  return ref.current.value;
}
