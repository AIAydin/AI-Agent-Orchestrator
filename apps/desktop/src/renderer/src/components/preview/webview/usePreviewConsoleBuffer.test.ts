// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  MAX_PREVIEW_CONSOLE_BYTES,
  MAX_PREVIEW_CONSOLE_ENTRIES,
  type PreviewConsoleMessage,
} from '../../../../../shared/preview/console.js';
import { usePreviewConsoleBuffer } from './usePreviewConsoleBuffer.js';

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function message(text: string): PreviewConsoleMessage {
  return { level: 'info', message: text, source: null, line: null };
}

describe('usePreviewConsoleBuffer', () => {
  it('appends entries with increasing sequence numbers and ISO capturedAt timestamps', () => {
    const { result } = renderHook(() => usePreviewConsoleBuffer());

    act(() => result.current.append(message('first')));
    act(() => result.current.append(message('second')));
    act(() => result.current.append(message('third')));

    const { entries } = result.current.view;
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
    expect(entries.map((entry) => entry.message)).toEqual(['first', 'second', 'third']);
    for (const entry of entries) {
      expect(entry.capturedAt).toMatch(ISO_8601);
    }
    expect(result.current.view.truncated).toBe(false);
  });

  it('evicts the oldest entries and sets truncated once MAX_PREVIEW_CONSOLE_ENTRIES is exceeded', () => {
    const { result } = renderHook(() => usePreviewConsoleBuffer());

    act(() => {
      for (let index = 0; index < MAX_PREVIEW_CONSOLE_ENTRIES + 1; index += 1) {
        result.current.append(message('x'));
      }
    });

    const { entries, truncated } = result.current.view;
    expect(entries).toHaveLength(MAX_PREVIEW_CONSOLE_ENTRIES);
    expect(truncated).toBe(true);
    // The very first append (sequence 0) must have been evicted; the oldest
    // surviving entry is the second append (sequence 1).
    expect(entries[0]?.sequence).toBe(1);
    expect(entries[entries.length - 1]?.sequence).toBe(MAX_PREVIEW_CONSOLE_ENTRIES);
  });

  it('caps retained bytes at MAX_PREVIEW_CONSOLE_BYTES by evicting oldest entries first', () => {
    const { result } = renderHook(() => usePreviewConsoleBuffer());
    const chunkBytes = 50_000;
    const chunk = 'x'.repeat(chunkBytes);

    // Five chunks stay under the cap (250,000 <= 262,144).
    act(() => {
      for (let index = 0; index < 5; index += 1) {
        result.current.append(message(chunk));
      }
    });
    expect(result.current.view.retainedBytes).toBe(chunkBytes * 5);
    expect(result.current.view.truncated).toBe(false);

    // A sixth chunk pushes total bytes over the cap, forcing eviction of the
    // oldest chunk and flipping truncated to true.
    act(() => result.current.append(message(chunk)));

    expect(result.current.view.retainedBytes).toBeLessThanOrEqual(MAX_PREVIEW_CONSOLE_BYTES);
    expect(result.current.view.retainedBytes).toBe(chunkBytes * 5);
    expect(result.current.view.entries).toHaveLength(5);
    expect(result.current.view.truncated).toBe(true);
  });
});
