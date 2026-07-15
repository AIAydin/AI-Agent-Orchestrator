import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalExtensionService, createExtensionApproval } from '@forgeboard/extension-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExtensionManager, type ExtensionTrustStore } from './extension-manager.js';
import type { TrustedExtensionLedgerRecord, TrustedExtensionState } from '../storage.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ExtensionManager', () => {
  it('keeps selected plans owner-bound and performs approved install, update, and removal', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'downloaded-extension');
    const registry = join(root, 'user-data', 'extensions');
    const audits: { action: string; outcome: string }[] = [];
    const trustStore = new FakeExtensionTrustStore(audits);
    const manager = new ExtensionManager(new LocalExtensionService(registry), trustStore);
    await writeExtension(source, '1.0.0');

    const plan = await manager.plan(source, 7);
    expect(plan).toMatchObject({
      operation: 'install',
      currentVersion: null,
      manifest: { id: 'example.notes', version: '1.0.0' },
      requestedPermissions: ['canvas.data.persist', 'canvas.node.register'],
    });
    expect(plan.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.snapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.documentationText).toContain('Local example documentation');
    expect((await manager.list()).installed).toHaveLength(0);

    await expect(manager.approve(plan.planId, 8)).rejects.toThrow('expired');
    const installed = await manager.approve(plan.planId, 7);
    expect(trustStore.operations.slice(-2)).toEqual([
      'stage:example.notes',
      'activate:example.notes',
    ]);
    expect(installed.installed[0]).toMatchObject({
      manifest: { id: 'example.notes', version: '1.0.0' },
      record: {
        manifestDigest: plan.manifestDigest,
        snapshotDigest: plan.snapshotDigest,
      },
    });

    await writeExtension(source, '1.1.0');
    const updatePlan = await manager.plan(source, 7);
    expect(updatePlan).toMatchObject({
      operation: 'update',
      currentVersion: '1.0.0',
      manifest: { version: '1.1.0' },
    });
    const updated = await manager.approve(updatePlan.planId, 7);
    expect(updated.installed[0]?.manifest.version).toBe('1.1.0');

    await expect(manager.remove('example.notes', 'wrong')).rejects.toThrow('Type example.notes');
    const removed = await manager.remove('example.notes', 'example.notes');
    expect(removed.installed).toEqual([]);
    expect(removed.quarantined[0]).toMatchObject({
      extensionId: 'example.notes',
      ledgerState: 'revoked',
    });
    expect(trustStore.operations.at(-1)).toBe('revoke:example.notes');
    expect(audits).toEqual(
      expect.arrayContaining([
        { action: 'plan-install', outcome: 'allowed' },
        { action: 'approve', outcome: 'denied' },
        { action: 'install', outcome: 'allowed' },
        { action: 'plan-update', outcome: 'allowed' },
        { action: 'update', outcome: 'allowed' },
        { action: 'remove', outcome: 'denied' },
        { action: 'remove', outcome: 'allowed' },
      ]),
    );
  });

  it('expires a reviewed plan before it can mutate the local registry', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'downloaded-extension');
    await writeExtension(source, '1.0.0');
    let now = new Date('2026-07-14T16:00:00.000Z');
    const manager = new ExtensionManager(
      new LocalExtensionService(join(root, 'user-data', 'extensions')),
      new FakeExtensionTrustStore(),
      () => now,
    );
    const plan = await manager.plan(source, 7);
    now = new Date('2026-07-14T16:16:00.000Z');

    await expect(manager.approve(plan.planId, 7)).rejects.toThrow('expired');
    expect((await manager.list()).installed).toEqual([]);
  });

  it('rejects same-version and downgrade plans before replacing active trust', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'downloaded-extension');
    const trustStore = new FakeExtensionTrustStore();
    const manager = new ExtensionManager(
      new LocalExtensionService(join(root, 'user-data', 'extensions')),
      trustStore,
    );
    await writeExtension(source, '1.0.0');
    const installPlan = await manager.plan(source, 7);
    await manager.approve(installPlan.planId, 7);
    const activeBefore = trustStore.getTrustedExtension('example.notes');

    await expect(manager.plan(source, 7)).rejects.toMatchObject({ code: 'DOWNGRADE_DENIED' });
    await writeExtension(source, '0.9.0');
    await expect(manager.plan(source, 7)).rejects.toMatchObject({ code: 'DOWNGRADE_DENIED' });

    expect(trustStore.getTrustedExtension('example.notes')).toEqual(activeBefore);
    expect(trustStore.operations.filter((operation) => operation.startsWith('stage:'))).toEqual([
      'stage:example.notes',
    ]);
    expect((await manager.list()).installed[0]?.manifest.version).toBe('1.0.0');
  });

  it('operation-bound rollback preserves active trust when the registry update fails', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'downloaded-extension');
    const service = new LocalExtensionService(join(root, 'user-data', 'extensions'));
    const trustStore = new FakeExtensionTrustStore();
    const manager = new ExtensionManager(service, trustStore);
    await writeExtension(source, '1.0.0');
    const installPlan = await manager.plan(source, 7);
    await manager.approve(installPlan.planId, 7);
    const activeBefore = trustStore.getTrustedExtension('example.notes')!;
    await writeExtension(source, '1.1.0');
    const updatePlan = await manager.plan(source, 7);
    vi.spyOn(service, 'update').mockRejectedValueOnce(new Error('simulated registry failure'));

    await expect(manager.approve(updatePlan.planId, 7)).rejects.toThrow(
      'simulated registry failure',
    );

    expect(trustStore.getTrustedExtension('example.notes')).toMatchObject({
      state: 'active',
      extensionVersion: activeBefore.extensionVersion,
      manifestDigest: activeBefore.manifestDigest,
      snapshotDigest: activeBefore.snapshotDigest,
      permissions: activeBefore.permissions,
      operationId: activeBefore.operationId,
    });
    expect(trustStore.operations.at(-1)).toBe('restore:example.notes');
    expect((await manager.list()).installed[0]?.manifest.version).toBe('1.0.0');
  });

  it('removes its pending ledger when an approved install fails before registry commit', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'downloaded-extension');
    const service = new LocalExtensionService(join(root, 'user-data', 'extensions'));
    const trustStore = new FakeExtensionTrustStore();
    const manager = new ExtensionManager(service, trustStore);
    await writeExtension(source, '1.0.0');
    const plan = await manager.plan(source, 7);
    vi.spyOn(service, 'install').mockRejectedValueOnce(new Error('simulated install failure'));

    await expect(manager.approve(plan.planId, 7)).rejects.toThrow('simulated install failure');

    expect(trustStore.getTrustedExtension('example.notes')).toBeUndefined();
    expect(trustStore.operations).toEqual([
      'stage:example.notes',
      'revoke:example.notes',
      'purge:example.notes',
    ]);
    expect((await service.discover()).installed).toEqual([]);
  });

  it('evicts only the oldest plans owned by the window that exceeds its limit', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'downloaded-extension');
    await writeExtension(source, '1.0.0');
    const manager = new ExtensionManager(
      new LocalExtensionService(join(root, 'user-data', 'extensions')),
      new FakeExtensionTrustStore(),
    );

    const otherOwnerPlan = await manager.plan(source, 22);
    const noisyOwnerPlans = [];
    for (let index = 0; index < 65; index += 1) {
      noisyOwnerPlans.push(await manager.plan(source, 11));
    }

    await expect(manager.approve(noisyOwnerPlans[0]!.planId, 11)).rejects.toThrow('expired');
    const installed = await manager.approve(otherOwnerPlan.planId, 22);
    expect(installed.installed).toHaveLength(1);
    expect(installed.installed[0]?.manifest.id).toBe('example.notes');
  });

  it('quarantines a forged registry snapshot and every active-ledger mismatch', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'downloaded-extension');
    const registry = join(root, 'user-data', 'extensions');
    await writeExtension(source, '1.0.0');
    const service = new LocalExtensionService(registry);
    const plan = await service.planFromSelectedPath(source);
    await service.install(
      plan,
      createExtensionApproval(plan, {
        confirmed: true,
        permissions: plan.requestedPermissions,
      }),
    );
    const trustStore = new FakeExtensionTrustStore();
    const manager = new ExtensionManager(service, trustStore);

    const forged = await manager.list();
    expect(forged.installed).toEqual([]);
    expect(forged.quarantined[0]).toMatchObject({
      extensionId: 'example.notes',
      ledgerState: 'missing',
    });

    trustStore.records.set('example.notes', ledgerForPlan(plan, { state: 'pending' }));
    const recovered = await manager.list();
    expect(recovered.installed).toHaveLength(1);
    expect(trustStore.getTrustedExtension('example.notes')?.state).toBe('active');

    trustStore.records.set(
      'example.notes',
      ledgerForPlan(plan, { state: 'pending', manifestDigest: '0'.repeat(64) }),
    );
    const interrupted = await manager.list();
    expect(interrupted.installed).toEqual([]);
    expect(interrupted.quarantined[0]).toMatchObject({
      extensionId: 'example.notes',
      ledgerState: 'pending',
    });

    trustStore.records.set(
      'example.notes',
      ledgerForPlan(plan, { manifestDigest: '0'.repeat(64) }),
    );
    const mismatched = await manager.list();
    expect(mismatched.installed).toEqual([]);
    expect(mismatched.quarantined[0]?.reason).toContain('does not exactly match');

    trustStore.records.set('example.notes', ledgerForPlan(plan));
    expect((await manager.list()).installed).toHaveLength(1);
  });

  it('revokes and purges every ledger before removing all registry snapshots', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'downloaded-extension');
    const service = new LocalExtensionService(join(root, 'user-data', 'extensions'));
    const trustStore = new FakeExtensionTrustStore();
    const manager = new ExtensionManager(service, trustStore);
    await writeExtension(source, '1.0.0');
    const plan = await manager.plan(source, 1);
    await manager.approve(plan.planId, 1);

    await manager.purgeAll();

    expect(trustStore.operations).toContain('revoke:example.notes');
    expect(trustStore.operations).toContain('purge:example.notes');
    expect(trustStore.listTrustedExtensions()).toEqual([]);
    expect((await service.discover()).installed).toEqual([]);
  });
});

class FakeExtensionTrustStore implements ExtensionTrustStore {
  readonly records = new Map<string, TrustedExtensionLedgerRecord>();
  readonly operations: string[] = [];

  public constructor(private readonly audits: { action: string; outcome: string }[] = []) {}

  public appendAudit(
    _category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
  ): void {
    this.audits.push({ action, outcome });
  }

  public stageTrustedExtension(record: TrustedExtensionLedgerRecord): TrustedExtensionLedgerRecord {
    this.operations.push(`stage:${record.extensionId}`);
    this.records.set(record.extensionId, record);
    return record;
  }

  public activateTrustedExtension(
    extensionId: string,
    operationId: string,
    activatedAt = new Date(),
  ): TrustedExtensionLedgerRecord {
    const current = this.required(extensionId);
    if (current.operationId !== operationId) throw new Error('operation mismatch');
    const active = { ...current, state: 'active' as const, updatedAt: activatedAt.toISOString() };
    this.operations.push(`activate:${extensionId}`);
    this.records.set(extensionId, active);
    return active;
  }

  public restoreActiveTrustedExtension(
    previousRecord: TrustedExtensionLedgerRecord,
    failedOperationId: string,
    restoredAt = new Date(),
  ): TrustedExtensionLedgerRecord {
    const current = this.required(previousRecord.extensionId);
    if (current.state !== 'pending' || current.operationId !== failedOperationId) {
      throw new Error('stale rollback');
    }
    const restored = { ...previousRecord, updatedAt: restoredAt.toISOString() };
    this.operations.push(`restore:${previousRecord.extensionId}`);
    this.records.set(previousRecord.extensionId, restored);
    return restored;
  }

  public getTrustedExtension(extensionId: string): TrustedExtensionLedgerRecord | undefined {
    return this.records.get(extensionId);
  }

  public listTrustedExtensions(state?: TrustedExtensionState): TrustedExtensionLedgerRecord[] {
    return [...this.records.values()].filter(
      (record) => state === undefined || record.state === state,
    );
  }

  public revokeTrustedExtension(
    extensionId: string,
    removalOperationId: string,
    revokedAt = new Date(),
  ): TrustedExtensionLedgerRecord {
    const current = this.required(extensionId);
    const revoked = {
      ...current,
      state: 'revoked' as const,
      operationId: removalOperationId,
      updatedAt: revokedAt.toISOString(),
    };
    this.operations.push(`revoke:${extensionId}`);
    this.records.set(extensionId, revoked);
    return revoked;
  }

  public purgeTrustedExtension(extensionId: string, removalOperationId: string): boolean {
    const current = this.records.get(extensionId);
    if (current?.state !== 'revoked' || current.operationId !== removalOperationId) return false;
    this.operations.push(`purge:${extensionId}`);
    return this.records.delete(extensionId);
  }

  private required(extensionId: string): TrustedExtensionLedgerRecord {
    const record = this.records.get(extensionId);
    if (record === undefined) throw new Error(`Missing ledger ${extensionId}`);
    return record;
  }
}

function ledgerForPlan(
  plan: Awaited<ReturnType<LocalExtensionService['planFromSelectedPath']>>,
  overrides: Partial<TrustedExtensionLedgerRecord> = {},
): TrustedExtensionLedgerRecord {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    extensionId: plan.manifest.id,
    extensionVersion: plan.manifest.version,
    manifestDigest: plan.manifestDigest,
    snapshotDigest: plan.snapshotDigest,
    permissions: [...plan.requestedPermissions].sort(),
    approvedAt: timestamp,
    state: 'active',
    operationId: randomUUID(),
    updatedAt: timestamp,
    ...overrides,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-extension-manager-'));
  roots.push(root);
  return root;
}

async function writeExtension(source: string, version: string): Promise<void> {
  await mkdir(source, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id: 'example.notes',
    name: 'Example notes',
    version,
    description: 'Adds a declarative decision note to the canvas.',
    publisher: 'Example publisher',
    requestedPermissions: ['canvas.node.register', 'canvas.data.persist'],
    documentationFile: 'README.md',
    contributes: {
      agentAdapters: [],
      canvasNodeTypes: [
        {
          id: 'decision',
          displayName: 'Decision',
          description: 'Records a bounded project decision.',
          category: 'Planning',
          icon: 'note',
          color: '#4F46E5',
          capabilities: ['context-source', 'human-editable'],
          fields: [
            {
              id: 'summary',
              kind: 'multiline',
              label: 'Summary',
              required: true,
              maxLength: 4_000,
            },
          ],
          ports: [
            {
              id: 'context',
              label: 'Context',
              direction: 'output',
              dataType: 'context',
              multiple: true,
            },
          ],
        },
      ],
    },
  };
  await writeFile(join(source, 'forgeboard-extension.json'), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(source, 'README.md'), '# Local example documentation\n');
}
