import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../../../shared/application/contracts.js';
import { LocalStore } from '../../storage.js';
import { MIGRATIONS, migrate, openDatabase } from '../database.js';
import {
  appendChainedAudit,
  initializeAuditIntegrity,
  pruneAuditPrefix,
} from '../security/audit-integrity.js';

const roots: string[] = [];
const stores = new Set<LocalStore>();

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeboard-audit-integrity-test-'));
  roots.push(root);
  return join(root, 'forgeboard.sqlite3');
}

function openStore(path = temporaryPath()): LocalStore {
  const store = new LocalStore(path);
  stores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  stores.delete(store);
}

describe('tamper-evident audit storage', () => {
  it('redacts before hashing, chains events, and blocks row updates and deletes', () => {
    const store = openStore();
    store.appendAudit('security', 'first', 'allowed', {
      token: 'sk-live-secret',
    });
    store.appendAudit('security', 'second', 'denied', {
      nested: { password: 'secret' },
    });
    const connection = new DatabaseSync(store.databasePath);
    const rows = connection
      .prepare(
        `SELECT sequence, metadata_json, previous_hash, event_hash
         FROM audit_events ORDER BY sequence`,
      )
      .all() as unknown as Array<{
      sequence: number;
      metadata_json: string;
      previous_hash: string;
      event_hash: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]?.metadata_json).toBe('{"token":"[REDACTED]"}');
    expect(rows[0]?.previous_hash).toBe('0'.repeat(64));
    expect(rows[1]?.previous_hash).toBe(rows[0]?.event_hash);
    expect(rows.every((row) => /^[0-9a-f]{64}$/u.test(row.event_hash))).toBe(true);
    expect(() =>
      connection.prepare('UPDATE audit_events SET action = ? WHERE sequence = 1').run('tampered'),
    ).toThrow('immutable');
    expect(() => connection.prepare('DELETE FROM audit_events WHERE sequence = 1').run()).toThrow(
      'append-only',
    );
    expect(() =>
      connection
        .prepare(
          `INSERT INTO audit_events(occurred_at, category, action, outcome, metadata_json)
           VALUES(?, ?, ?, ?, ?)`,
        )
        .run('2026-01-01T00:00:00.000Z', 'raw', 'unhashed', 'allowed', '{}'),
    ).toThrow('integrity hashes');
    connection.close();
    expect(store.checkIntegrity()).toMatchObject({ ok: true });
  });

  it('does not expose the production-owned database connection to an exact deletion sequence', () => {
    const store = openStore();
    store.appendAudit('security', 'protected', 'allowed', {});
    const reflected = store as unknown as Record<string, unknown>;
    const reflectedReadiness = reflected.deliveryReadiness as Record<string, unknown>;

    expect(reflected.database).toBeUndefined();
    expect(Object.values(reflected).some((value) => value instanceof DatabaseSync)).toBe(false);
    expect(Object.values(reflectedReadiness).some((value) => value instanceof DatabaseSync)).toBe(
      false,
    );
    expect(store.listAuditEvents(10)).toHaveLength(1);
  });

  it('rolls back controlled deletion authority and restores protection after retention fails', () => {
    const database = openDatabase(temporaryPath());
    migrate(database);
    initializeAuditIntegrity(database);
    appendChainedAudit(
      database,
      '2024-01-01T00:00:00.000Z',
      'security',
      'retained-after-failure',
      'allowed',
      {},
    );
    database.exec(`
      CREATE TRIGGER fail_controlled_audit_delete
      BEFORE DELETE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'forced controlled deletion failure');
      END;
    `);

    expect(() =>
      pruneAuditPrefix(database, '2026-01-01T00:00:00.000Z', new Date('2026-01-01T00:00:00.000Z')),
    ).toThrow('forced controlled deletion failure');
    expect(
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
        .get('audit_events_no_delete'),
    ).toBeDefined();
    expect(
      (database.prepare('SELECT count(*) AS count FROM audit_events').get() as { count: number })
        .count,
    ).toBe(1);
    database.exec('DROP TRIGGER fail_controlled_audit_delete;');
    expect(() => database.prepare('DELETE FROM audit_events').run()).toThrow('append-only');
    database.close();
  });

  it('detects an external exact trigger drop-delete-recreate during startup verification', () => {
    const databasePath = temporaryPath();
    const store = openStore(databasePath);
    store.appendAudit('security', 'first', 'allowed', {});
    store.appendAudit('security', 'second', 'allowed', {});
    store.appendAudit('security', 'third', 'allowed', {});
    const connection = new DatabaseSync(databasePath);
    const deleteTrigger = connection
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
      .get('audit_events_no_delete') as { sql: string };
    connection.prepare('DROP TRIGGER audit_events_no_delete').run();
    connection.prepare('DELETE FROM audit_events WHERE sequence = 2').run();
    connection.exec(`${deleteTrigger.sql};`);
    expect(store.checkIntegrity().ok).toBe(false);
    connection.close();
    closeStore(store);

    expect(() => openStore(databasePath)).toThrow(/audit|hash-chain/iu);
  });

  it('fails closed when the database immutability policy changes', () => {
    const databasePath = temporaryPath();
    const store = openStore(databasePath);
    store.appendAudit('security', 'protected', 'allowed', {});
    const connection = new DatabaseSync(databasePath);
    connection.prepare('DROP TRIGGER audit_events_no_update').run();
    connection.close();
    closeStore(store);

    expect(() => openStore(databasePath)).toThrow(/trigger|missing|changed/iu);
  });

  it('prunes only a verified leading prefix and anchors retained events to a checkpoint', () => {
    vi.useFakeTimers();
    const store = openStore();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    store.appendAudit('retention', 'old-prefix', 'allowed', {});
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    store.appendAudit('retention', 'new-middle', 'allowed', {});
    vi.setSystemTime(new Date('2024-02-01T00:00:00.000Z'));
    store.appendAudit('retention', 'old-after-new', 'allowed', {});

    const result = store.applyRetention(
      {
        ...defaultSettings(),
        auditRetentionDays: 365,
      },
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(result.deletedAuditEvents).toBe(1);
    expect(store.listAuditEvents(10).map((event) => event.action)).toEqual([
      'old-after-new',
      'new-middle',
    ]);
    expect(store.checkIntegrity().ok).toBe(true);

    const connection = new DatabaseSync(store.databasePath);
    const checkpoint = connection
      .prepare(
        `SELECT pruned_through_hash, event_count FROM audit_chain_checkpoints
         ORDER BY checkpoint_sequence DESC LIMIT 1`,
      )
      .get() as { pruned_through_hash: string; event_count: number };
    const firstRetained = connection
      .prepare('SELECT previous_hash FROM audit_events ORDER BY sequence LIMIT 1')
      .get() as { previous_hash: string };
    expect(checkpoint.event_count).toBe(1);
    expect(firstRetained.previous_hash).toBe(checkpoint.pruned_through_hash);
    expect(() =>
      connection
        .prepare('UPDATE audit_chain_checkpoints SET event_count = 2 WHERE checkpoint_sequence = 1')
        .run(),
    ).toThrow('immutable');
    expect(() =>
      connection.prepare('DELETE FROM audit_chain_checkpoints WHERE checkpoint_sequence = 1').run(),
    ).toThrow('append-only');
    connection.close();
  });

  it('upgrades and redacts unhashed legacy audit rows exactly once', () => {
    const databasePath = temporaryPath();
    const legacy = openDatabase(databasePath);
    for (let index = 0; index < MIGRATIONS.length - 1; index += 1) {
      const migration = MIGRATIONS[index];
      if (migration === undefined) throw new Error('Missing legacy migration.');
      legacy.exec(migration);
      legacy
        .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
        .run(index + 1, new Date().toISOString());
      legacy.exec(`PRAGMA user_version = ${index + 1};`);
    }
    legacy
      .prepare(
        `INSERT INTO audit_events(occurred_at, category, action, outcome, metadata_json)
         VALUES(?, ?, ?, ?, ?)`,
      )
      .run(
        '2026-01-01T00:00:00.000Z',
        'legacy',
        'unhashed',
        'allowed',
        JSON.stringify({ authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }),
      );
    legacy.close();

    const store = openStore(databasePath);
    const connection = new DatabaseSync(databasePath);
    const row = connection
      .prepare('SELECT metadata_json, previous_hash, event_hash FROM audit_events')
      .get() as {
      metadata_json: string;
      previous_hash: string;
      event_hash: string;
    };
    expect(row.metadata_json).toBe('{"authorization":"[REDACTED]"}');
    expect(row.previous_hash).toBe('0'.repeat(64));
    expect(row.event_hash).toMatch(/^[0-9a-f]{64}$/u);
    connection.close();
    expect(store.checkIntegrity().ok).toBe(true);
  });

  it('continues the chain from a checkpoint after every retained event is pruned', () => {
    vi.useFakeTimers();
    const store = openStore();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    store.appendAudit('retention', 'old-only-event', 'allowed', {});
    store.applyRetention(defaultSettings(), new Date('2026-01-01T00:00:00.000Z'));
    expect(store.listAuditEvents(10)).toEqual([]);

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    store.appendAudit('retention', 'after-checkpoint', 'allowed', {});
    const connection = new DatabaseSync(store.databasePath);
    const row = connection
      .prepare(
        `SELECT e.previous_hash, c.pruned_through_hash
         FROM audit_events e CROSS JOIN audit_chain_checkpoints c
         ORDER BY e.sequence DESC, c.checkpoint_sequence DESC LIMIT 1`,
      )
      .get() as { previous_hash: string; pruned_through_hash: string };
    connection.close();
    expect(row.previous_hash).toBe(row.pruned_through_hash);
    expect(store.checkIntegrity().ok).toBe(true);
  });
});

function defaultSettings(): AppSettings {
  return {
    onboardingCompleted: true,
    theme: 'system' as const,
    reducedMotion: false,
    density: 'comfortable' as const,
    canvasGridSize: 16,
    canvasSnapToGrid: true,
    keyboardPreset: 'standard' as const,
    defaultAgent: 'test-agent' as const,
    defaultPermissionProfile: 'plan-read-only' as const,
    agentExecutableOverrides: {},
    agentDefaultModels: {},
    customAgent: {
      enabled: false,
      name: 'Custom CLI',
      providerName: 'Custom provider',
      providerDisclosure: 'Disclosure.',
      sendsContextOffDevice: true,
      executable: '',
      versionArguments: ['--version'],
      launchArguments: [],
      promptTransport: 'argument' as const,
      runtime: 'pty' as const,
      output: 'text' as const,
    },
    customPermissionProfile: {
      runtime: 'host' as const,
      filesystem: 'assigned-worktree-read-only' as const,
      readPaths: ['.'],
      writePaths: [],
      ignoredFileRead: 'deny' as const,
      sensitiveFileRead: 'deny' as const,
      executablePolicy: 'selected-agent-only' as const,
      allowedExecutables: [],
      forgeboardManagedActions: {
        developmentServers: 'deny' as const,
        tests: 'deny' as const,
      },
      requireReviewBeforePrimary: true,
      docker: {
        network: 'disabled' as const,
        cpuLimit: 2,
        memoryMb: 4096,
        mountHostCredentials: false,
      },
    },
    worktreeRoot: '/tmp/worktrees',
    worktreeCleanupPolicy: 'manual' as const,
    branchPrefix: 'forgeboard/',
    gitIdentityName: '',
    gitIdentityEmail: '',
    gitRemote: 'origin',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH'],
    developmentCommand: { executable: '', arguments: [] },
    testCommand: { executable: '', arguments: [] },
    lintCommand: { executable: '', arguments: [] },
    typecheckCommand: { executable: '', arguments: [] },
    buildCommand: { executable: '', arguments: [] },
    previewPortStart: 4100,
    previewPortEnd: 4200,
    previewTrustedHosts: ['127.0.0.1'],
    dockerEnabled: false,
    dockerExecutable: 'docker',
    dockerImage: '',
    dockerContainerExecutable: '',
    dockerNetwork: 'disabled' as const,
    dockerCpuLimit: 2,
    dockerMemoryMb: 4096,
    dockerMountHostCredentials: false,
    transcriptRetentionDays: 30,
    auditRetentionDays: 365,
    snapshotRetentionCount: 100,
    autosaveIntervalMs: 2_000,
    backupsEnabled: true,
    backupDirectory: '/tmp/backups',
    backupIntervalHours: 24,
    backupOnQuit: true,
    backupRetentionCount: 30,
    collaborationEnabled: false,
    collaborationUrl: '',
    collaborationManagementUrl: '',
    collaborationDisplayName: 'Local user',
    collaborationSubject: 'local-user',
    collaborationColor: '#6d5efc',
    collaborationRoom: 'default',
    collaborationReconnect: true,
    updateChannel: 'stable' as const,
    automaticUpdateDownloads: false,
  };
}
