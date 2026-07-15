// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppSettingsSchema, type AppSettings } from '../../../../shared/application/contracts.js';
import type { CollaborationEvent } from '../../../../shared/collaboration/index.js';
import { ConnectivitySettings } from './ConnectivitySettings.js';

const NOW = '2026-07-15T12:00:00.000Z';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000010';
let eventListener: ((event: CollaborationEvent) => void) | null = null;

const connection = {
  connectionId: CONNECTION_ID,
  serverUrl: 'wss://collaboration.example.test/team',
  roomId: 'launch-room',
  subject: 'editor-1',
  displayName: 'Local editor',
  color: '#6d5efc',
  role: 'editor' as const,
  status: 'connected' as const,
  reconnect: true,
  reconnectAttempt: 0,
  connectedAt: NOW,
  lastTransitionAt: NOW,
};

const join = vi.fn(() => Promise.resolve({ ok: true as const, connection }));
const leave = vi.fn(() =>
  Promise.resolve({
    ok: true as const,
    value: { ...connection, status: 'offline' as const, lastTransitionAt: NOW },
  }),
);

beforeEach(() => {
  join.mockClear();
  leave.mockClear();
  eventListener = null;
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: {
      collaboration: {
        get: vi.fn(() => Promise.resolve({ ok: true, value: null })),
        join,
        leave,
        publish: vi.fn(),
        updateAwareness: vi.fn(),
        onEvent: vi.fn((listener: (event: CollaborationEvent) => void) => {
          eventListener = listener;
          return () => {
            eventListener = null;
          };
        }),
      },
    },
  });
});

afterEach(cleanup);

describe('ConnectivitySettings collaboration controls', () => {
  it('warns that allowlisted free text is shared without secret inspection or redaction', () => {
    render(<Harness />);

    expect(screen.getByText(/Forgeboard sends allowlisted canvas fields/u)).toBeTruthy();
    expect(screen.getByText(/does not inspect or redact secrets/u)).toBeTruthy();
    expect(screen.getByText(/fields are not selected automatically/u)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/credentials, and tokens are not shared/u);
  });

  it('joins explicitly, clears the session token, and renders validated awareness', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Session access token'), {
      target: { value: 'SESSION_TOKEN_DO_NOT_PERSIST' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(join).toHaveBeenCalledOnce());
    expect(join).toHaveBeenCalledWith({
      serverUrl: 'wss://collaboration.example.test/team',
      roomId: 'launch-room',
      subject: 'local-user',
      displayName: 'Local editor',
      color: '#6d5efc',
      accessToken: 'SESSION_TOKEN_DO_NOT_PERSIST',
      reconnect: true,
    });
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Session access token').value).toBe(''),
    );
    expect(document.body.textContent).not.toContain('SESSION_TOKEN_DO_NOT_PERSIST');

    eventListener?.({
      type: 'awareness-changed',
      sequence: 2,
      occurredAt: NOW,
      connectionId: CONNECTION_ID,
      roomId: 'launch-room',
      removedClientIds: [],
      states: [
        {
          clientId: 7,
          state: {
            user: {
              id: 'reviewer-1',
              displayName: 'Remote reviewer',
              color: '#123456',
              role: 'reviewer',
            },
          },
        },
      ],
    });
    expect(await screen.findByText('Remote reviewer · reviewer')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
    await waitFor(() => expect(leave).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Left the collaboration room/u)).toBeTruthy();
  });

  it('leaves the active network session before disabling collaboration', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Session access token'), {
      target: { value: 'SESSION_TOKEN' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(join).toHaveBeenCalledOnce());

    const enabled = screen.getByRole<HTMLInputElement>('checkbox', {
      name: /Enable collaboration/u,
    });
    fireEvent.click(enabled);

    await waitFor(() => expect(leave).toHaveBeenCalledOnce());
    await waitFor(() => expect(enabled.checked).toBe(false));
    expect(screen.getByRole('button', { name: 'Leave room' })).toHaveProperty('disabled', true);
  });
});

function Harness() {
  const [settings, setSettings] = useState<AppSettings>(
    AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'test-agent',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: '/tmp/worktrees',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      previewPortStart: 41_000,
      previewPortEnd: 41_999,
      transcriptRetentionDays: 30,
      collaborationEnabled: true,
      collaborationUrl: 'wss://collaboration.example.test/team',
      collaborationDisplayName: 'Local editor',
      collaborationRoom: 'launch-room',
      collaborationReconnect: true,
    }),
  );
  return <ConnectivitySettings settings={settings} setSettings={setSettings} busy={false} />;
}
