import { useEffect, useRef, type JSX } from 'react';

import { surfacePoint } from './geometry.js';
import type { WhiteboardTextDraft } from './useWhiteboardDrawing.js';

/**
 * Inline text entry, parked over the canvas at the clicked point.
 *
 * An absolutely positioned HTML input rather than `<foreignObject>`, which is absent from
 * the SVG export allowlist and would make exported whiteboards unwritable.
 */
export function WhiteboardTextEditor({
  draft,
  surface,
  onChange,
  onCommit,
  onCancel,
}: {
  readonly draft: WhiteboardTextDraft;
  readonly surface: HTMLElement | null;
  readonly onChange: (value: string) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const rect = surface?.getBoundingClientRect();
  const [left, top] = rect === undefined ? [0, 0] : surfacePoint(rect, draft.point);

  return (
    <input
      ref={input}
      className="whiteboard-text-editor nodrag"
      aria-label="Whiteboard text"
      value={draft.value}
      maxLength={20_000}
      placeholder="Describe a screen or interaction"
      style={{ left: `${String(left)}px`, top: `${String(top)}px` }}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onCommit();
          return;
        }
        if (event.key !== 'Escape') return;
        // Must not reach the canvas, which treats Escape as "cancel the current gesture".
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    />
  );
}
