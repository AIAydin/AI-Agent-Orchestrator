import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { CollaborationStore } from '../store.js';
import { decodeInviteCursor, encodeInviteCursor } from './cursor.js';
import { inviteHistoryView } from './view.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('durable collaboration invite listing', () => {
  it('uses canonical compound cursors and stable room-isolated keyset pages', () => {
    const store = new CollaborationStore(':memory:');
    store.createRoom('room-1', 'owner-1', 'Owner One');
    store.createRoom('room-2', 'owner-2', 'Owner Two');
    const now = new Date('2026-07-18T12:00:00.000Z');
    create(store, '00000000-0000-4000-8000-000000000001', 'room-1', now);
    create(store, '00000000-0000-4000-8000-000000000002', 'room-1', now);
    create(store, '00000000-0000-4000-8000-000000000003', 'room-2', now);

    const first = store.listInvites('room-1', undefined, 1);
    expect(first).toMatchObject({ hasMore: true });
    expect(first.invites.map((invite) => invite.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
    ]);
    const last = first.invites[0];
    if (last === undefined) throw new Error('First invite page is empty.');
    const cursor = encodeInviteCursor({ createdAt: last.createdAt, id: last.id });
    expect(decodeInviteCursor(cursor)).toEqual({ createdAt: last.createdAt, id: last.id });
    expect(() => decodeInviteCursor(`${cursor}=`)).toThrow(/invalid/iu);
    const second = store.listInvites('room-1', decodeInviteCursor(cursor), 1);
    expect(second.invites.map((invite) => invite.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(second.hasMore).toBe(false);
    store.close();
  });

  it('survives restart and invalidates legacy or rotated signing authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-invite-listing-'));
    roots.push(root);
    const databasePath = join(root, 'collaboration.sqlite');
    const now = new Date('2026-07-18T12:00:00.000Z');
    const first = new CollaborationStore(databasePath);
    first.createRoom('room-1', 'owner-1', 'Owner One');
    create(first, '00000000-0000-4000-8000-000000000001', 'room-1', now);
    first.close();

    const reopened = new CollaborationStore(databasePath);
    const invite = reopened.listInvites('room-1', undefined, 10).invites[0];
    if (invite === undefined) throw new Error('Durable invite is missing after restart.');
    expect(inviteHistoryView(invite, 'authority-a', now).status).toBe('active');
    expect(inviteHistoryView(invite, 'authority-b', now).status).toBe('invalidated');
    expect(
      inviteHistoryView({ ...invite, signingAuthority: null }, 'authority-a', now).status,
    ).toBe('invalidated');
    expect(
      inviteHistoryView({ ...invite, revokedAt: now.toISOString() }, 'authority-b', now).status,
    ).toBe('revoked');
    reopened.close();
  });

  it('enforces the active invite cap in durable server storage', () => {
    const store = new CollaborationStore(':memory:');
    store.createRoom('room-1', 'owner-1', 'Owner One');
    const now = new Date('2026-07-18T12:00:00.000Z');
    for (let index = 0; index < 100; index += 1) create(store, randomUUID(), 'room-1', now);
    expect(() => create(store, randomUUID(), 'room-1', now)).toThrow(/active invite limit/iu);
    create(store, randomUUID(), 'room-1', now, 'authority-b');
    expect(store.listInvites('room-1', undefined, 100).invites).toHaveLength(100);
    store.close();
  });

  it('rejects redemption under mismatched and legacy signing authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-invite-authority-'));
    roots.push(root);
    const databasePath = join(root, 'collaboration.sqlite');
    const now = new Date('2026-07-18T12:00:00.000Z');
    let store = new CollaborationStore(databasePath);
    store.createRoom('room-1', 'owner-1', 'Owner One');
    const inviteId = randomUUID();
    create(store, inviteId, 'room-1', now);
    expect(() => redeem(store, inviteId, 'authority-b')).toThrow(
      /expired, revoked, or already used/iu,
    );
    expect(store.getInvite(inviteId)?.useCount).toBe(0);
    store.close();

    const database = new DatabaseSync(databasePath);
    database.prepare('UPDATE invites SET signing_authority = NULL WHERE id = ?').run(inviteId);
    database.close();
    store = new CollaborationStore(databasePath);
    expect(() => redeem(store, inviteId, 'authority-a')).toThrow(
      /expired, revoked, or already used/iu,
    );
    expect(store.getInvite(inviteId)?.useCount).toBe(0);
    store.close();
  });
});

function create(
  store: CollaborationStore,
  id: string,
  roomId: string,
  now: Date,
  signingAuthority = 'authority-a',
): void {
  store.createInviteWithAudit(
    {
      id,
      roomId,
      role: 'viewer',
      createdBy: roomId === 'room-1' ? 'owner-1' : 'owner-2',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      maxUses: 2,
      signingAuthority,
      now,
    },
    {
      category: 'invite',
      action: 'invite.created',
      outcome: 'allowed',
      details: { roomId, inviteId: id },
    },
  );
}

function redeem(store: CollaborationStore, inviteId: string, signingAuthority: string): void {
  store.redeemInviteWithAudit(inviteId, 'viewer-1', 'Viewer One', signingAuthority, () => ({
    category: 'invite',
    action: 'invite.redeemed',
    outcome: 'allowed',
    details: { roomId: 'room-1', inviteId },
  }));
}
