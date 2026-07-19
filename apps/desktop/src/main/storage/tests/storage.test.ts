import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AppSettings,
  CanvasDocument,
  Project,
} from '../../../shared/application/contracts.js';
import { LocalStore, type StoredRunRecord } from '../../storage.js';
import { MIGRATIONS, openDatabase } from '../database.js';
import { deliveryReadinessIntegrityMessages } from '../git-readiness/repository.js';

const NOW = '2026-07-14T16:00:00.000Z';
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const CANVAS_ID = '00000000-0000-4000-8000-000000000002';

function legacyReadinessMigrationIndex(): number {
  const index = MIGRATIONS.findIndex((migration) =>
    migration.includes('DELETE FROM delivery_readiness_approvals'),
  );
  if (index < 0) throw new Error('Legacy readiness migration is missing.');
  return index;
}

const openStores = new Set<LocalStore>();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const store of openStores) store.close();
  openStores.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgeboard-storage-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'nested', 'forgeboard.sqlite3');
}

function openStore(databasePath = createDatabasePath()): LocalStore {
  const store = new LocalStore(databasePath);
  openStores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  openStores.delete(store);
}

function customPermissionProfile(): AppSettings['customPermissionProfile'] {
  return {
    runtime: 'host',
    filesystem: 'assigned-worktree-read-only',
    readPaths: ['.'],
    writePaths: [],
    ignoredFileRead: 'deny',
    sensitiveFileRead: 'deny',
    executablePolicy: 'selected-agent-only',
    allowedExecutables: [],
    forgeboardManagedActions: { developmentServers: 'deny', tests: 'deny' },
    requireReviewBeforePrimary: true,
    docker: {
      network: 'disabled',
      cpuLimit: 2,
      memoryMb: 4_096,
      mountHostCredentials: false,
    },
  };
}
function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    onboardingCompleted: true,
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    canvasGridSize: 16,
    canvasSnapToGrid: true,
    keyboardPreset: 'standard',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'plan-read-only',
    agentExecutableOverrides: {},
    agentDefaultModels: {},
    customAgent: {
      enabled: false,
      name: 'Custom CLI',
      providerName: 'Custom provider',
      providerDisclosure: 'Custom provider disclosure.',
      sendsContextOffDevice: true,
      executable: '',
      versionArguments: ['--version'],
      launchArguments: [],
      promptTransport: 'argument',
      runtime: 'pty',
      output: 'text',
    },
    customPermissionProfile: customPermissionProfile(),
    worktreeRoot: '/tmp/forgeboard-worktrees',
    worktreeCleanupPolicy: 'manual',
    branchPrefix: 'forgeboard/',
    gitIdentityName: '',
    gitIdentityEmail: '',
    gitRemote: 'origin',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH', 'HOME'],
    developmentCommand: { executable: '', arguments: [] },
    testCommand: { executable: '', arguments: [] },
    lintCommand: { executable: '', arguments: [] },
    typecheckCommand: { executable: '', arguments: [] },
    buildCommand: { executable: '', arguments: [] },
    previewPortStart: 4100,
    previewPortEnd: 4200,
    previewTrustedHosts: ['127.0.0.1', 'localhost'],
    dockerEnabled: false,
    dockerExecutable: 'docker',
    dockerImage: '',
    dockerContainerExecutable: '',
    dockerNetwork: 'disabled',
    dockerCpuLimit: 2,
    dockerMemoryMb: 4096,
    dockerMountHostCredentials: false,
    transcriptRetentionDays: 30,
    auditRetentionDays: 365,
    snapshotRetentionCount: 100,
    autosaveIntervalMs: 2000,
    backupsEnabled: true,
    backupDirectory: '/tmp/forgeboard-backups',
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
    updateChannel: 'stable',
    automaticUpdateDownloads: false,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    name: 'Forgeboard',
    path: '/tmp/forgeboard-project',
    openedAt: NOW,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [{ name: 'origin', url: 'https://example.test/forgeboard.git' }],
      packageManager: 'pnpm',
      frameworks: ['electron', 'react'],
      scripts: { test: 'vitest run' },
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
    ...overrides,
  };
}

function canvas(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return {
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Main canvas',
    nodes: [
      {
        id: 'task-1',
        type: 'task',
        position: { x: 12, y: 24 },
        data: { title: 'Build the desktop app' },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW,
    ...overrides,
  };
}

function rows(
  store: LocalStore,
  key: 'projects' | 'canvases' | 'runs' | 'checkExecutions' | 'snapshots' | 'audit',
) {
  const value = store.exportData()[key];
  if (!Array.isArray(value)) throw new Error(`Expected exported ${key} to be an array.`);
  return value as Record<string, unknown>[];
}

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function storedRun(overrides: Partial<StoredRunRecord> = {}): StoredRunRecord {
  return {
    id: uuidFor(500),
    projectId: PROJECT_ID,
    nodeId: 'agent-1',
    adapterId: 'test-agent',
    status: 'succeeded',
    cwd: '/tmp/forgeboard-worktrees/run-1',
    branch: 'forgeboard/agent-1',
    worktreeId: uuidFor(501),
    worktreeState: 'active',
    worktreeAuthority: 'owned',
    repositoryRoot: '/tmp/forgeboard-project',
    managedRoot: '/tmp/forgeboard-worktrees',
    baseRef: 'HEAD',
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    startedAt: NOW,
    endedAt: NOW,
    exitCode: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('LocalStore', () => {
  it('removes only valid legacy readiness rows in the workflow-binding migration', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE delivery_readiness_records(id TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        CREATE TABLE delivery_readiness_approvals(
          id TEXT PRIMARY KEY,
          readiness_id TEXT NOT NULL REFERENCES delivery_readiness_records(id) ON DELETE CASCADE
        );
      `);
      database
        .prepare('INSERT INTO delivery_readiness_records(id, value_json) VALUES(?, ?)')
        .run('legacy', JSON.stringify({ schemaVersion: 1 }));
      database
        .prepare('INSERT INTO delivery_readiness_records(id, value_json) VALUES(?, ?)')
        .run('current', JSON.stringify({ schemaVersion: 1, workflowBinding: {} }));
      database
        .prepare('INSERT INTO delivery_readiness_records(id, value_json) VALUES(?, ?)')
        .run('malformed', '{');
      database
        .prepare('INSERT INTO delivery_readiness_approvals(id, readiness_id) VALUES(?, ?)')
        .run('approval', 'legacy');

      const migration = MIGRATIONS[legacyReadinessMigrationIndex()]!;
      database.exec(migration);
      database.exec(migration);

      expect(
        database.prepare('SELECT id FROM delivery_readiness_records ORDER BY id').all(),
      ).toEqual([{ id: 'current' }, { id: 'malformed' }]);
      expect(database.prepare('SELECT id FROM delivery_readiness_approvals').all()).toEqual([]);
      const integrityMessages = deliveryReadinessIntegrityMessages(database).join('\n');
      expect(integrityMessages).toMatch(/delivery_readiness_records row 1/iu);
      expect(integrityMessages).toMatch(/delivery_readiness_records row 2/iu);
    } finally {
      database.close();
    }
  });

  it('upgrades legacy readiness without blocking startup or deleting its project and run', () => {
    const databasePath = createDatabasePath();
    const legacy = openDatabase(databasePath);
    for (const [index, migration] of MIGRATIONS.slice(
      0,
      legacyReadinessMigrationIndex(),
    ).entries()) {
      legacy.exec(migration);
      legacy
        .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
        .run(index + 1, NOW);
      legacy.exec(`PRAGMA user_version = ${String(index + 1)}`);
    }
    const savedProject = project();
    legacy
      .prepare('INSERT INTO recent_projects(id, path, value_json, opened_at) VALUES(?, ?, ?, ?)')
      .run(savedProject.id, savedProject.path, JSON.stringify(savedProject), savedProject.openedAt);
    const savedRun = storedRun();
    legacy
      .prepare(
        `INSERT INTO agent_runs(
           id, project_id, node_id, adapter_id, status, value_json, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        savedRun.id,
        savedRun.projectId,
        savedRun.nodeId,
        savedRun.adapterId,
        savedRun.status,
        JSON.stringify(savedRun),
        savedRun.createdAt,
        savedRun.updatedAt,
      );
    const readinessId = uuidFor(701);
    const approvalId = uuidFor(702);
    const sourceFingerprint = 'c'.repeat(64);
    const legacyReadiness = {
      schemaVersion: 1,
      id: readinessId,
      revision: 0,
      target: { kind: 'agent-worktree', projectId: PROJECT_ID, runId: savedRun.id },
      sourceFingerprint: {
        sourceHead: '1'.repeat(40),
        sourceTree: '2'.repeat(40),
        worktreeId: savedRun.worktreeId,
        runId: savedRun.id,
        requiredCheckConfigurationDigest: 'b'.repeat(64),
        digest: sourceFingerprint,
      },
      sourceBranch: savedRun.branch,
      baseCommit: savedRun.baseCommit,
      availableChecks: [],
      requiredChecks: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    legacy
      .prepare(
        `INSERT INTO delivery_readiness_records(
           id, project_id, run_id, worktree_id, source_fingerprint, revision,
           value_json, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        readinessId,
        PROJECT_ID,
        savedRun.id,
        savedRun.worktreeId,
        sourceFingerprint,
        0,
        JSON.stringify(legacyReadiness),
        NOW,
        NOW,
      );
    legacy
      .prepare(
        `INSERT INTO delivery_readiness_approvals(
           id, readiness_id, project_id, run_id, authority, source_fingerprint,
           evidence_fingerprint, approved_at, value_json
         ) VALUES(?, ?, ?, ?, 'human', ?, ?, ?, ?)`,
      )
      .run(
        approvalId,
        readinessId,
        PROJECT_ID,
        savedRun.id,
        sourceFingerprint,
        'd'.repeat(64),
        NOW,
        JSON.stringify({ schemaVersion: 1, id: approvalId }),
      );
    legacy.close();

    const upgraded = openStore(databasePath);
    expect(upgraded.checkIntegrity()).toMatchObject({ ok: true });
    expect(upgraded.getProject(PROJECT_ID)).toEqual(savedProject);
    expect(upgraded.getRun(savedRun.id)).toEqual(savedRun);
    expect(upgraded.getDeliveryReadiness(readinessId)).toBeUndefined();
    closeStore(upgraded);

    const reopened = openStore(databasePath);
    expect(reopened.checkIntegrity()).toMatchObject({ ok: true });
    expect(reopened.getProject(PROJECT_ID)?.id).toBe(PROJECT_ID);
  });

  it('notifies backup observers only for durable user-data mutations', () => {
    const store = openStore();
    let changes = 0;
    const unsubscribe = store.subscribeToDurableChanges(() => {
      changes += 1;
    });

    store.saveProject(project());
    store.appendAudit('backup', 'automatic-create', 'allowed', {}, false);
    store.appendAudit('project', 'open', 'allowed', {});
    expect(changes).toBe(2);

    unsubscribe();
    store.saveCanvas(canvas());
    expect(changes).toBe(2);
  });

  it('runs real SQLite migrations and starts with WAL and a healthy database', () => {
    const store = openStore();
    const inspector = new DatabaseSync(store.databasePath, { readOnly: true });

    try {
      expect(inspector.prepare('PRAGMA journal_mode;').get()).toMatchObject({
        journal_mode: 'wal',
      });
      expect(inspector.prepare('PRAGMA quick_check;').get()).toMatchObject({
        quick_check: 'ok',
      });
      expect(inspector.prepare('PRAGMA user_version;').get()).toMatchObject({
        user_version: MIGRATIONS.length,
      });
      expect(
        inspector.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual(MIGRATIONS.map((_migration, index) => ({ version: index + 1 })));
      expect(
        inspector
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN
               ('app_settings', 'recent_projects', 'canvas_documents', 'audit_events', 'agent_runs',
                'canvas_snapshots', 'project_path_history', 'backup_records', 'backup_health',
                'trusted_extension_ledger', 'check_executions', 'workflow_executions',
                'workflow_execution_events', 'workflow_node_bindings', 'approval_records',
                'git_review_notes', 'collaboration_sync_states', 'collaboration_sync_deliveries',
                'collaboration_rejected_comment_dismissals',
                'delivery_readiness_records', 'delivery_readiness_approvals',
                'audit_chain_state', 'audit_chain_checkpoints', 'settings_repair_history')
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'agent_runs' },
        { name: 'app_settings' },
        { name: 'approval_records' },
        { name: 'audit_chain_checkpoints' },
        { name: 'audit_chain_state' },
        { name: 'audit_events' },
        { name: 'backup_health' },
        { name: 'backup_records' },
        { name: 'canvas_documents' },
        { name: 'canvas_snapshots' },
        { name: 'check_executions' },
        { name: 'collaboration_rejected_comment_dismissals' },
        { name: 'collaboration_sync_deliveries' },
        { name: 'collaboration_sync_states' },
        { name: 'delivery_readiness_approvals' },
        { name: 'delivery_readiness_records' },
        { name: 'git_review_notes' },
        { name: 'project_path_history' },
        { name: 'recent_projects' },
        { name: 'settings_repair_history' },
        { name: 'trusted_extension_ledger' },
        { name: 'workflow_execution_events' },
        { name: 'workflow_executions' },
        { name: 'workflow_node_bindings' },
      ]);
    } finally {
      inspector.close();
    }
  });

  it('validates settings, returns a fallback before first save, and survives reopening', () => {
    const databasePath = createDatabasePath();
    const store = openStore(databasePath);
    const fallback = settings({ theme: 'dark' });
    const saved = settings({
      density: 'compact',
      envAllowlist: ['PATH', 'OPENAI_API_KEY'],
      previewPortStart: 5200,
      previewPortEnd: 5300,
    });

    expect(store.getSettings(fallback)).toEqual(fallback);
    expect(store.saveSettings(saved)).toEqual(saved);
    expect(store.getSettings(fallback)).toEqual(saved);
    expect(() => store.saveSettings(settings({ envAllowlist: ['NOT-VALID'] }))).toThrow();
    expect(() =>
      store.saveSettings(settings({ previewPortStart: 5200, previewPortEnd: 5200 })),
    ).toThrow('Preview port end must be higher than preview port start.');

    closeStore(store);
    const reopened = openStore(databasePath);
    expect(reopened.getSettings(fallback)).toEqual(saved);
  });

  it('keeps the 30 most recent projects without allowing a path to change project identity', () => {
    const store = openStore();
    for (let index = 1; index <= 32; index += 1) {
      store.saveProject(
        project({
          id: uuidFor(index),
          name: `Project ${index}`,
          path: `/tmp/project-${index}`,
          openedAt: new Date(Date.UTC(2026, 6, 14, 16, 0, index)).toISOString(),
        }),
      );
    }

    const recent = store.listProjects();
    expect(recent).toHaveLength(30);
    expect(recent[0]?.name).toBe('Project 32');
    expect(recent.at(-1)?.name).toBe('Project 3');

    const conflictingIdentity = project({
      id: uuidFor(99),
      name: 'Renamed project',
      path: '/tmp/project-32',
      openedAt: '2026-07-14T17:00:00.000Z',
    });
    expect(() => store.saveProject(conflictingIdentity)).toThrow(
      'already bound to a different project identity',
    );
    const updated = { ...conflictingIdentity, id: uuidFor(32) };
    expect(store.saveProject(updated)).toEqual(updated);
    expect(store.listProjects()[0]).toEqual(updated);
    expect(rows(store, 'projects')).toHaveLength(32);
  });

  it('saves, replaces, loads, and reopens a project canvas', () => {
    const databasePath = createDatabasePath();
    const store = openStore(databasePath);
    const initial = canvas();
    const updated = canvas({
      id: uuidFor(3),
      name: 'Renamed canvas',
      nodes: [],
      viewport: { x: 120, y: -40, zoom: 1.5 },
      updatedAt: '2026-07-14T17:00:00.000Z',
    });

    expect(store.loadCanvas(PROJECT_ID)).toBeUndefined();
    const savedInitial = store.saveCanvas(initial);
    expect(savedInitial).toMatchObject(initial);
    expect(savedInitial).toMatchObject({
      schemaVersion: 2,
      canonical: { schemaVersion: 1 },
    });
    expect(store.loadCanvas(PROJECT_ID)).toEqual(savedInitial);
    const savedUpdated = store.saveCanvas(updated);
    expect(savedUpdated).toMatchObject(updated);
    expect(store.loadCanvas(PROJECT_ID)).toEqual(savedUpdated);
    expect(rows(store, 'canvases')).toHaveLength(1);

    closeStore(store);
    expect(openStore(databasePath).loadCanvas(PROJECT_ID)).toEqual(savedUpdated);
  });

  it('redacts nested audit secrets before they reach SQLite or an export', () => {
    const store = openStore();
    const secretValues = [
      'top-level-secret',
      'nested-password',
      'authorization-value',
      'cookie-value',
      'private-key-value',
      'inline-reason-secret',
      'bearer-secret-value',
      'query-secret-value',
      'fragment-secret-value',
      'project-query-secret',
      'project-fragment-secret',
      'script-token-secret',
      'sk_live_51abcdefghijklmnopqrstuv',
    ];

    store.appendAudit('agent', 'launch', 'denied', {
      token: secretValues[0],
      nested: {
        password: secretValues[1],
        list: [
          { Authorization: secretValues[2] },
          { sessionCookie: secretValues[3] },
          { private_key: secretValues[4] },
        ],
        safe: 'visible-metadata',
      },
      reason: `request failed token=${secretValues[5]} Bearer ${secretValues[6]} raw ${secretValues[12]}`,
      remote: `https://example.test/repository.git?access_token=${secretValues[7]}#${secretValues[8]}`,
    });
    const projectWithSecrets = project();
    store.saveProject({
      ...projectWithSecrets,
      health: {
        ...projectWithSecrets.health,
        remotes: [
          {
            name: 'origin',
            url: `https://example.test/repository.git?api_key=${secretValues[9]}#${secretValues[10]}`,
          },
        ],
        scripts: { deploy: `deploy --token=${secretValues[11]}` },
      },
    });

    const exported = store.exportData();
    const serialized = JSON.stringify(exported);
    for (const secret of secretValues) expect(serialized).not.toContain(secret);

    const auditRows = rows(store, 'audit');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.metadata).toEqual({
      token: '[REDACTED]',
      nested: {
        password: '[REDACTED]',
        list: [
          { Authorization: '[REDACTED]' },
          { sessionCookie: '[REDACTED]' },
          { private_key: '[REDACTED]' },
        ],
        safe: 'visible-metadata',
      },
      reason: 'request failed token=[REDACTED] Bearer [REDACTED] raw [REDACTED]',
      remote: 'https://example.test/repository.git?access_token=REDACTED#REDACTED',
    });
  });

  it('returns only a bounded newest-first audit projection to the desktop UI', () => {
    const store = openStore();
    for (let index = 1; index <= 205; index += 1) {
      store.appendAudit('agent', `event-${index}`, 'allowed', {
        token: `must-not-reach-ui-${index}`,
      });
    }

    expect(store.listAuditEvents(3).map((event) => event.action)).toEqual([
      'event-205',
      'event-204',
      'event-203',
    ]);
    const latest = store.listAuditEvents(1)[0];
    expect(latest).toMatchObject({
      sequence: 205,
      category: 'agent',
      action: 'event-205',
      outcome: 'allowed',
    });
    expect(new Date(latest?.occurredAt ?? '').toISOString()).toBe(latest?.occurredAt);
    expect(store.listAuditEvents(10_000)).toHaveLength(200);
    expect(JSON.stringify(store.listAuditEvents(200))).not.toContain('must-not-reach-ui');
  });

  it('gets runs by id and lists only the selected project newest first', () => {
    const store = openStore();
    const otherProjectId = uuidFor(99);
    const older = storedRun({
      id: uuidFor(510),
      updatedAt: '2026-07-14T15:00:00.000Z',
    });
    const newer = storedRun({
      id: uuidFor(511),
      nodeId: 'other-agent-node',
      updatedAt: '2026-07-14T17:00:00.000Z',
    });
    const unrelated = storedRun({
      id: uuidFor(512),
      projectId: otherProjectId,
    });
    store.saveRun(older);
    store.saveRun(newer);
    store.saveRun(unrelated);

    expect(store.getRun(newer.id)).toEqual(newer);
    expect(store.getRun(uuidFor(999))).toBeUndefined();
    expect(store.listProjectRuns(PROJECT_ID).map((run) => run.id)).toEqual([newer.id, older.id]);
    expect(store.listProjectRuns(PROJECT_ID, 1).map((run) => run.id)).toEqual([newer.id]);
    expect(store.listProjectRuns(PROJECT_ID, 20, 'agent-1').map((run) => run.id)).toEqual([
      older.id,
    ]);
    expect(store.listProjectRuns(PROJECT_ID, 20, 'missing-node')).toEqual([]);
  });

  it('freezes every identity-critical worktree field while allowing lifecycle updates', () => {
    const store = openStore();
    const record = storedRun({
      status: 'running',
      endedAt: null,
      exitCode: null,
    });
    store.saveRun(record);
    const replacements: ReadonlyArray<Partial<StoredRunRecord>> = [
      { cwd: '/tmp/forgeboard-worktrees/replacement' },
      { branch: 'forgeboard/replacement' },
      { worktreeId: uuidFor(777) },
      { repositoryRoot: '/tmp/different-project' },
      { managedRoot: '/tmp/different-managed-root' },
      { baseRef: 'main' },
      { baseCommit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
    ];
    for (const replacement of replacements) {
      expect(() =>
        store.saveRun({
          ...record,
          ...replacement,
          updatedAt: '2026-07-14T16:01:00.000Z',
        }),
      ).toThrow('cannot change its persisted identity');
    }

    const completed = store.saveRun({
      ...record,
      status: 'succeeded',
      endedAt: '2026-07-14T16:02:00.000Z',
      exitCode: 0,
      updatedAt: '2026-07-14T16:02:00.000Z',
    });
    expect(store.getRun(record.id)).toEqual(completed);
  });

  it('uses exact dedicated worktree lifecycle transitions without clearing immutable bindings', () => {
    const store = openStore();
    const record = storedRun();
    store.saveRun(record);
    expect(() => store.saveRun({ ...record, worktreeState: 'cleaned' })).toThrow(
      'only through its exact transition operation',
    );
    expect(() =>
      store.transitionRunWorktreeState({
        runId: record.id,
        expectedWorktreeId: uuidFor(999),
        expectedState: 'active',
        nextState: 'cleanup-pending',
      }),
    ).toThrow('lifecycle changed');
    expect(() =>
      store.transitionRunWorktreeState({
        runId: record.id,
        expectedWorktreeId: record.worktreeId!,
        expectedState: 'active',
        nextState: 'cleaned',
      }),
    ).toThrow('Invalid run worktree lifecycle transition');

    const pending = store.transitionRunWorktreeState(
      {
        runId: record.id,
        expectedWorktreeId: record.worktreeId!,
        expectedState: 'active',
        nextState: 'cleanup-pending',
      },
      new Date('2026-07-14T18:00:00.000Z'),
    );
    expect(pending).toMatchObject({
      worktreeState: 'cleanup-pending',
      worktreeId: record.worktreeId,
      cwd: record.cwd,
      branch: record.branch,
      repositoryRoot: record.repositoryRoot,
      managedRoot: record.managedRoot,
      baseRef: record.baseRef,
      baseCommit: record.baseCommit,
      updatedAt: '2026-07-14T18:00:00.000Z',
    });
    expect(() =>
      store.transitionRunWorktreeState({
        runId: record.id,
        expectedWorktreeId: record.worktreeId!,
        expectedState: 'active',
        nextState: 'cleanup-pending',
      }),
    ).toThrow('lifecycle changed');
    const activeAgain = store.transitionRunWorktreeState(
      {
        runId: record.id,
        expectedWorktreeId: record.worktreeId!,
        expectedState: 'cleanup-pending',
        nextState: 'active',
      },
      new Date('2026-07-14T17:00:00.000Z'),
    );
    expect(activeAgain.updatedAt).toBe('2026-07-14T18:00:00.000Z');
    store.transitionRunWorktreeState({
      runId: record.id,
      expectedWorktreeId: record.worktreeId!,
      expectedState: 'active',
      nextState: 'cleanup-pending',
    });
    const cleaned = store.transitionRunWorktreeState({
      runId: record.id,
      expectedWorktreeId: record.worktreeId!,
      expectedState: 'cleanup-pending',
      nextState: 'cleaned',
    });
    expect(cleaned).toMatchObject({
      worktreeState: 'cleaned',
      worktreeId: record.worktreeId,
      cwd: record.cwd,
      branch: record.branch,
    });
    expect(() =>
      store.transitionRunWorktreeState({
        runId: record.id,
        expectedWorktreeId: record.worktreeId!,
        expectedState: 'cleaned',
        nextState: 'active',
      }),
    ).toThrow('Invalid run worktree lifecycle transition');
  });

  it('renames and archives a managed worktree across its complete persisted attempt lineage', () => {
    const store = openStore();
    const parent = storedRun();
    const child = storedRun({
      ...parent,
      id: uuidFor(502),
      action: 'resume',
      parentRunId: parent.id,
      createdAt: '2026-07-14T18:00:00.000Z',
      updatedAt: '2026-07-14T18:00:00.000Z',
    });
    store.saveRun(parent);
    store.saveRun(child);

    store.renameRunWorktreeBranch({
      runId: child.id,
      expectedWorktreeId: parent.worktreeId!,
      expectedBranch: parent.branch!,
      nextBranch: 'forgeboard/renamed-lineage',
    });
    expect(store.getRun(parent.id)?.branch).toBe('forgeboard/renamed-lineage');
    expect(store.getRun(child.id)?.branch).toBe('forgeboard/renamed-lineage');

    store.transitionRunWorktreeState({
      runId: child.id,
      expectedWorktreeId: parent.worktreeId!,
      expectedState: 'active',
      nextState: 'archived',
    });
    expect(store.getRun(parent.id)?.worktreeState).toBe('archived');
    expect(store.getRun(child.id)?.worktreeState).toBe('archived');

    store.transitionRunWorktreeState({
      runId: parent.id,
      expectedWorktreeId: parent.worktreeId!,
      expectedState: 'archived',
      nextState: 'active',
    });
    expect(store.getRun(parent.id)?.worktreeState).toBe('active');
    expect(store.getRun(child.id)?.worktreeState).toBe('active');
  });

  it('atomically transfers exact managed-worktree continuation authority', () => {
    const store = openStore();
    const parent = storedRun({
      status: 'interrupted',
      permissionProfile: 'worktree-write',
      providerSessionId: 'provider-session',
      resumeSupported: true,
      resumeCapabilitySource: 'probe',
      action: 'launch',
      parentRunId: null,
      supersededByRunId: null,
    });
    const child = storedRun({
      ...parent,
      id: uuidFor(502),
      status: 'prepared',
      providerSessionId: 'provider-session',
      resumeSupported: null,
      resumeCapabilitySource: null,
      action: 'resume',
      parentRunId: parent.id,
      worktreeAuthority: 'pending-transfer',
      startedAt: null,
      endedAt: null,
      exitCode: null,
      createdAt: '2026-07-14T18:00:00.000Z',
      updatedAt: '2026-07-14T18:00:00.000Z',
    });
    store.saveRun(parent);
    store.saveRun(child);

    store.transferRunWorktreeAuthority(
      { parentRunId: parent.id, childRunId: child.id },
      new Date('2026-07-14T18:01:00.000Z'),
    );

    expect(store.getRun(parent.id)).toMatchObject({ supersededByRunId: child.id });
    expect(store.getRun(child.id)).toMatchObject({ worktreeAuthority: 'owned' });
    expect(() =>
      store.transferRunWorktreeAuthority({ parentRunId: parent.id, childRunId: child.id }),
    ).toThrow('lineage or exact worktree authority changed');
  });

  it('transfers read-only continuation authority but rejects adapter authority drift atomically', () => {
    const store = openStore();
    const parent = storedRun({
      status: 'interrupted',
      adapterId: 'codex',
      model: 'gpt-5',
      permissionProfile: 'plan-read-only',
      providerSessionId: 'provider-session',
      resumeSupported: true,
      resumeCapabilitySource: 'manifest',
      action: 'launch',
      worktreeId: null,
      worktreeAuthority: 'owned',
      cwd: '/tmp/forgeboard-project',
      branch: 'main',
      repositoryRoot: '/tmp/forgeboard-project',
      managedRoot: null,
      baseRef: 'main',
    });
    const child = storedRun({
      ...parent,
      id: uuidFor(503),
      status: 'prepared',
      action: 'resume',
      parentRunId: parent.id,
      providerSessionId: 'provider-session',
      resumeSupported: null,
      resumeCapabilitySource: null,
      worktreeAuthority: 'pending-transfer',
      startedAt: null,
      endedAt: null,
      exitCode: null,
      createdAt: '2026-07-14T18:00:00.000Z',
      updatedAt: '2026-07-14T18:00:00.000Z',
    });
    store.saveRun(parent);
    store.saveRun(child);
    store.transferRunWorktreeAuthority({ parentRunId: parent.id, childRunId: child.id });
    expect(store.getRun(child.id)?.worktreeAuthority).toBe('owned');

    const secondParent = { ...parent, id: uuidFor(504), supersededByRunId: null };
    const driftedChild = {
      ...child,
      id: uuidFor(505),
      parentRunId: secondParent.id,
      adapterId: 'claude',
      worktreeAuthority: 'pending-transfer' as const,
    };
    store.saveRun(secondParent);
    store.saveRun(driftedChild);
    expect(() =>
      store.transferRunWorktreeAuthority({
        parentRunId: secondParent.id,
        childRunId: driftedChild.id,
      }),
    ).toThrow('lineage or exact worktree authority changed');
    expect(store.getRun(secondParent.id)?.supersededByRunId).toBeNull();
    expect(store.getRun(driftedChild.id)?.worktreeAuthority).toBe('pending-transfer');
  });

  it('reads legacy run JSON with null durable-worktree fields', () => {
    const databasePath = createDatabasePath();
    const store = openStore(databasePath);
    closeStore(store);
    const legacy = storedRun();
    const legacyJson: Record<string, unknown> = { ...legacy };
    for (const field of [
      'repositoryRoot',
      'managedRoot',
      'baseRef',
      'baseCommit',
      'worktreeState',
    ]) {
      Reflect.deleteProperty(legacyJson, field);
    }
    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare(
          `INSERT INTO agent_runs(
             id, project_id, node_id, adapter_id, status, value_json, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          legacy.id,
          legacy.projectId,
          legacy.nodeId,
          legacy.adapterId,
          legacy.status,
          JSON.stringify(legacyJson),
          legacy.createdAt,
          legacy.updatedAt,
        );
    } finally {
      database.close();
    }

    const reopened = openStore(databasePath);
    expect(reopened.getRun(legacy.id)).toMatchObject({
      worktreeState: 'active',
      repositoryRoot: null,
      managedRoot: null,
      baseRef: null,
      baseCommit: null,
    });
  });

  it('exports a versioned, portable shape containing every local data category', () => {
    const store = openStore();
    const savedSettings = settings();
    const savedProject = project();
    const canvasInput = canvas();
    store.saveSettings(savedSettings);
    store.saveProject(savedProject);
    const savedCanvas = store.saveCanvas(canvasInput);
    store.appendAudit('privacy', 'export', 'allowed', {
      source: 'settings-ui',
    });

    const exported = store.exportData();
    expect(Object.keys(exported).sort()).toEqual([
      'audit',
      'canvases',
      'checkExecutions',
      'exportedAt',
      'format',
      'projects',
      'runs',
      'settings',
      'snapshots',
      'version',
    ]);
    expect(exported).toMatchObject({
      format: 'forgeboard-local-export',
      version: 3,
    });
    expect(new Date(String(exported.exportedAt)).toISOString()).toBe(exported.exportedAt);
    expect(exported.settings).toEqual(savedSettings);
    expect(rows(store, 'projects')[0]).toEqual(savedProject);
    expect(rows(store, 'canvases')[0]).toEqual(savedCanvas);
    expect(rows(store, 'runs')).toEqual([]);
    expect(rows(store, 'checkExecutions')).toEqual([]);
    expect(rows(store, 'snapshots')).toEqual([]);
    expect(rows(store, 'audit')[0]).toMatchObject({
      sequence: 1,
      category: 'privacy',
      action: 'export',
      outcome: 'allowed',
    });
  });

  it('marks prepared or running child processes as lost after a restart', () => {
    const databasePath = createDatabasePath();
    const store = openStore(databasePath);
    const record: StoredRunRecord = {
      id: uuidFor(500),
      projectId: PROJECT_ID,
      nodeId: 'agent-1',
      adapterId: 'test-agent',
      status: 'running',
      cwd: '/tmp/forgeboard-worktrees/run-1',
      branch: 'forgeboard/agent-1',
      worktreeId: uuidFor(501),
      worktreeState: 'active',
      repositoryRoot: '/tmp/forgeboard-project',
      managedRoot: '/tmp/forgeboard-worktrees',
      baseRef: 'HEAD',
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
      startedAt: NOW,
      endedAt: null,
      exitCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.saveRun(record);
    closeStore(store);

    const reopened = openStore(databasePath);
    const recovered = rows(reopened, 'runs')[0];
    expect(recovered).toMatchObject({
      id: record.id,
      status: 'lost',
      exitCode: null,
    });
    expect(recovered).toHaveProperty('endedAt');
  });

  it('rolls back every local-data deletion if any table delete fails', async () => {
    const store = openStore();
    store.saveSettings(settings());
    store.saveProject(project());
    store.saveCanvas(canvas());
    store.appendAudit('privacy', 'delete', 'allowed', {
      source: 'settings-ui',
    });

    const triggerConnection = new DatabaseSync(store.databasePath);
    try {
      triggerConnection.exec(`
        CREATE TRIGGER force_delete_failure
        BEFORE DELETE ON recent_projects
        BEGIN
          SELECT RAISE(ABORT, 'forced delete failure');
        END;
      `);
    } finally {
      triggerConnection.close();
    }

    await expect(store.deleteAllLocalData()).rejects.toThrow('forced delete failure');
    expect(store.exportData().settings).not.toBeNull();
    expect(rows(store, 'projects')).toHaveLength(1);
    expect(rows(store, 'canvases')).toHaveLength(1);
    expect(rows(store, 'audit')).toHaveLength(1);

    const cleanupConnection = new DatabaseSync(store.databasePath);
    try {
      cleanupConnection.exec('DROP TRIGGER force_delete_failure;');
    } finally {
      cleanupConnection.close();
    }

    await store.deleteAllLocalData();
    expect(store.exportData().settings).toBeNull();
    expect(rows(store, 'projects')).toEqual([]);
    expect(rows(store, 'canvases')).toEqual([]);
    expect(rows(store, 'audit')).toEqual([]);
  });

  it('rejects corrupt database input instead of silently replacing local data', () => {
    const databasePath = createDatabasePath();
    mkdirSync(dirname(databasePath), { recursive: true });
    const corruptBytes = Buffer.from('this is not a SQLite database');
    writeFileSync(databasePath, corruptBytes);

    expect(() => openStore(databasePath)).toThrow();
    expect(readFileSync(databasePath)).toEqual(corruptBytes);
    expect(() => rmSync(databasePath)).not.toThrow();
  });
});
