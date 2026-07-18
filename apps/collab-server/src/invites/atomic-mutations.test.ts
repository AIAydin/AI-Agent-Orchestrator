import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { CollaborationStore } from '../store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('atomic collaboration invite mutations', () => {
  it('rolls back create, redeem, and revoke when the matching audit append fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-invite-atomicity-'));
    roots.push(root);
    const databasePath = join(root, 'collaboration.sqlite');
    const store = new CollaborationStore(databasePath);
    store.createRoom('room-1', 'owner-1', 'Owner One');
    const input = {
      id: '00000000-0000-4000-8000-000000000001',
      roomId: 'room-1',
      role: 'editor' as const,
      createdBy: 'owner-1',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      maxUses: 2,
      signingAuthority: 'test-signing-authority',
      now: new Date('2026-07-18T12:00:00.000Z'),
    };
    const audit = inviteAudit('invite.created');
    installFailingInviteAuditTrigger(databasePath);

    expect(() => store.createInviteWithAudit(input, audit)).toThrow(
      /forced invite audit failure/iu,
    );
    expect(store.getInvite(input.id)).toBeUndefined();

    removeFailingInviteAuditTrigger(databasePath);
    store.createInviteWithAudit(input, audit);
    installFailingInviteAuditTrigger(databasePath);
    expect(() =>
      store.redeemInviteWithAudit(
        input.id,
        'editor-1',
        'Editor One',
        input.signingAuthority,
        () => inviteAudit('invite.redeemed'),
        new Date('2026-07-18T12:01:00.000Z'),
      ),
    ).toThrow(/forced invite audit failure/iu);
    expect(store.getInvite(input.id)?.useCount).toBe(0);
    expect(store.getMembership(input.roomId, 'editor-1')).toBeUndefined();

    expect(() =>
      store.revokeInviteWithAudit(
        input.id,
        input.roomId,
        input.signingAuthority,
        inviteAudit('invite.revoked'),
        new Date('2026-07-18T12:02:00.000Z'),
      ),
    ).toThrow(/forced invite audit failure/iu);
    expect(store.getInvite(input.id)?.revokedAt).toBeUndefined();
    store.close();
  });
});

function inviteAudit(action: string) {
  return {
    category: 'invite' as const,
    action,
    outcome: 'allowed' as const,
    details: { roomId: 'room-1', actorId: 'owner-1' },
  };
}

function installFailingInviteAuditTrigger(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TRIGGER fail_invite_audit
    BEFORE INSERT ON audit_events WHEN NEW.category = 'invite'
    BEGIN SELECT RAISE(ABORT, 'forced invite audit failure'); END;
  `);
  database.close();
}

function removeFailingInviteAuditTrigger(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec('DROP TRIGGER fail_invite_audit;');
  database.close();
}
