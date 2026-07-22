// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AppSettings,
} from '../../../../../shared/application/contracts.js';
import type { CollaborationConnection } from '../../../../../shared/collaboration/index.js';
import { CollaborationSettings } from './CollaborationSettings.js';

const PRIVATE_LINK = 'forgeboard://collaboration/invite#token=PRIVATE_INVITE_TOKEN';
const CONNECTED_LINK =
  'forgeboard://collaboration/invite?management=https%3A%2F%2Fnew.example.test%2Fcontrol%2F&server=wss%3A%2F%2Fnew.example.test%2Fsocket#token=CONNECTED_INVITE_TOKEN';
const INVITE_ID = '95c8589e-b738-4506-9ea9-7578f062f294';
const NOW = '2026-07-17T12:00:00.000Z';

afterEach(cleanup);

describe('collaboration invite settings', () => {
  it('configures the exact server from a new one-paste invite', async () => {
    const api = installApi();
    api.joinInvite.mockResolvedValue({
      ok: false,
      error: { code: 'cancelled', message: 'Cancelled.', retryable: false },
    });
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('Invite link'), {
      target: { value: CONNECTED_LINK },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join room' }));

    await waitFor(() => expect(api.joinInvite).toHaveBeenCalledOnce());
    expect(api.joinInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'wss://new.example.test/socket',
        managementBaseUrl: 'https://new.example.test/control/',
        inviteLink: CONNECTED_LINK,
      }),
    );
    expect(document.body.textContent).not.toContain('CONNECTED_INVITE_TOKEN');
  });

  it('joins with exact configured identity and clears the link after success', async () => {
    const api = installApi();
    let resolveJoin: ((value: unknown) => void) | undefined;
    api.joinInvite.mockReturnValue(
      new Promise((resolve) => {
        resolveJoin = resolve;
      }),
    );
    render(<Harness />);

    const inviteLink = screen.getByLabelText<HTMLInputElement>(/Invite link/u);
    fireEvent.change(inviteLink, { target: { value: PRIVATE_LINK } });
    const joinButton = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Join room',
    });
    act(() => {
      joinButton.click();
      joinButton.click();
    });

    await waitFor(() => expect(api.joinInvite).toHaveBeenCalledOnce());
    expect(inviteLink.value).toBe('');
    expect(api.joinInvite).toHaveBeenCalledWith({
      serverUrl: 'wss://collaboration.example.test/team',
      managementBaseUrl: 'https://management.example.test/control/',
      inviteLink: PRIVATE_LINK,
      subject: 'local-user',
      displayName: 'Local editor',
      color: '#6d5efc',
      reconnect: true,
    });
    resolveJoin?.({ ok: true, connection: connected('reviewer') });
    await waitFor(() => expect(inviteLink.value).toBe(''));
    expect(await screen.findByText(/Your role is reviewer/u)).toBeTruthy();
    expect(document.body.textContent).not.toContain(PRIVATE_LINK);
    expect(document.body.textContent).not.toContain('PRIVATE_INVITE_TOKEN');
    expect(document.body.innerHTML).not.toContain('PRIVATE_INVITE_TOKEN');
  });

  it('clears a rejected link and does not expose it in the failure status', async () => {
    const api = installApi();
    api.joinInvite.mockResolvedValue({
      ok: false,
      error: {
        code: 'authentication-failed',
        message: 'This invite is invalid.',
        retryable: false,
      },
    });
    render(<Harness />);

    const inviteLink = screen.getByLabelText<HTMLInputElement>(/Invite link/u);
    fireEvent.change(inviteLink, { target: { value: PRIVATE_LINK } });
    fireEvent.click(screen.getByRole('button', { name: 'Join room' }));

    expect(await screen.findByText(/This invite is invalid/u)).toBeTruthy();
    expect(inviteLink.value).toBe('');
    expect(document.body.textContent).not.toContain('PRIVATE_INVITE_TOKEN');
    expect(document.body.innerHTML).not.toContain('PRIVATE_INVITE_TOKEN');
  });

  it('shows the connected role and withholds owner controls from non-owners', async () => {
    const api = installApi({ current: connected('viewer') });
    render(<Harness />);

    expect(await screen.findByText(/Your role is viewer/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create invite' })).toBeNull();
    expect(api.listInvites).not.toHaveBeenCalled();
  });

  it('creates and copies a one-use ten-minute editor invite in one owner action', async () => {
    const api = installApi({ current: connected('owner') });
    api.createInvite.mockResolvedValue({
      ok: true,
      value: {
        id: INVITE_ID,
        roomId: 'launch-room',
        role: 'editor',
        expiresAt: '2026-07-17T12:10:00.000Z',
        maxUses: 1,
      },
    });
    api.copyInviteLink.mockResolvedValue({ ok: true, value: true });
    render(<Harness />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Create & copy 10-minute invite',
      }),
    );

    await waitFor(() =>
      expect(api.createInvite).toHaveBeenCalledWith({
        role: 'editor',
        expiresInSeconds: 600,
        maxUses: 1,
      }),
    );
    expect(api.copyInviteLink).toHaveBeenCalledWith({ inviteId: INVITE_ID });
    expect(await screen.findByText(/10-minute editor invite copied.*used once/u)).toBeTruthy();
    expect(document.body.textContent).not.toContain('token=');
  });

  it('creates, pages durable invite history, copies only current-session links, and revokes exact rows', async () => {
    const invite = {
      id: INVITE_ID,
      roomId: 'launch-room',
      role: 'viewer' as const,
      expiresAt: '2026-07-18T12:00:00.000Z',
      maxUses: 3,
    };
    const api = installApi({ current: connected('owner'), invites: [] });
    api.createInvite.mockResolvedValue({ ok: true, value: invite });
    const firstPage = {
      ok: true,
      value: {
        invites: [
          {
            ...invite,
            createdAt: '2026-07-18T11:00:00.000Z',
            useCount: 0,
            revokedAt: null,
            status: 'active',
            copyAvailable: true,
          },
          {
            id: '95c8589e-b738-4506-9ea9-7578f062f295',
            roomId: 'launch-room',
            role: 'reviewer' as const,
            createdAt: '2026-07-18T10:00:00.000Z',
            expiresAt: '2026-07-18T13:00:00.000Z',
            maxUses: 2,
            useCount: 1,
            revokedAt: null,
            status: 'active' as const,
            copyAvailable: false,
          },
        ],
        nextCursor: 'next-page-cursor',
        hasMore: true,
      },
    };
    const secondPage = {
      ok: true,
      value: {
        invites: [
          {
            id: '95c8589e-b738-4506-9ea9-7578f062f296',
            roomId: 'launch-room',
            role: 'editor' as const,
            createdAt: '2026-07-18T09:00:00.000Z',
            expiresAt: '2026-07-18T10:00:00.000Z',
            maxUses: 1,
            useCount: 1,
            revokedAt: null,
            status: 'exhausted' as const,
            copyAvailable: false,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    };
    api.listInvites
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(firstPage);
    api.copyInviteLink.mockResolvedValue({ ok: true, value: true });
    api.revokeInvite.mockResolvedValue({
      ok: true,
      value: {
        ...invite,
        createdAt: '2026-07-18T11:00:00.000Z',
        useCount: 0,
        revokedAt: '2026-07-18T11:30:00.000Z',
        status: 'revoked',
        copyAvailable: false,
      },
    });
    render(<Harness />);

    await screen.findByRole('button', { name: 'Create invite' });
    fireEvent.change(screen.getByLabelText('Invite role'), {
      target: { value: 'viewer' },
    });
    fireEvent.change(screen.getByLabelText('Invite expires after'), {
      target: { value: '86400' },
    });
    fireEvent.change(screen.getByLabelText('Maximum uses'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));

    await waitFor(() =>
      expect(api.createInvite).toHaveBeenCalledWith({
        role: 'viewer',
        expiresInSeconds: 86_400,
        maxUses: 3,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh invites' }));
    await waitFor(() => expect(api.listInvites).toHaveBeenCalledWith({ limit: 50 }));
    expect(await screen.findByText(/^viewer · active/u)).toBeTruthy();
    expect(screen.getByText(/reviewer · active/u)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(1);
    expect(document.body.textContent).not.toContain('token=');
    expect(document.body.textContent).not.toContain(PRIVATE_LINK);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(api.listInvites).toHaveBeenLastCalledWith({
        after: 'next-page-cursor',
        limit: 50,
      }),
    );
    expect(await screen.findByText(/editor · exhausted/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(api.listInvites).toHaveBeenLastCalledWith({ limit: 50 }));
    expect(await screen.findByText(/^viewer · active/u)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(api.copyInviteLink).toHaveBeenCalledWith({ inviteId: INVITE_ID }));
    expect(await screen.findByText(/Invite link copied/u)).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    await waitFor(() => expect(api.revokeInvite).toHaveBeenCalledWith({ inviteId: INVITE_ID }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull());
  });
});

function connected(role: CollaborationConnection['role']): CollaborationConnection {
  return {
    connectionId: '00000000-0000-4000-8000-000000000010',
    serverUrl: 'wss://collaboration.example.test/team',
    managementBaseUrl: 'https://management.example.test/control/',
    roomId: 'launch-room',
    subject: 'local-user',
    displayName: 'Local editor',
    color: '#6d5efc',
    role,
    status: 'connected',
    reconnect: true,
    reconnectAttempt: 0,
    connectedAt: NOW,
    lastTransitionAt: NOW,
  };
}

function installApi(
  options: {
    current?: CollaborationConnection | null;
    invites?: unknown[];
  } = {},
) {
  const collaboration = {
    get: vi.fn(() => Promise.resolve({ ok: true, value: options.current ?? null })),
    join: vi.fn(),
    joinInvite: vi.fn(),
    listInvites: vi.fn(),
    createInvite: vi.fn(),
    copyInviteLink: vi.fn(),
    revokeInvite: vi.fn(),
    leave: vi.fn(),
    publish: vi.fn(),
    updateAwareness: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { collaboration },
  });
  return collaboration;
}

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
      collaborationManagementUrl: 'https://management.example.test/control',
      collaborationDisplayName: 'Local editor',
      collaborationRoom: 'launch-room',
      collaborationReconnect: true,
    }),
  );
  return <CollaborationSettings settings={settings} setSettings={setSettings} busy={false} />;
}
