import { describe, expect, it, vi } from 'vitest';

import { UPDATE_IPC_CHANNELS } from '../../shared/updates/contracts.js';
import { createUpdatesApi } from './bridge.js';

describe('updates preload bridge', () => {
  it('exposes only validated update operations', async () => {
    const invoke = vi.fn((channel: string) => {
      if (channel === UPDATE_IPC_CHANNELS.cancel)
        return Promise.resolve({ ok: true, value: { cancelled: false } });
      if (channel === UPDATE_IPC_CHANNELS.openRelease)
        return Promise.resolve({ ok: true, value: true });
      return Promise.resolve({ ok: true, value: null });
    });
    const api = createUpdatesApi(invoke);
    await expect(api.check({ channel: 'stable' })).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(api.cancel()).resolves.toEqual({
      ok: true,
      value: { cancelled: false },
    });
    await expect(api.openRelease({ releaseId: 4 })).resolves.toEqual({
      ok: true,
      value: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(1, UPDATE_IPC_CHANNELS.check, {
      channel: 'stable',
    });
    await expect(api.check({ channel: 'disabled' } as never)).rejects.toThrow();
  });
});
