import { useEffect, useState, type RefObject } from 'react';

/**
 * Reports whether `ref`'s content box is at least `min` wide and tall, tracking
 * live resizes. Faces use it to defer mounting heavy children (Monaco, a Git
 * review payload) until the node is genuinely usable. When ResizeObserver is
 * unavailable (jsdom without a mock) it defaults to true, so eager mounting is
 * the safe fallback.
 */
export function useAboveMinSize(
  ref: RefObject<HTMLElement | null>,
  min: { readonly width: number; readonly height: number },
): boolean {
  const [above, setAbove] = useState(typeof ResizeObserver === 'undefined');

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (typeof ResizeObserver === 'undefined') {
      setAbove(true);
      return;
    }
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      setAbove(rect.width >= min.width && rect.height >= min.height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [min.height, min.width, ref]);

  return above;
}
