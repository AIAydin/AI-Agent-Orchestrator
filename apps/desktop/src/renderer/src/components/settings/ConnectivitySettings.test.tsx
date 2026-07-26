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
        joinInvite: vi.fn(),
        createInvite: vi.fn(),
        copyInviteLink: vi.fn(),
        revokeInvite: vi.fn(),
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
  it('warns that shared canvas text is not checked for secrets', () => {
    render(<Harness />);

    expect(screen.getByText(/Artemis shares only these canvas details/u)).toBeTruthy();
    expect(
      screen.getByText(/does not check shared titles, connection labels, or comments for secrets/u),
    ).toBeTruthy();
    expect(screen.getByText(/never selected automatically/u)).toBeTruthy();
    expect(screen.getByText(/sensitive information typed.*is sent to the room/u)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/stay on this computer/u);
    expect(document.body.textContent).not.toMatch(/credentials, and tokens are not shared/u);
  });

  it('configures an explicit management API without guessing from the WebSocket URL', () => {
    render(<Harness />);

    const managementUrl = screen.getByRole<HTMLInputElement>('textbox', {
      name: /Collaboration management API URL/u,
    });
    expect(managementUrl.value).toBe('https://management.example.test/control/');
    expect(screen.getByText(/Shared invites require public HTTPS/u)).toBeTruthy();
    expect(screen.getByText(/Local HTTP remains available/u)).toBeTruthy();

    fireEvent.change(managementUrl, {
      target: { value: 'http://127.0.0.1:1234' },
    });
    expect(managementUrl.value).toBe('http://127.0.0.1:1234');
  });

  it('joins explicitly, clears the session token, and renders validated awareness', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Session access token'), {
      target: { value: 'SESSION_TOKEN_DO_NOT_PERSIST' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect with access token' }));

    await waitFor(() => expect(join).toHaveBeenCalledOnce());
    expect(join).toHaveBeenCalledWith({
      serverUrl: 'wss://collaboration.example.test/team',
      managementBaseUrl: 'https://management.example.test/control/',
      roomId: 'launch-room',
      subject: 'local-user',
      displayName: 'Local editor',
      color: '#6d5efc',
      accessToken: 'SESSION_TOKEN_DO_NOT_PERSIST',
      reconnect: true,
    });
    await waitFor(() => expect(screen.queryByLabelText('Session access token')).toBeNull());
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

  it('leaves the active network session from the connected status view', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Session access token'), {
      target: { value: 'SESSION_TOKEN' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect with access token' }));
    await waitFor(() => expect(join).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));

    await waitFor(() => expect(leave).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText(/Left the collaboration room/u)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Leave room' })).toBeNull();
  });
});

function Harness() {
  const [settings, setSettings] = useState<AppSettings>(
    AppSettingsSchema.parse({
      theme: 'system',
      reducedMotion: false,
      density: 'comfortable',
      defaultAgent: 'codex',
      defaultPermissionProfile: 'worktree-write',
      worktreeRoot: '/tmp/worktrees',
      terminalShell: '/bin/sh',
      envAllowlist: ['PATH'],
      previewPortStart: 41_000,
      previewPortEnd: 41_999,
      transcriptRetentionDays: 30,
      collaborationEnabled: true,
      collaborationUrl: 'wss://collaboration.example.test/team',
      collaborationManagementUrl: 'https://management.example.test/control',
      collaborationDisplayName: 'Local editor',
      collaborationRoom: 'launch-room',
      collaborationReconnect: true,
    }),
  );
  return <ConnectivitySettings settings={settings} setSettings={setSettings} busy={false} />;
}
