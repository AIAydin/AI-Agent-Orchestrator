import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppSettings, CanvasDocument, Project } from '../shared/contracts.js';
import { LocalStore, type StoredRunRecord } from './storage.js';

const NOW = '2026-07-14T16:00:00.000Z';
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const CANVAS_ID = '00000000-0000-4000-8000-000000000002';

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
    collaborationEnabled: false,
    collaborationUrl: '',
    collaborationDisplayName: 'Local user',
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

describe('LocalStore', () => {
  it('runs real SQLite migrations and starts with WAL and a healthy database', () => {
    const store = openStore();
    const inspector = new DatabaseSync(store.databasePath, { readOnly: true });

    try {
      expect(inspector.prepare('PRAGMA journal_mode;').get()).toMatchObject({
        journal_mode: 'wal',
      });
      expect(inspector.prepare('PRAGMA quick_check;').get()).toMatchObject({ quick_check: 'ok' });
      expect(inspector.prepare('PRAGMA user_version;').get()).toMatchObject({ user_version: 6 });
      expect(
        inspector.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
      ]);
      expect(
        inspector
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN
               ('app_settings', 'recent_projects', 'canvas_documents', 'audit_events', 'agent_runs',
                'canvas_snapshots', 'project_path_history', 'backup_records',
                'trusted_extension_ledger', 'check_executions')
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'agent_runs' },
        { name: 'app_settings' },
        { name: 'audit_events' },
        { name: 'backup_records' },
        { name: 'canvas_documents' },
        { name: 'canvas_snapshots' },
        { name: 'check_executions' },
        { name: 'project_path_history' },
        { name: 'recent_projects' },
        { name: 'trusted_extension_ledger' },
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
    ).toThrow('Preview port end must be greater than preview port start.');

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
    expect(store.saveCanvas(initial)).toEqual(initial);
    expect(store.loadCanvas(PROJECT_ID)).toEqual(initial);
    expect(store.saveCanvas(updated)).toEqual(updated);
    expect(store.loadCanvas(PROJECT_ID)).toEqual(updated);
    expect(rows(store, 'canvases')).toHaveLength(1);

    closeStore(store);
    expect(openStore(databasePath).loadCanvas(PROJECT_ID)).toEqual(updated);
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

  it('exports a versioned, portable shape containing every local data category', () => {
    const store = openStore();
    const savedSettings = settings();
    const savedProject = project();
    const savedCanvas = canvas();
    store.saveSettings(savedSettings);
    store.saveProject(savedProject);
    store.saveCanvas(savedCanvas);
    store.appendAudit('privacy', 'export', 'allowed', { source: 'settings-ui' });

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
    expect(exported).toMatchObject({ format: 'forgeboard-local-export', version: 3 });
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
    store.appendAudit('privacy', 'delete', 'allowed', { source: 'settings-ui' });

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
