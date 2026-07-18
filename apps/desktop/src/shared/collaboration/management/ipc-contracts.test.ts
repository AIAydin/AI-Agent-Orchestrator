import { describe, expect, it } from 'vitest';

import {
  CollaborationOwnerSessionViewSchema,
  CollaborationRoomAuditListInputSchema,
  CollaborationRoomBootstrapJoinInputSchema,
  CollaborationRoomMemberRevokeInputSchema,
} from './ipc-contracts.js';

const ownerConnection = {
  connectionId: '00000000-0000-4000-8000-000000000010',
  serverUrl: 'wss://collaboration.example.test/team',
  managementBaseUrl: 'https://management.example.test/control/',
  roomId: 'room-1',
  subject: 'owner-1',
  displayName: 'Owner One',
  color: '#6d5efc',
  role: 'owner' as const,
  status: 'connected' as const,
  reconnect: true,
  reconnectAttempt: 0,
  connectedAt: '2026-07-18T12:00:00.000Z',
  lastTransitionAt: '2026-07-18T12:00:00.000Z',
};

describe('desktop collaboration management IPC contracts', () => {
  it('accepts a strict volatile bootstrap request and canonicalizes its URLs', () => {
    expect(
      CollaborationRoomBootstrapJoinInputSchema.parse({
        serverUrl: 'wss://collaboration.example.test/team',
        managementBaseUrl: 'https://management.example.test/control',
        roomId: 'room-1',
        subject: 'owner-1',
        displayName: 'Owner One',
        color: '#6d5efc',
        adminToken: 'volatile-admin-token',
        reconnect: true,
      }),
    ).toMatchObject({
      managementBaseUrl: 'https://management.example.test/control/',
      adminToken: 'volatile-admin-token',
    });
  });

  it('rejects extra bootstrap fields and malformed administrator credentials', () => {
    expect(() =>
      CollaborationRoomBootstrapJoinInputSchema.parse({
        serverUrl: 'wss://collaboration.example.test/team',
        managementBaseUrl: 'https://management.example.test/control',
        roomId: 'room-1',
        subject: 'owner-1',
        displayName: 'Owner One',
        color: '#6d5efc',
        adminToken: 'secret\nheader',
        reconnect: true,
        persistAdminToken: true,
      }),
    ).toThrow();
  });

  it('admits only connected owner session views without access credentials', () => {
    const view = {
      connection: ownerConnection,
      expiresAt: '2026-07-18T20:00:00.000Z',
      tokenVersion: 2,
    };
    expect(CollaborationOwnerSessionViewSchema.parse(view)).toEqual(view);
    expect(() =>
      CollaborationOwnerSessionViewSchema.parse({ ...view, accessToken: 'must-not-cross' }),
    ).toThrow();
    expect(() =>
      CollaborationOwnerSessionViewSchema.parse({
        ...view,
        connection: { ...ownerConnection, role: 'editor' },
      }),
    ).toThrow();
  });

  it('bounds audit pagination and requires member mutation versions', () => {
    expect(CollaborationRoomAuditListInputSchema.parse({})).toEqual({ after: 0, limit: 100 });
    expect(() => CollaborationRoomAuditListInputSchema.parse({ after: 0, limit: 501 })).toThrow();
    expect(
      CollaborationRoomMemberRevokeInputSchema.parse({
        subject: 'editor-1',
        expectedTokenVersion: 4,
      }),
    ).toEqual({ subject: 'editor-1', expectedTokenVersion: 4 });
    expect(() => CollaborationRoomMemberRevokeInputSchema.parse({ subject: 'editor-1' })).toThrow();
  });
});
