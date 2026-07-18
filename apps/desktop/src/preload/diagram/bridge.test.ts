import { describe, expect, it, vi } from 'vitest';

import { createDiagramApi } from './bridge.js';

describe('diagram preload bridge', () => {
  it('validates export input and renderer-safe output', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: { fileName: 'System map.svg' },
    });
    const api = createDiagramApi(invoke);

    await expect(api.exportSvg({ fileName: 'System map', svg: '<svg />' })).resolves.toEqual({
      ok: true,
      value: { fileName: 'System map.svg' },
    });
    expect(invoke).toHaveBeenCalledWith('diagram:export-svg', {
      fileName: 'System map.svg',
      svg: '<svg />',
    });
  });

  it('rejects hostile bridge values instead of forwarding them', async () => {
    const invoke = vi.fn();
    const api = createDiagramApi(invoke);
    await expect(api.exportSvg({ fileName: '../escape', svg: '<svg />' })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
