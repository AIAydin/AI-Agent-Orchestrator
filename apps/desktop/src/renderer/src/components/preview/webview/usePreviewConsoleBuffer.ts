import { useCallback, useMemo, useRef, useState } from 'react';

import {
  MAX_PREVIEW_CONSOLE_BYTES,
  MAX_PREVIEW_CONSOLE_ENTRIES,
  PREVIEW_CONSOLE_DISCLOSURE,
  type PreviewConsoleEntry,
  type PreviewConsoleMessage,
  type PreviewConsoleView,
} from '../../../../../shared/preview/console.js';

interface BufferState {
  entries: PreviewConsoleEntry[];
  truncated: boolean;
  retainedBytes: number;
}

/** Renderer-side bounded console buffer fed by webview console-message events. */
export function usePreviewConsoleBuffer(): {
  view: PreviewConsoleView;
  append(message: PreviewConsoleMessage): void;
} {
  const sequenceRef = useRef(0);
  const [state, setState] = useState<BufferState>({
    entries: [],
    truncated: false,
    retainedBytes: 0,
  });

  const append = useCallback((message: PreviewConsoleMessage) => {
    const entry: PreviewConsoleEntry = {
      ...message,
      sequence: sequenceRef.current++,
      capturedAt: new Date().toISOString(),
    };
    setState((current) => {
      const entries = [...current.entries, entry];
      let retainedBytes = current.retainedBytes + utf8Length(entry.message);
      let truncated = current.truncated;
      while (
        entries.length > MAX_PREVIEW_CONSOLE_ENTRIES ||
        retainedBytes > MAX_PREVIEW_CONSOLE_BYTES
      ) {
        const removed = entries.shift();
        if (!removed) break;
        retainedBytes -= utf8Length(removed.message);
        truncated = true;
      }
      return { entries, truncated, retainedBytes };
    });
  }, []);

  const view = useMemo<PreviewConsoleView>(
    () => ({
      entries: state.entries,
      truncated: state.truncated,
      retainedBytes: state.retainedBytes,
      disclosure: PREVIEW_CONSOLE_DISCLOSURE,
    }),
    [state],
  );

  return { view, append };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
