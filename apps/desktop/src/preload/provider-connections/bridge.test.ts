import { describe, expect, it, vi } from 'vitest';

import { PROVIDER_CONNECTION_IPC_CHANNELS } from '../../shared/provider-connections/index.js';
import { createProviderConnectionsApi } from './bridge.js';

const PLAN_ID = '10000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T12:00:00.000Z';

describe('createProviderConnectionsApi', () => {
  it('validates and forwards only the narrow provider connection requests', async () => {
    const failure = { ok: false as const, error: { code: 'FAILED', message: 'Unavailable.' } };
    const invoke = vi.fn().mockResolvedValue(failure);
    const api = createProviderConnectionsApi(invoke);
    await expect(api.get({ providerId: 'codex' })).resolves.toEqual(failure);
    await expect(api.prepare({ providerId: 'claude', action: 'connect' })).resolves.toEqual(
      failure,
    );
    await expect(api.confirm({ planId: PLAN_ID })).resolves.toEqual(failure);
    await expect(api.cancel({ planId: PLAN_ID })).resolves.toEqual(failure);
    expect(invoke.mock.calls).toEqual([
      [PROVIDER_CONNECTION_IPC_CHANNELS.get, { providerId: 'codex' }],
      [PROVIDER_CONNECTION_IPC_CHANNELS.prepare, { providerId: 'claude', action: 'connect' }],
      [PROVIDER_CONNECTION_IPC_CHANNELS.confirm, { planId: PLAN_ID }],
      [PROVIDER_CONNECTION_IPC_CHANNELS.cancel, { planId: PLAN_ID }],
    ]);
  });

  it('rejects unsupported providers, tokens, argv, and raw output before IPC', async () => {
    const invoke = vi.fn();
    const api = createProviderConnectionsApi(invoke);
    await expect(api.get({ providerId: 'gemini' } as never)).rejects.toBeTruthy();
    await expect(
      api.prepare({ providerId: 'codex', action: 'connect', token: 'secret' } as never),
    ).rejects.toBeTruthy();
    await expect(
      api.prepare({ providerId: 'claude', action: 'connect', arguments: ['--token'] } as never),
    ).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects identity-bearing or raw-output renderer responses', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        providerId: 'codex',
        state: 'connected',
        checkedAt: NOW,
        reason: null,
        email: 'person@example.com',
        rawStdout: 'secret-oauth-code',
      },
    });
    await expect(
      createProviderConnectionsApi(invoke).get({ providerId: 'codex' }),
    ).rejects.toBeTruthy();
  });
});
