// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppSettingsSchema,
  type AppSettings,
} from '../../../../../../shared/application/contracts.js';
import type { CollaborationConnection } from '../../../../../../shared/collaboration/index.js';
import { CollaborationSettings } from '../CollaborationSettings.js';

const NOW = '2026-07-18T12:00:00.000Z';
const ADMIN_TOKEN = 'ADMIN_TOKEN_MUST_CLEAR';
const HASH = 'a'.repeat(64);

afterEach(cleanup);

describe('collaboration room management settings', () => {
  it('clears a volatile administrator token synchronously and blocks duplicate bootstrap', async () => {
    const api = installApi();
    let resolveBootstrap: ((value: unknown) => void) | undefined;
    api.bootstrapRoomAndJoin.mockReturnValue(
      new Promise((resolve) => {
        resolveBootstrap = resolve;
      }),
    );
    render(<Harness />);

    const adminToken = screen.getByLabelText<HTMLInputElement>(/^Server administrator token/u);
    fireEvent.change(adminToken, { target: { value: ADMIN_TOKEN } });
    const create = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Create room and connect',
    });
    act(() => {
      create.click();
      create.click();
    });

    expect(adminToken.value).toBe('');
    await waitFor(() => expect(api.bootstrapRoomAndJoin).toHaveBeenCalledOnce());
    expect(api.bootstrapRoomAndJoin).toHaveBeenCalledWith({
      serverUrl: 'wss://collaboration.example.test/team',
      managementBaseUrl: 'https://management.example.test/control/',
      roomId: 'launch-room',
      subject: 'owner-1',
      displayName: 'Owner One',
      color: '#6d5efc',
      adminToken: ADMIN_TOKEN,
      reconnect: true,
    });
    expect(document.body.textContent).not.toContain(ADMIN_TOKEN);
    expect(document.body.innerHTML).not.toContain(ADMIN_TOKEN);

    resolveBootstrap?.({ ok: true, value: ownerSession() });
    expect(await screen.findByRole('heading', { name: 'Room administration' })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(ADMIN_TOKEN);
  });

  it('creates a room and copies a one-use ten-minute invite from one setup action', async () => {
    const api = installApi();
    api.bootstrapRoomAndJoin.mockResolvedValue({
      ok: true,
      value: ownerSession(),
    });
    api.createInvite.mockResolvedValue({
      ok: true,
      value: {
        id: '95c8589e-b738-4506-9ea9-7578f062f294',
        roomId: 'launch-room',
        role: 'editor',
        expiresAt: '2026-07-18T12:10:00.000Z',
        maxUses: 1,
      },
    });
    api.copyInviteLink.mockResolvedValue({ ok: true, value: true });
    render(<Harness />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create room + copy 10-minute invite',
      }),
    );

    await waitFor(() => expect(api.bootstrapRoomAndJoin).toHaveBeenCalledOnce());
    expect(api.createInvite).toHaveBeenCalledWith({
      role: 'editor',
      expiresInSeconds: 600,
      maxUses: 1,
    });
    expect(api.copyInviteLink).toHaveBeenCalledWith({
      inviteId: '95c8589e-b738-4506-9ea9-7578f062f294',
    });
    expect(await screen.findByText(/10-minute editor invite copied.*used once/u)).toBeTruthy();
  });

  it('clears the administrator token when owner recovery is rejected', async () => {
    const api = installApi();
    api.recoverOwnerAndJoin.mockResolvedValue({
      ok: false,
      error: {
        code: 'owner_not_found',
        message: 'Active room owner not found.',
      },
    });
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('Room access action'), {
      target: { value: 'recover' },
    });
    const adminToken = screen.getByLabelText<HTMLInputElement>(/^Server administrator token/u);
    fireEvent.change(adminToken, { target: { value: ADMIN_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Rotate owner access and connect' }));

    expect(adminToken.value).toBe('');
    expect(await screen.findByText(/Active room owner not found/u)).toBeTruthy();
    expect(api.recoverOwnerAndJoin).toHaveBeenCalledOnce();
    expect(document.body.innerHTML).not.toContain(ADMIN_TOKEN);
  });

  it('uses safe member pagination, immutable owner rows, and refreshes stale conflicts', async () => {
    const owner = member('owner-1', 'Owner One', 'owner', 0);
    const editor = member('editor-1', 'Editor One', 'editor', 1);
    const reviewer = member('editor-1', 'Editor One', 'reviewer', 2);
    const viewer = member('viewer-1', 'Viewer One', 'viewer', 0);
    const api = installApi({ current: ownerConnection() });
    api.listRoomMembers
      .mockResolvedValueOnce({
        ok: true,
        value: {
          members: [owner, editor],
          nextCursor: 'ZWRpdG9yLTE',
          hasMore: true,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          members: [reviewer, viewer],
          nextCursor: null,
          hasMore: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          members: [owner, reviewer, viewer],
          nextCursor: null,
          hasMore: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          members: [owner, reviewer, viewer],
          nextCursor: null,
          hasMore: false,
        },
      });
    api.updateRoomMember.mockResolvedValue({
      ok: false,
      error: { code: 'membership_conflict', message: 'Stale member version.' },
    });
    api.revokeRoomMember.mockResolvedValue({
      ok: false,
      error: { code: 'membership_conflict', message: 'Stale member version.' },
    });
    render(<Harness />);

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh room members' }));
    expect(await screen.findByText('Editor One (editor-1)')).toBeTruthy();
    expect(screen.getByText('Owner One (owner-1)')).toBeTruthy();
    expect(screen.queryByLabelText(/Role for Owner One/u)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load more members' }));
    await screen.findByText('Viewer One (viewer-1)');
    expect(
      within(screen.getByRole('list', { name: 'Room members' })).getAllByRole('listitem'),
    ).toHaveLength(3);
    const role = screen.getByLabelText<HTMLSelectElement>('Role for Editor One (editor-1)');
    expect(role.value).toBe('reviewer');
    fireEvent.change(role, { target: { value: 'viewer' } });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Review role change for Editor One (editor-1)',
      }),
    );

    await waitFor(() =>
      expect(api.updateRoomMember).toHaveBeenCalledWith({
        subject: 'editor-1',
        role: 'viewer',
        expectedTokenVersion: 2,
      }),
    );
    expect(
      await screen.findByText(/This member changed on the server.*Review the current role/u),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Role for Editor One (editor-1)').value).toBe(
      'reviewer',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Viewer One (viewer-1)' }));
    await waitFor(() =>
      expect(api.revokeRoomMember).toHaveBeenCalledWith({
        subject: 'viewer-1',
        expectedTokenVersion: 0,
      }),
    );
    expect(
      await screen.findByText(/This member changed on the server.*Review the current role/u),
    ).toBeTruthy();
    expect(screen.getByText('Viewer One (viewer-1)')).toBeTruthy();
  });

  it('paginates and deduplicates safe audit rows while hiding all owner controls from viewers', async () => {
    const first = auditEvent(1, 'room.created');
    const second = auditEvent(2, 'membership.role_changed');
    const api = installApi({ current: ownerConnection() });
    api.refreshOwnerSession.mockResolvedValue({
      ok: true,
      value: ownerSession(),
    });
    api.listRoomAudit
      .mockResolvedValueOnce({
        ok: true,
        value: { events: [first], nextAfter: 1, hasMore: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { events: [first, second], nextAfter: null, hasMore: false },
      });
    render(<Harness />);

    fireEvent.click(await screen.findByRole('button', { name: 'Renew owner session' }));
    expect(await screen.findByText(/Renewed the owner session/u)).toBeTruthy();
    expect(api.refreshOwnerSession).toHaveBeenCalledOnce();

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh room audit' }));
    await screen.findByText(/#1 · room.created/u);
    fireEvent.click(screen.getByRole('button', { name: 'Load more audit events' }));
    await screen.findByText(/#2 · membership.role_changed/u);
    expect(
      within(screen.getByRole('list', { name: 'Room audit events' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    expect(api.listRoomAudit.mock.calls).toEqual([
      [{ after: 0, limit: 100 }],
      [{ after: 1, limit: 100 }],
    ]);

    cleanup();
    const viewerApi = installApi({
      current: { ...ownerConnection(), role: 'viewer' },
    });
    render(<Harness />);
    await screen.findByText(/Your role is viewer/u);
    expect(screen.queryByRole('heading', { name: 'Room administration' })).toBeNull();
    expect(viewerApi.listRoomMembers).not.toHaveBeenCalled();
    expect(viewerApi.listRoomAudit).not.toHaveBeenCalled();
  });
});

function installApi(options: { current?: CollaborationConnection | null } = {}) {
  const collaboration = {
    get: vi.fn(() => Promise.resolve({ ok: true, value: options.current ?? null })),
    join: vi.fn(),
    joinInvite: vi.fn(),
    bootstrapRoomAndJoin: vi.fn(),
    recoverOwnerAndJoin: vi.fn(),
    refreshOwnerSession: vi.fn(),
    listRoomMembers: vi.fn(),
    updateRoomMember: vi.fn(),
    revokeRoomMember: vi.fn(),
    listRoomAudit: vi.fn(),
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

function ownerConnection(): CollaborationConnection {
  return {
    connectionId: '00000000-0000-4000-8000-000000000010',
    serverUrl: 'wss://collaboration.example.test/team',
    managementBaseUrl: 'https://management.example.test/control/',
    roomId: 'launch-room',
    subject: 'owner-1',
    displayName: 'Owner One',
    color: '#6d5efc',
    role: 'owner',
    status: 'connected',
    reconnect: true,
    reconnectAttempt: 0,
    connectedAt: NOW,
    lastTransitionAt: NOW,
  };
}

function ownerSession() {
  return {
    connection: ownerConnection(),
    expiresAt: '2026-07-18T20:00:00.000Z',
    tokenVersion: 0,
  };
}

function member(
  subject: string,
  displayName: string,
  role: 'owner' | 'editor' | 'reviewer' | 'viewer',
  tokenVersion: number,
) {
  return { subject, displayName, role, tokenVersion };
}

function auditEvent(sequence: number, action: string) {
  return {
    sequence,
    occurredAt: NOW,
    category: action === 'room.created' ? ('room' as const) : ('membership' as const),
    action,
    outcome: 'allowed' as const,
    details: { roomId: 'launch-room' },
    previousHash: HASH,
    eventHash: HASH,
  };
}

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
      collaborationDisplayName: 'Owner One',
      collaborationSubject: 'owner-1',
      collaborationRoom: 'launch-room',
      collaborationReconnect: true,
    }),
  );
  return <CollaborationSettings settings={settings} setSettings={setSettings} busy={false} />;
}
