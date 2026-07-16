import { describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../shared/application/contracts.js';
import { checkSettingsFolderReadiness } from './settings-folder-readiness.js';

const request = {
  purpose: 'managed-worktrees' as const,
  path: '/tmp/forgeboard-worktrees',
};

describe('settings folder readiness preload boundary', () => {
  it('validates the request and an exact response without resolved-path leakage', async () => {
    const value = {
      schemaVersion: 1 as const,
      request,
      state: 'ready-existing' as const,
      ready: true,
      checkedAt: '2026-07-15T18:00:00.000Z',
      reason: null,
      warning: null,
    };
    const invoke = vi.fn(() => Promise.resolve({ ok: true, value }));

    await expect(checkSettingsFolderReadiness(invoke, request)).resolves.toEqual({
      ok: true,
      value,
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.settingsCheckFolderReadiness, request);

    const leakedValue = {
      ...value,
      canonicalPath: '/private/canonical/worktrees',
    };
    invoke.mockResolvedValueOnce({ ok: true, value: leakedValue });
    await expect(checkSettingsFolderReadiness(invoke, request)).rejects.toBeTruthy();
  });

  it('rejects unsafe drafts before invoking main', async () => {
    const invoke = vi.fn();
    await expect(
      checkSettingsFolderReadiness(invoke, { ...request, path: '/tmp/a\nb' }),
    ).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});
