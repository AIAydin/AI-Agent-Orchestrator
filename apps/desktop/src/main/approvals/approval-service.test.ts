import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../shared/application/contracts.js';
import {
  ApprovalListInputSchema,
  ApprovalRevocationInputSchema,
} from '../../shared/approvals/contracts.js';
import { ApprovalCreateInputSchema } from './approval-contracts.js';
import { ApprovalService } from './approval-service.js';
import { LocalStore } from '../storage.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const DECIDER_ID = '20000000-0000-4000-8000-000000000001';
const AGENT_ID = '30000000-0000-4000-8000-000000000001';
const RUN_ID = '40000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-07-15T16:00:00.000Z');
const roots: string[] = [];
const stores = new Set<LocalStore>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openStore(path = join(temporaryRoot(), 'forgeboard.sqlite3')): LocalStore {
  const store = new LocalStore(path);
  stores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  stores.delete(store);
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeboard-approval-test-'));
  roots.push(root);
  return root;
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Approval project',
    path: '/tmp/approval-project',
    openedAt: NOW.toISOString(),
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'pnpm',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function scope(
  overrides: Partial<{
    projectId: string;
    action: 'git-push' | 'external-send';
    resourceFingerprint: string;
    agentId: string;
    runId: string;
  }> = {},
) {
  return {
    projectId: PROJECT_ID,
    action: 'git-push' as const,
    resourceFingerprint: 'a'.repeat(64),
    agentId: AGENT_ID,
    runId: RUN_ID,
    ...overrides,
  };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    scope: scope(),
    decision: 'approved' as const,
    decidedBy: DECIDER_ID,
    reason: 'The user confirmed this exact action.',
    expiresAt: '2026-07-15T17:00:00.000Z',
    singleUse: true,
    ...overrides,
  };
}

describe('ApprovalService', () => {
  it('keeps renderer contracts strict without exposing grant creation', () => {
    expect(() => ApprovalListInputSchema.parse({ includeInactive: true, extra: true })).toThrow();
    expect(() =>
      ApprovalRevocationInputSchema.parse({
        approvalId: DECIDER_ID,
        projectId: PROJECT_ID,
        decidedBy: DECIDER_ID,
      }),
    ).toThrow();
    expect(() => ApprovalCreateInputSchema.parse({ ...createInput(), extra: true })).toThrow();
  });

  it('persists exact reusable grants and finds them without renderer-selected identities', () => {
    const databasePath = join(temporaryRoot(), 'forgeboard.sqlite3');
    const store = openStore(databasePath);
    store.saveProject(project());
    const service = new ApprovalService(store, () => NOW);
    const created = service.create({ ...createInput(), singleUse: false });

    expect(created.status).toBe('active');
    expect(service.findActive(scope())?.id).toBe(created.record.id);
    expect(
      service.findActive(scope({ runId: '40000000-0000-4000-8000-000000000002' })),
    ).toBeUndefined();
    expect(service.findActive(scope({ resourceFingerprint: 'b'.repeat(64) }))).toBeUndefined();
    expect(
      service.authorize({ approvalId: created.record.id, scope: scope() }).consumedAt,
    ).toBeUndefined();

    closeStore(store);
    const reopened = openStore(databasePath);
    expect(new ApprovalService(reopened, () => NOW).findActive(scope())?.id).toBe(
      created.record.id,
    );
  });

  it('consumes single-use grants once and rejects every exact-scope mismatch', () => {
    const store = openStore();
    store.saveProject(project());
    const service = new ApprovalService(store, () => NOW);
    const created = service.create(createInput());

    expect(() =>
      service.authorize({
        approvalId: created.record.id,
        scope: scope({ action: 'external-send' }),
      }),
    ).toThrow('does not match this exact');
    const consumed = service.authorize({ approvalId: created.record.id, scope: scope() });
    expect(consumed.consumedAt).toBe(NOW.toISOString());
    expect(service.findActive(scope())).toBeUndefined();
    expect(() => service.authorize({ approvalId: created.record.id, scope: scope() })).toThrow(
      'consumed',
    );
    expect(
      store
        .listAuditEvents(20)
        .filter((event) => event.action === 'saved-approval-use' && event.outcome === 'denied'),
    ).toHaveLength(2);
  });

  it('audits missing, cross-scope, and cross-project approval authority denials', () => {
    const databasePath = join(temporaryRoot(), 'forgeboard.sqlite3');
    const store = openStore(databasePath);
    store.saveProject(project());
    const service = new ApprovalService(store, () => NOW);
    const active = service.create({ ...createInput(), singleUse: false });
    const denied = service.create({ ...createInput(), decision: 'denied' });

    expect(() => service.authorize({ approvalId: DECIDER_ID, scope: scope() })).toThrow(
      'does not exist',
    );
    expect(() =>
      service.authorize({
        approvalId: active.record.id,
        scope: scope({ action: 'external-send' }),
      }),
    ).toThrow('exact project');
    expect(() =>
      service.revoke({
        approvalId: active.record.id,
        projectId: '10000000-0000-4000-8000-000000000099',
      }),
    ).toThrow('does not exist for this project');
    expect(() => service.revoke({ approvalId: denied.record.id, projectId: PROJECT_ID })).toThrow(
      'not an active grant',
    );

    const connection = new DatabaseSync(databasePath);
    const rows = connection
      .prepare(
        `SELECT action, outcome, metadata_json FROM audit_events
         WHERE category = 'permission' AND outcome = 'denied' ORDER BY sequence`,
      )
      .all() as Array<{ action: string; outcome: string; metadata_json: string }>;
    connection.close();
    expect(rows.map((row): unknown => JSON.parse(row.metadata_json) as unknown)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'approval-not-found' }),
        expect.objectContaining({ reason: 'scope-mismatch' }),
        expect.objectContaining({ reason: 'approval-not-found-or-cross-project' }),
        expect.objectContaining({ reason: 'denied-decision' }),
      ]),
    );
  });

  it('reports denied, expired, and revoked records without treating them as grants', () => {
    const store = openStore();
    store.saveProject(project());
    const service = new ApprovalService(store, () => NOW);
    const denied = service.create({ ...createInput(), decision: 'denied' });
    const expiredService = new ApprovalService(store, () => new Date('2026-07-15T18:00:00.000Z'));
    const active = service.create({ ...createInput(), singleUse: false });

    expect(denied.status).toBe('denied');
    expect(
      expiredService
        .list({ projectId: PROJECT_ID })
        .map((view) => view.status)
        .sort(),
    ).toEqual(['denied', 'expired']);
    const revoked = service.revoke({ approvalId: active.record.id, projectId: PROJECT_ID });
    expect(revoked.status).toBe('revoked');
    expect(service.list({ projectId: PROJECT_ID, includeInactive: false })).toEqual([]);
  });

  it('detects repository mirror tampering during integrity checks and startup', () => {
    const databasePath = join(temporaryRoot(), 'forgeboard.sqlite3');
    const store = openStore(databasePath);
    store.saveProject(project());
    const created = new ApprovalService(store, () => NOW).create(createInput());
    const connection = new DatabaseSync(databasePath);
    connection
      .prepare('UPDATE approval_records SET action = ? WHERE id = ?')
      .run('external-send', created.record.id);
    connection.close();

    expect(store.checkIntegrity().ok).toBe(false);
    closeStore(store);
    expect(() => openStore(databasePath)).toThrow('approval_records');
  });

  it('removes device-local grants during a portable replace import', () => {
    const store = openStore();
    store.saveProject(project());
    const created = new ApprovalService(store, () => NOW).create(createInput());
    const emptyStore = openStore();
    const emptyExport = emptyStore.exportData(NOW);

    store.importData(emptyExport, { replaceExisting: true, importedAt: NOW });
    expect(store.getApproval(created.record.id)).toBeUndefined();
  });

  it('rolls back grant, use, and revoke authority when their audit insert fails', () => {
    const databasePath = join(temporaryRoot(), 'forgeboard.sqlite3');
    const store = openStore(databasePath);
    store.saveProject(project());
    const service = new ApprovalService(store, () => NOW);
    const connection = new DatabaseSync(databasePath);
    const failAudit = () =>
      connection.exec(`
        CREATE TRIGGER fail_saved_approval_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.category = 'permission'
        BEGIN
          SELECT RAISE(ABORT, 'saved approval audit rejected');
        END;
      `);
    const allowAudit = () => connection.exec('DROP TRIGGER fail_saved_approval_audit');

    failAudit();
    expect(() => service.create({ ...createInput(), singleUse: false })).toThrow(
      'saved approval audit rejected',
    );
    expect(service.list({ projectId: PROJECT_ID, includeInactive: true })).toEqual([]);

    allowAudit();
    const reusable = service.create({ ...createInput(), singleUse: false });
    const singleUse = service.create(createInput());
    const auditCount = store.listAuditEvents(200).length;
    failAudit();

    expect(() => service.authorize({ approvalId: reusable.record.id, scope: scope() })).toThrow(
      'saved approval audit rejected',
    );
    expect(() => service.authorize({ approvalId: singleUse.record.id, scope: scope() })).toThrow(
      'saved approval audit rejected',
    );
    expect(store.getApproval(singleUse.record.id)?.consumedAt).toBeUndefined();
    expect(() => service.revoke({ approvalId: reusable.record.id, projectId: PROJECT_ID })).toThrow(
      'saved approval audit rejected',
    );
    expect(store.getApproval(reusable.record.id)?.revokedAt).toBeUndefined();
    expect(store.listAuditEvents(200)).toHaveLength(auditCount);

    allowAudit();
    connection.close();
  });

  it('records one canonical redacted audit event for each saved-approval transition', () => {
    const databasePath = join(temporaryRoot(), 'forgeboard.sqlite3');
    const store = openStore(databasePath);
    store.saveProject(project());
    const service = new ApprovalService(store, () => NOW);
    const created = service.create({ ...createInput(), singleUse: false });
    service.authorize({ approvalId: created.record.id, scope: scope() });
    service.revoke({ approvalId: created.record.id, projectId: PROJECT_ID });

    expect(
      store
        .listAuditEvents(10)
        .filter((event) => event.category === 'permission')
        .map((event) => event.action),
    ).toEqual(['saved-approval-revoke', 'saved-approval-use', 'saved-approval-grant']);
    const connection = new DatabaseSync(databasePath);
    const rows = connection
      .prepare(
        `SELECT metadata_json FROM audit_events
         WHERE category = 'permission' ORDER BY sequence`,
      )
      .all() as Array<{ metadata_json: string }>;
    connection.close();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        approvalId: created.record.id,
        projectId: PROJECT_ID,
        action: 'git-push',
        resourceFingerprint: 'a'.repeat(64),
        agentId: AGENT_ID,
        runId: RUN_ID,
      });
      expect(metadata).not.toHaveProperty('reason');
      expect(metadata).not.toHaveProperty('decidedBy');
    }
  });
});
