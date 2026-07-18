// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ProviderConnectionPlanInput,
  ProviderConnectionPrepareInput,
} from '../../../../../../shared/provider-connections/index.js';
import { ProviderConnectionCards } from './ProviderConnectionCards.js';
import { ProviderConnectionSummary } from './ProviderConnectionSummary.js';

const disconnected = {
  schemaVersion: 1 as const,
  providerId: 'codex' as const,
  state: 'disconnected' as const,
  checkedAt: null,
  reason: 'Codex CLI is not signed in.',
};
const connected = {
  ...disconnected,
  state: 'connected' as const,
  checkedAt: '2026-07-17T12:00:00.000Z',
  reason: null,
};
const prepare = vi.fn();
const confirm = vi.fn();
const cancel = vi.fn();
const get = vi.fn();

beforeEach(() => {
  get.mockReset().mockResolvedValue({ ok: true, value: disconnected });
  prepare.mockReset().mockResolvedValue({
    ok: true,
    value: {
      schemaVersion: 1,
      planId: '10000000-0000-4000-8000-000000000001',
      providerId: 'codex',
      action: 'connect',
      expiresAt: '2026-07-17T12:05:00.000Z',
    },
  });
  confirm.mockReset().mockResolvedValue({ ok: true, value: connected });
  cancel.mockReset().mockResolvedValue({ ok: true, value: { acknowledged: true } });
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { agents: { connections: { get, prepare, confirm, cancel } } },
  });
});

afterEach(cleanup);

describe('ProviderConnectionCards', () => {
  it('does not show connected until confirmed evidence arrives and can cancel active sign-in', async () => {
    let resolveConfirm!: (value: unknown) => void;
    confirm.mockReturnValue(new Promise((resolve) => (resolveConfirm = resolve)));
    render(<ProviderConnectionCards providerIds={['codex']} />);

    await screen.findByText('Not connected');
    fireEvent.click(screen.getByRole('button', { name: 'Connect with OpenAI' }));
    await screen.findByRole('button', { name: 'Cancel sign-in' });
    expect(screen.queryByText('Connected')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith({
        planId: '10000000-0000-4000-8000-000000000001',
      }),
    );
    resolveConfirm({ ok: true, value: disconnected });
    await screen.findByText('Not connected');
  });

  it('disconnects, reconnects after attention, and performs refresh through confirmation', async () => {
    get.mockResolvedValueOnce({ ok: true, value: connected });
    render(<ProviderConnectionCards providerIds={['codex']} />);
    await screen.findByText('Connected');

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(prepare).toHaveBeenCalledWith({
        providerId: 'codex',
        action: 'disconnect',
      }),
    );

    get.mockResolvedValueOnce({
      ok: true,
      value: {
        ...disconnected,
        state: 'unknown',
        checkedAt: '2026-07-17T12:30:00.000Z',
        reason: 'Sign-in needs attention.',
      },
    });
    cleanup();
    render(<ProviderConnectionCards providerIds={['codex']} />);
    await screen.findByRole('button', { name: 'Reconnect' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(prepare).toHaveBeenCalledWith({
        providerId: 'codex',
        action: 'refresh',
      }),
    );
  });

  it('names both provider cards and scopes their independent connection lifecycles', async () => {
    get.mockImplementation(({ providerId }) =>
      Promise.resolve({
        ok: true,
        value:
          providerId === 'codex'
            ? connected
            : {
                ...disconnected,
                providerId: 'claude',
                reason: 'Claude Code is not signed in.',
              },
      }),
    );
    prepare.mockImplementation(({ providerId, action }: ProviderConnectionPrepareInput) =>
      Promise.resolve({
        ok: true,
        value: {
          schemaVersion: 1,
          planId:
            providerId === 'codex'
              ? '10000000-0000-4000-8000-000000000001'
              : '20000000-0000-4000-8000-000000000002',
          providerId,
          action,
          expiresAt: '2026-07-17T12:05:00.000Z',
        },
      }),
    );
    confirm.mockImplementation(({ planId }: ProviderConnectionPlanInput) =>
      Promise.resolve({
        ok: true,
        value:
          planId === '10000000-0000-4000-8000-000000000001'
            ? disconnected
            : { ...connected, providerId: 'claude' },
      }),
    );

    render(<ProviderConnectionCards />);

    const codexCard = screen.getByRole('article', { name: 'Codex CLI' });
    const claudeCard = screen.getByRole('article', { name: 'Claude Code' });
    expect(within(codexCard).getByRole('heading', { name: 'Codex CLI' })).toBeTruthy();
    expect(within(claudeCard).getByRole('heading', { name: 'Claude Code' })).toBeTruthy();
    await within(codexCard).findByText('Connected');
    await within(claudeCard).findByText('Not connected');

    fireEvent.click(within(codexCard).getByRole('button', { name: 'Disconnect' }));
    await within(codexCard).findByRole('button', { name: 'Connect with OpenAI' });
    expect(prepare).toHaveBeenCalledWith({ providerId: 'codex', action: 'disconnect' });

    fireEvent.click(within(claudeCard).getByRole('button', { name: 'Connect with Anthropic' }));
    await within(claudeCard).findByRole('button', { name: 'Disconnect' });
    expect(prepare).toHaveBeenCalledWith({ providerId: 'claude', action: 'connect' });

    fireEvent.click(within(claudeCard).getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(prepare).toHaveBeenCalledWith({ providerId: 'claude', action: 'refresh' }),
    );
  });

  it('binds the current unsaved executable override into the reviewed connection plan', async () => {
    render(
      <ProviderConnectionCards
        providerIds={['codex']}
        executableOverrides={{ codex: ' /fixtures/codex ' }}
      />,
    );
    await screen.findByText('Not connected');
    expect(get).toHaveBeenCalledWith({
      providerId: 'codex',
      executableOverride: '/fixtures/codex',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect with OpenAI' }));
    await waitFor(() =>
      expect(prepare).toHaveBeenCalledWith({
        providerId: 'codex',
        action: 'connect',
        executableOverride: '/fixtures/codex',
      }),
    );
  });

  it('keeps executable and model controls behind an Advanced disclosure', async () => {
    render(
      <ProviderConnectionCards
        providerIds={['codex']}
        advanced={{
          codex: (
            <label>
              Executable override
              <input name="test-provider-executable" />
            </label>
          ),
        }}
      />,
    );
    await screen.findByText('Not connected');
    expect(screen.getByText('Advanced').closest('details')?.open).toBe(false);
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByText('Advanced').closest('details')?.open).toBe(true);
    expect(screen.getByLabelText('Executable override')).toBeTruthy();
    expect(screen.getByText(/never sees or stores OAuth tokens/i)).toBeTruthy();
  });
});

describe('ProviderConnectionSummary', () => {
  it('shows only passive normalized state and directs connection changes to Agents settings', async () => {
    get.mockImplementation(({ providerId }) =>
      Promise.resolve({
        ok: true,
        value: providerId === 'codex' ? connected : { ...disconnected, providerId: 'claude' },
      }),
    );
    render(<ProviderConnectionSummary />);

    await screen.findByText('Connected');
    expect(screen.getByText('Anthropic Claude Code')).toBeTruthy();
    expect(screen.getAllByText(/Manage in Settings → Agents/)).toHaveLength(2);
    expect(screen.queryByRole('button')).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });
});
