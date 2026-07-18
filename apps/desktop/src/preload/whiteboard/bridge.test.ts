import { describe, expect, it, vi } from 'vitest';

import { createWhiteboardApi } from './bridge.js';

describe('whiteboard preload bridge', () => {
  it('validates export input and renderer-safe output', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: { fileName: 'Checkout mockup.svg' },
    });
    const api = createWhiteboardApi(invoke);

    await expect(api.exportSvg({ fileName: 'Checkout mockup', svg: '<svg />' })).resolves.toEqual({
      ok: true,
      value: { fileName: 'Checkout mockup.svg' },
    });
    expect(invoke).toHaveBeenCalledWith('whiteboard:export-svg', {
      fileName: 'Checkout mockup.svg',
      svg: '<svg />',
    });
  });

  it('does not forward hostile path-like names', async () => {
    const invoke = vi.fn();
    const api = createWhiteboardApi(invoke);
    await expect(api.exportSvg({ fileName: '../escape', svg: '<svg />' })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
