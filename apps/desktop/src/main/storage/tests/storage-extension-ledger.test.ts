import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalStore, type TrustedExtensionLedgerRecord } from '../../storage.js';

const INSTALL_OPERATION_ID = '60000000-0000-4000-8000-000000000001';
const UPDATE_OPERATION_ID = '60000000-0000-4000-8000-000000000002';
const REMOVE_OPERATION_ID = '60000000-0000-4000-8000-000000000003';
const OTHER_REMOVE_OPERATION_ID = '60000000-0000-4000-8000-000000000004';
const APPROVED_AT = '2026-07-14T16:00:00.000Z';
const roots: string[] = [];
const stores = new Set<LocalStore>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeboard-extension-ledger-test-'));
  roots.push(root);
  return join(root, 'data', 'forgeboard.sqlite3');
}

function openStore(path = databasePath()): LocalStore {
  const store = new LocalStore(path);
  stores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  stores.delete(store);
}

function ledgerRecord(
  overrides: Partial<TrustedExtensionLedgerRecord> = {},
): TrustedExtensionLedgerRecord {
  return {
    schemaVersion: 1,
    extensionId: 'dev.forgeboard.safe-extension',
    extensionVersion: '1.2.3',
    manifestDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64),
    permissions: ['agent.adapter.register', 'agent.process.launch'],
    approvedAt: APPROVED_AT,
    state: 'pending',
    operationId: INSTALL_OPERATION_ID,
    updatedAt: APPROVED_AT,
    ...overrides,
  };
}

describe('LocalStore trusted extension ledger', () => {
  it('stages, activates, revokes, and purges only through matching operations', () => {
    const store = openStore();
    const pending = ledgerRecord();

    expect(store.stageTrustedExtension(pending)).toEqual(pending);
    expect(store.getTrustedExtension(pending.extensionId)).toEqual(pending);
    expect(store.listTrustedExtensions('pending')).toEqual([pending]);
    const inspector = new DatabaseSync(store.databasePath, { readOnly: true });
    expect(
      inspector
        .prepare(
          `SELECT permissions_json, state, operation_id
           FROM trusted_extension_ledger WHERE extension_id = ?`,
        )
        .get(pending.extensionId),
    ).toEqual({
      permissions_json: '["agent.adapter.register","agent.process.launch"]',
      state: 'pending',
      operation_id: INSTALL_OPERATION_ID,
    });
    inspector.close();
    expect(() =>
      store.activateTrustedExtension(
        pending.extensionId,
        UPDATE_OPERATION_ID,
        new Date('2026-07-14T16:01:00.000Z'),
      ),
    ).toThrow('operation no longer matches');

    const active = store.activateTrustedExtension(
      pending.extensionId,
      INSTALL_OPERATION_ID,
      new Date('2026-07-14T16:01:00.000Z'),
    );
    expect(active).toEqual({
      ...pending,
      state: 'active',
      updatedAt: '2026-07-14T16:01:00.000Z',
    });
    expect(store.listTrustedExtensions('active')).toEqual([active]);
    expect(() => store.purgeTrustedExtension(active.extensionId, INSTALL_OPERATION_ID)).toThrow(
      'must be revoked',
    );

    const revoked = store.revokeTrustedExtension(
      active.extensionId,
      REMOVE_OPERATION_ID,
      new Date('2026-07-14T16:02:00.000Z'),
    );
    expect(revoked).toEqual({
      ...active,
      state: 'revoked',
      operationId: REMOVE_OPERATION_ID,
      updatedAt: '2026-07-14T16:02:00.000Z',
    });
    expect(() =>
      store.purgeTrustedExtension(revoked.extensionId, OTHER_REMOVE_OPERATION_ID),
    ).toThrow('does not match its revocation');
    expect(store.purgeTrustedExtension(revoked.extensionId, REMOVE_OPERATION_ID)).toBe(true);
    expect(store.purgeTrustedExtension(revoked.extensionId, REMOVE_OPERATION_ID)).toBe(false);
  });

  it('requires exact sorted permissions and rejects stale approval replacement', () => {
    const store = openStore();
    expect(() =>
      store.stageTrustedExtension(
        ledgerRecord({
          permissions: ['agent.process.launch', 'agent.adapter.register'],
        }),
      ),
    ).toThrow('permissions must be unique and sorted');

    const active = ledgerRecord({
      state: 'active',
      updatedAt: '2026-07-14T16:02:00.000Z',
    });
    store.upsertActiveTrustedExtension(active);
    expect(() =>
      store.upsertActiveTrustedExtension(
        ledgerRecord({
          state: 'active',
          extensionVersion: '2.0.0',
          operationId: UPDATE_OPERATION_ID,
          approvedAt: '2026-07-14T16:00:30.000Z',
          updatedAt: '2026-07-14T16:01:00.000Z',
        }),
      ),
    ).toThrow('stale trusted extension operation');
    expect(store.getTrustedExtension(active.extensionId)).toEqual(active);
  });

  it('restores prior active trust only for the exact failed pending operation', () => {
    const store = openStore();
    const previous = ledgerRecord({
      state: 'active',
      updatedAt: '2026-07-14T16:01:00.000Z',
    });
    store.upsertActiveTrustedExtension(previous);
    const pendingUpdate = ledgerRecord({
      extensionVersion: '2.0.0',
      manifestDigest: 'c'.repeat(64),
      snapshotDigest: 'd'.repeat(64),
      approvedAt: '2026-07-14T16:02:00.000Z',
      operationId: UPDATE_OPERATION_ID,
      updatedAt: '2026-07-14T16:02:00.000Z',
    });
    store.stageTrustedExtension(pendingUpdate);

    expect(() =>
      store.restoreActiveTrustedExtension(
        previous,
        OTHER_REMOVE_OPERATION_ID,
        new Date('2026-07-14T16:03:00.000Z'),
      ),
    ).toThrow('stale or no longer pending');
    expect(store.getTrustedExtension(previous.extensionId)).toEqual(pendingUpdate);

    const restored = store.restoreActiveTrustedExtension(
      previous,
      UPDATE_OPERATION_ID,
      new Date('2026-07-14T16:03:00.000Z'),
    );
    expect(restored).toEqual({ ...previous, updatedAt: '2026-07-14T16:03:00.000Z' });
    expect(restored).toMatchObject({
      extensionVersion: previous.extensionVersion,
      manifestDigest: previous.manifestDigest,
      snapshotDigest: previous.snapshotDigest,
      permissions: previous.permissions,
      operationId: previous.operationId,
    });
    expect(() => store.restoreActiveTrustedExtension(previous, UPDATE_OPERATION_ID)).toThrow(
      'stale or no longer pending',
    );
  });

  it('persists atomically upserted active trust across restart', () => {
    const path = databasePath();
    const store = openStore(path);
    const active = ledgerRecord({
      state: 'active',
      updatedAt: '2026-07-14T16:01:00.000Z',
    });
    expect(store.upsertActiveTrustedExtension(active)).toEqual(active);
    closeStore(store);

    const reopened = openStore(path);
    expect(reopened.getTrustedExtension(active.extensionId)).toEqual(active);
    expect(reopened.listTrustedExtensions()).toEqual([active]);
    expect(reopened.checkIntegrity('full')).toMatchObject({ ok: true, messages: [] });
  });

  it('detects tampering between authoritative JSON and mirrored ledger columns', () => {
    const store = openStore();
    store.upsertActiveTrustedExtension(
      ledgerRecord({ state: 'active', updatedAt: '2026-07-14T16:01:00.000Z' }),
    );
    const connection = new DatabaseSync(store.databasePath);
    connection
      .prepare('UPDATE trusted_extension_ledger SET permissions_json = ?')
      .run('["canvas.data.persist"]');
    connection.close();

    expect(() => store.getTrustedExtension('dev.forgeboard.safe-extension')).toThrow(
      'columns do not match their authoritative record',
    );
    const report = store.checkIntegrity('full');
    expect(report.ok).toBe(false);
    expect(report.messages.join(' ')).toContain(
      'trusted_extension_ledger row 1: indexed columns do not match JSON',
    );
  });

  it('keeps device-local trust out of exports and preserves it across replace imports', () => {
    const source = openStore();
    const active = ledgerRecord({
      state: 'active',
      updatedAt: '2026-07-14T16:01:00.000Z',
    });
    source.upsertActiveTrustedExtension(active);
    const exported = source.exportData(new Date('2026-07-14T17:00:00.000Z'));
    expect(JSON.stringify(exported)).not.toContain(active.extensionId);

    const destination = openStore();
    destination.upsertActiveTrustedExtension(
      ledgerRecord({
        extensionId: 'dev.forgeboard.previously-trusted',
        state: 'active',
        updatedAt: '2026-07-14T16:01:00.000Z',
      }),
    );
    destination.importData(exported, { replaceExisting: true });
    expect(destination.listTrustedExtensions()).toEqual([
      ledgerRecord({
        extensionId: 'dev.forgeboard.previously-trusted',
        state: 'active',
        updatedAt: '2026-07-14T16:01:00.000Z',
      }),
    ]);

    const injected = { ...exported, trustedExtensions: [active] };
    expect(() => destination.importData(injected, { replaceExisting: true })).toThrow();
    expect(destination.listTrustedExtensions()).toHaveLength(1);
  });

  it('purges the trusted ledger during complete local-data deletion', async () => {
    const store = openStore();
    store.upsertActiveTrustedExtension(
      ledgerRecord({ state: 'active', updatedAt: '2026-07-14T16:01:00.000Z' }),
    );

    await store.deleteAllLocalData();
    expect(store.listTrustedExtensions()).toEqual([]);
    const inspector = new DatabaseSync(store.databasePath, { readOnly: true });
    expect(
      inspector.prepare('SELECT COUNT(*) AS count FROM trusted_extension_ledger').get(),
    ).toEqual({ count: 0 });
    inspector.close();
  });
});
