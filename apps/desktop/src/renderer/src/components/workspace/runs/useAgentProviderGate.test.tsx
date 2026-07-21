// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConnectionStatus } from '../../../../../shared/provider-connections/index.js';
import { useAgentProviderGate } from './useAgentProviderGate.js';

const get = vi.fn();
const prepare = vi.fn();
const confirm = vi.fn();
const cancel = vi.fn();

beforeEach(() => {
  get.mockReset().mockResolvedValue({ ok: true, value: status('disconnected') });
  prepare.mockReset().mockResolvedValue({
    ok: true,
    value: {
      schemaVersion: 1,
      planId: '10000000-0000-4000-8000-000000000001',
      providerId: 'claude',
      action: 'refresh',
      expiresAt: '2026-07-19T12:05:00.000Z',
    },
  });
  confirm.mockReset().mockResolvedValue({ ok: true, value: status('connected') });
  cancel.mockReset().mockResolvedValue({ ok: true, value: { acknowledged: true } });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { agents: { connections: { get, prepare, confirm, cancel } } },
  });
});

afterEach(cleanup);

describe('useAgentProviderGate', () => {
  it('checks each provider exactly once and never contacts providers for other agents', async () => {
    const hook = renderGate(['claude', 'claude', 'test-agent', 'gemini', 'custom']);

    await waitFor(() => expect(hook.result.current.gateFor('claude')?.settled).toBe(true));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({ providerId: 'claude' });
    expect(hook.result.current.gateFor('test-agent')).toBeNull();
    expect(hook.result.current.gateFor('gemini')).toBeNull();
    expect(hook.result.current.gateFor('custom')).toBeNull();

    const gate = hook.result.current.gateFor('claude');
    expect(gate?.state).toBe('disconnected');
    expect(gate?.blockedReason).toBe(
      "Claude Code isn't connected. Connect it in Settings → Agents & runtime.",
    );
    expect(gate?.actionLabel).toBe('Check again');
  });

  it('passes the saved executable override with every status read', async () => {
    const hook = renderGate(['codex'], { codex: '  /custom/codex  ' });

    await waitFor(() => expect(hook.result.current.gateFor('codex')?.settled).toBe(true));

    expect(get).toHaveBeenCalledWith({
      providerId: 'codex',
      executableOverride: '/custom/codex',
    });
  });

  it('unblocks after a successful re-check without any settings round-trip', async () => {
    const hook = renderGate(['claude']);
    await waitFor(() => expect(hook.result.current.gateFor('claude')?.state).toBe('disconnected'));

    get.mockResolvedValueOnce({ ok: true, value: status('connected') });
    await act(async () => await hook.result.current.recheck('claude'));

    const gate = hook.result.current.gateFor('claude');
    expect(gate?.state).toBe('connected');
    expect(gate?.blockedReason).toBeNull();
    expect(gate?.warning).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('runs the provider refresh flow when the status is unknown and unblocks on success', async () => {
    get.mockResolvedValue({ ok: true, value: status('unknown') });
    const hook = renderGate(['claude']);
    await waitFor(() => expect(hook.result.current.gateFor('claude')?.state).toBe('unknown'));
    expect(hook.result.current.gateFor('claude')?.actionLabel).toBe('Refresh status');
    expect(hook.result.current.gateFor('claude')?.warning).toBe(
      "Claude Code's connection status needs a refresh before this agent can run.",
    );

    await act(async () => await hook.result.current.recheck('claude'));

    expect(prepare).toHaveBeenCalledWith({ providerId: 'claude', action: 'refresh' });
    expect(confirm).toHaveBeenCalledWith({ planId: '10000000-0000-4000-8000-000000000001' });
    expect(hook.result.current.gateFor('claude')?.state).toBe('connected');
  });

  it('verifies with a fresh read at approval time and reports cause plus recovery', async () => {
    const hook = renderGate(['claude']);
    await waitFor(() => expect(hook.result.current.gateFor('claude')?.settled).toBe(true));
    get.mockClear();

    await expect(hook.result.current.verifyAdapterConnection('test-agent')).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();

    get.mockResolvedValueOnce({ ok: true, value: status('disconnected') });
    await expect(hook.result.current.verifyAdapterConnection('claude')).resolves.toBe(
      "Claude Code isn't connected — connect it in Settings → Agents & runtime, then try again.",
    );

    get.mockResolvedValueOnce({ ok: true, value: status('connected') });
    await expect(hook.result.current.verifyAdapterConnection('claude')).resolves.toBeNull();
  });

  it('blocks the launch when the approval-time verification itself fails', async () => {
    const hook = renderGate(['claude']);
    await waitFor(() => expect(hook.result.current.gateFor('claude')?.settled).toBe(true));

    get.mockRejectedValueOnce(new Error('IPC unavailable.'));
    await expect(hook.result.current.verifyAdapterConnection('claude')).resolves.toBe(
      "Claude Code's connection could not be verified (IPC unavailable.) — check Settings → Agents & runtime, then try again.",
    );
  });
});

function renderGate(
  adapterIds: readonly string[],
  executableOverrides: Partial<Record<'codex' | 'claude', string>> = {},
) {
  return renderHook(() => useAgentProviderGate({ adapterIds, executableOverrides }));
}

function status(state: 'connected' | 'disconnected' | 'unknown'): ProviderConnectionStatus {
  return {
    schemaVersion: 1,
    providerId: 'claude',
    state,
    checkedAt: state === 'unknown' ? null : '2026-07-19T12:00:00.000Z',
    reason: state === 'connected' ? null : 'Refresh connection status.',
  };
}
