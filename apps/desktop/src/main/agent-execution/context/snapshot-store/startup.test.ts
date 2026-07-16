import { describe, expect, it, vi } from 'vitest';

import { attemptContextSnapshotStorageStartup } from './startup.js';

describe('context snapshot storage startup', () => {
  it('reports a successful eager warm-up', async () => {
    const initialize = vi.fn(() => Promise.resolve());

    await expect(
      attemptContextSnapshotStorageStartup(
        'C:\\Users\\Aydin\\AppData\\Roaming\\Forgeboard',
        initialize,
      ),
    ).resolves.toEqual({ ready: true });
  });

  it('contains warm-up failure so the desktop can open while later context actions retry', async () => {
    const failure = new Error('Windows permission authority is unavailable.');
    const initialize = vi.fn(async () => await Promise.reject(failure));

    const result = await attemptContextSnapshotStorageStartup(
      'C:\\Users\\Aydin\\AppData\\Roaming\\Forgeboard',
      initialize,
    );

    expect(result.ready).toBe(false);
    if (result.ready) throw new Error('Expected context snapshot startup to be deferred.');
    expect(result.error).toBe(failure);
    expect(result.reason).toMatch(/remain available.*retry.*agent launch uses context/iu);
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
