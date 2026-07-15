import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { CheckExecutionView } from '../shared/check-contracts.js';
import type { AppSettings, CanvasDocument, Project } from '../shared/contracts.js';
import { LocalStore, type StoredRunRecord, type TrustedExtensionLedgerRecord } from './storage.js';
import { canvasContentHash, sanitizeCanvasDocument } from './storage/values.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const CANVAS_ID = '10000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-07-14T16:00:00.000Z');
const roots: string[] = [];
const stores = new Set<LocalStore>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeboard-recovery-test-'));
  roots.push(root);
  return root;
}

function openStore(path = join(temporaryRoot(), 'data', 'forgeboard.sqlite3')): LocalStore {
  const store = new LocalStore(path);
  stores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  stores.delete(store);
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    name: 'Persistent project',
    path: '/tmp/persistent-project',
    openedAt: NOW.toISOString(),
    missing: false,
    health: {
      isGitRepository: false,
      branch: null,
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
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
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function rewriteSnapshotTimes(databasePath: string, timestamps: string[]): void {
  const connection = new DatabaseSync(databasePath);
  const rows = connection
    .prepare('SELECT id, value_json FROM canvas_snapshots ORDER BY rowid')
    .all() as unknown as Array<{ id: string; value_json: string }>;
  expect(rows).toHaveLength(timestamps.length);
  for (const [index, row] of rows.entries()) {
    const createdAt = timestamps[index];
    if (createdAt === undefined) throw new Error('Missing rewritten snapshot timestamp.');
    const value = JSON.parse(row.value_json) as Record<string, unknown>;
    connection
      .prepare('UPDATE canvas_snapshots SET created_at = ?, value_json = ? WHERE id = ?')
      .run(createdAt, JSON.stringify({ ...value, createdAt }), row.id);
  }
  connection.close();
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
    worktreeRoot: '/tmp/worktrees',
    worktreeCleanupPolicy: 'manual',
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
    dockerNetwork: 'disabled',
    dockerCpuLimit: 2,
    dockerMemoryMb: 4096,
    dockerMountHostCredentials: false,
    transcriptRetentionDays: 30,
    auditRetentionDays: 365,
    snapshotRetentionCount: 100,
    autosaveIntervalMs: 2000,
    backupsEnabled: true,
    backupDirectory: '/tmp/backups',
    backupIntervalHours: 24,
    backupOnQuit: true,
    backupRetentionCount: 30,
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

function run(
  id: string,
  status: StoredRunRecord['status'],
  updatedAt = NOW.toISOString(),
): StoredRunRecord {
  return {
    id,
    projectId: PROJECT_ID,
    nodeId: 'agent-node',
    adapterId: 'test-agent',
    status,
    cwd: '/tmp/worktree',
    branch: null,
    worktreeId: null,
    repositoryRoot: null,
    managedRoot: null,
    baseRef: null,
    baseCommit: null,
    startedAt: NOW.toISOString(),
    endedAt: status === 'prepared' || status === 'running' ? null : updatedAt,
    exitCode: status === 'succeeded' ? 0 : null,
    createdAt: NOW.toISOString(),
    updatedAt,
  };
}

function trustedExtension(): TrustedExtensionLedgerRecord {
  return {
    schemaVersion: 1,
    extensionId: 'dev.forgeboard.recovery-test',
    extensionVersion: '1.0.0',
    manifestDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64),
    permissions: ['agent.adapter.register'],
    approvedAt: NOW.toISOString(),
    state: 'active',
    operationId: '50000000-0000-4000-8000-000000000001',
    updatedAt: NOW.toISOString(),
  };
}

function checkExecution(
  id: string,
  status: CheckExecutionView['status'],
  updatedAt: string,
): CheckExecutionView {
  const terminal =
    status === 'passed' || status === 'failed' || status === 'cancelled' || status === 'lost';
  return {
    id,
    projectId: PROJECT_ID,
    checkId: 'test',
    label: 'Tests',
    kind: 'test',
    executable: 'pnpm',
    arguments: ['test'],
    cwd: '/tmp/persistent-project',
    environmentVariableNames: ['PATH'],
    status,
    exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
    startedAt: status === 'queued' ? null : updatedAt,
    endedAt: terminal ? updatedAt : null,
    output: terminal ? 'bounded retained output' : '',
    outputTruncated: false,
    updatedAt,
  };
}

describe('LocalStore persistence and recovery', () => {
  it('upgrades a version-two database in place without losing project or canvas data', () => {
    const databasePath = join(temporaryRoot(), 'forgeboard.sqlite3');
    const store = openStore(databasePath);
    store.saveProject(project());
    store.saveCanvas(canvas());
    closeStore(store);

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE workflow_node_bindings;
      DROP TABLE workflow_execution_events;
      DROP TABLE workflow_executions;
      DROP TABLE backup_health;
      DROP TABLE canvas_snapshots;
      DROP TABLE project_path_history;
      DROP TABLE backup_records;
      DROP TABLE trusted_extension_ledger;
      DROP TABLE check_executions;
      DELETE FROM schema_migrations WHERE version > 2;
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const upgraded = openStore(databasePath);
    expect(upgraded.getProject(PROJECT_ID)).toEqual(project());
    expect(upgraded.loadCanvas(PROJECT_ID)).toEqual(sanitizeCanvasDocument(canvas()));
    const inspector = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspector.prepare('PRAGMA user_version;').get()).toEqual({ user_version: 8 });
    expect(
      inspector
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN
              ('canvas_snapshots', 'project_path_history', 'backup_records', 'backup_health',
              'trusted_extension_ledger', 'check_executions', 'workflow_executions',
              'workflow_execution_events', 'workflow_node_bindings')
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: 'backup_health' },
      { name: 'backup_records' },
      { name: 'canvas_snapshots' },
      { name: 'check_executions' },
      { name: 'project_path_history' },
      { name: 'trusted_extension_ledger' },
      { name: 'workflow_execution_events' },
      { name: 'workflow_executions' },
      { name: 'workflow_node_bindings' },
    ]);
    inspector.close();
  });

  it('keeps durable undo and redo checkpoints without snapshotting timestamp-only saves', () => {
    const databasePath = join(temporaryRoot(), 'forgeboard.sqlite3');
    const store = openStore(databasePath);
    store.saveProject(project());
    store.saveCanvas(canvas());
    store.saveCanvas(canvas({ updatedAt: '2026-07-14T16:01:00.000Z' }));
    expect(store.listCanvasSnapshots(PROJECT_ID)).toEqual([]);

    const changed = canvas({
      name: 'Changed canvas',
      updatedAt: '2026-07-14T16:02:00.000Z',
    });
    store.saveCanvas(changed);
    const previous = store.listCanvasSnapshots(PROJECT_ID);
    expect(previous).toHaveLength(1);
    expect(previous[0]).toMatchObject({ reason: 'autosave', document: { name: 'Main canvas' } });

    closeStore(store);
    const reopened = openStore(databasePath);
    const restored = reopened.restoreCanvasSnapshot(
      previous[0]?.id ?? '',
      new Date('2026-07-14T16:03:00.000Z'),
    );
    expect(restored).toMatchObject({ name: 'Main canvas', updatedAt: '2026-07-14T16:03:00.000Z' });
    expect(reopened.loadCanvas(PROJECT_ID)).toEqual(restored);
    const restoreCheckpoint = reopened
      .listCanvasSnapshots(PROJECT_ID)
      .find((snapshot) => snapshot.reason === 'restore');
    expect(restoreCheckpoint?.document.name).toBe('Changed canvas');
  });

  it('rolls back manual snapshot creation when its atomic success audit fails', () => {
    const store = openStore();
    store.saveProject(project());
    store.saveCanvas(canvas());

    expect(() =>
      store.createCanvasSnapshotWithAudit(PROJECT_ID, 'manual', {
        category: 'recovery',
        action: 'snapshot-create',
        outcome: 'allowed',
        metadata: {},
        occurredAt: new Date(Number.NaN),
      }),
    ).toThrow('Invalid time value');
    expect(store.listCanvasSnapshots(PROJECT_ID)).toEqual([]);
    expect(store.loadCanvas(PROJECT_ID)).toEqual(sanitizeCanvasDocument(canvas()));
  });

  it('saves a project and its canvas atomically when a database write fails', () => {
    const store = openStore();
    const connection = new DatabaseSync(store.databasePath);
    connection.exec(`
      CREATE TRIGGER reject_canvas_insert
      BEFORE INSERT ON canvas_documents
      BEGIN
        SELECT RAISE(ABORT, 'canvas rejected');
      END;
    `);
    connection.close();

    expect(() => store.saveProjectAndCanvas(project(), canvas())).toThrow('canvas rejected');
    expect(store.getProject(PROJECT_ID)).toBeUndefined();
    expect(store.loadCanvas(PROJECT_ID)).toBeUndefined();
  });

  it('applies run, check, audit, and per-canvas snapshot retention in one maintenance pass', () => {
    const store = openStore();
    store.saveProject(project());
    store.saveCanvas(canvas());
    for (let index = 1; index <= 5; index += 1) {
      store.saveCanvas(
        canvas({
          name: `Canvas ${index}`,
          updatedAt: new Date(NOW.getTime() + index * 1000).toISOString(),
        }),
      );
    }
    const oldRun = '20000000-0000-4000-8000-000000000001';
    const currentRun = '20000000-0000-4000-8000-000000000002';
    const activeRun = '20000000-0000-4000-8000-000000000003';
    store.saveRun(run(oldRun, 'succeeded', '2025-01-01T00:00:00.000Z'));
    store.saveRun(run(currentRun, 'succeeded', '2026-07-10T00:00:00.000Z'));
    store.saveRun(run(activeRun, 'prepared', '2025-01-01T00:00:00.000Z'));
    const oldCheck = '21000000-0000-4000-8000-000000000001';
    const currentCheck = '21000000-0000-4000-8000-000000000002';
    const runningCheck = '21000000-0000-4000-8000-000000000003';
    const queuedCheck = '21000000-0000-4000-8000-000000000004';
    store.saveCheckExecution(checkExecution(oldCheck, 'passed', '2025-01-01T00:00:00.000Z'));
    store.saveCheckExecution(checkExecution(currentCheck, 'passed', '2026-07-10T00:00:00.000Z'));
    store.saveCheckExecution(checkExecution(runningCheck, 'running', '2025-01-01T00:00:00.000Z'));
    store.saveCheckExecution(checkExecution(queuedCheck, 'queued', '2025-01-01T00:00:00.000Z'));
    store.appendAudit('old', 'expired', 'allowed', {});
    store.appendAudit('new', 'retained', 'allowed', {});
    const connection = new DatabaseSync(store.databasePath);
    connection
      .prepare('UPDATE audit_events SET occurred_at = ? WHERE category = ?')
      .run('2024-01-01T00:00:00.000Z', 'old');
    connection.close();

    const result = store.applyRetention(
      settings({ transcriptRetentionDays: 30, auditRetentionDays: 365, snapshotRetentionCount: 2 }),
      NOW,
    );
    expect(result).toEqual({
      deletedRuns: 1,
      deletedCheckExecutions: 1,
      deletedAuditEvents: 1,
      deletedSnapshots: 3,
      scrubbedCanvasTranscripts: 0,
      scrubbedSnapshotTranscripts: 0,
    });
    expect(
      store
        .exportData()
        .runs.map((record) => record.id)
        .sort(),
    ).toEqual([activeRun, currentRun].sort());
    expect(
      store
        .listCheckExecutions(PROJECT_ID)
        .map((record) => record.id)
        .sort(),
    ).toEqual([currentCheck, queuedCheck, runningCheck].sort());
    expect(store.getCheckExecution(oldCheck)).toBeUndefined();
    expect(store.listAuditEvents(10).map((event) => event.category)).toEqual(['new']);
    expect(store.listCanvasSnapshots(PROJECT_ID)).toHaveLength(2);
  });

  it('retains the most recently inserted snapshots when the wall clock moves backwards', () => {
    const store = openStore();
    store.saveProject(project());
    store.saveCanvas(canvas({ name: 'Original' }));
    store.saveCanvas(canvas({ name: 'First revision' }));
    store.saveCanvas(canvas({ name: 'Second revision' }));
    store.saveCanvas(canvas({ name: 'Newest revision' }));
    rewriteSnapshotTimes(store.databasePath, [
      '2026-07-15T12:00:00.000Z',
      '2026-07-15T12:01:00.000Z',
      '2000-01-01T00:00:00.000Z',
    ]);

    const result = store.applyRetention(settings({ snapshotRetentionCount: 2 }), NOW);

    expect(result.deletedSnapshots).toBe(1);
    expect(store.listCanvasSnapshots(PROJECT_ID).map((snapshot) => snapshot.document.name)).toEqual(
      ['Second revision', 'First revision'],
    );
  });

  it('uses insertion order to break equal snapshot timestamps', () => {
    const store = openStore();
    store.saveProject(project());
    store.saveCanvas(canvas({ name: 'Original' }));
    store.saveCanvas(canvas({ name: 'First revision' }));
    store.saveCanvas(canvas({ name: 'Second revision' }));
    store.saveCanvas(canvas({ name: 'Newest revision' }));
    rewriteSnapshotTimes(store.databasePath, [
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
    ]);

    const result = store.applyRetention(settings({ snapshotRetentionCount: 2 }), NOW);

    expect(result.deletedSnapshots).toBe(1);
    expect(store.listCanvasSnapshots(PROJECT_ID).map((snapshot) => snapshot.document.name)).toEqual(
      ['Second revision', 'First revision'],
    );
  });

  it('scrubs expired transcripts from active canvases and retained snapshots', () => {
    const store = openStore();
    store.saveProject(project());
    const transcriptNode = {
      id: 'agent-node',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: {
        title: 'Agent',
        transcript: 'expired-transcript-secret',
        transcriptUpdatedAt: '2025-01-01T00:00:00.000Z',
      },
    };
    store.saveCanvas(canvas({ nodes: [transcriptNode] }));
    store.saveCanvas(
      canvas({
        name: 'Changed canvas',
        nodes: [transcriptNode],
        updatedAt: '2026-07-14T16:01:00.000Z',
      }),
    );

    const result = store.applyRetention(settings({ transcriptRetentionDays: 30 }), NOW);
    expect(result).toMatchObject({
      scrubbedCanvasTranscripts: 1,
      scrubbedSnapshotTranscripts: 1,
    });
    expect(JSON.stringify(store.exportData())).not.toContain('expired-transcript-secret');
    expect(store.checkIntegrity('full')).toMatchObject({ ok: true, messages: [] });
  });

  it('validates a portable export before importing it transactionally', () => {
    const source = openStore();
    source.saveSettings(settings({ theme: 'dark' }));
    source.saveProject(project());
    source.saveCanvas(canvas());
    source.saveCanvas(canvas({ name: 'Exported canvas', updatedAt: '2026-07-14T16:01:00.000Z' }));
    source.saveRun(run('30000000-0000-4000-8000-000000000001', 'succeeded'));
    source.appendAudit('export', 'portable', 'allowed', { token: 'must-be-redacted' });
    const exported = source.exportData(NOW);

    const destination = openStore();
    expect(destination.importData(exported, { replaceExisting: true })).toEqual({
      projects: 1,
      canvases: 1,
      runs: 1,
      checkExecutions: 0,
      snapshots: 1,
      auditEvents: 1,
    });
    const restored = destination.exportData(NOW);
    expect(restored).toEqual(exported);
    expect(JSON.stringify(restored)).not.toContain('must-be-redacted');

    const beforeInvalidImport = destination.exportData(NOW);
    const invalid = structuredClone(exported) as Record<string, unknown>;
    invalid.unexpected = true;
    expect(() => destination.importData(invalid, { replaceExisting: true })).toThrow();
    expect(destination.exportData(NOW)).toEqual(beforeInvalidImport);

    const collision = structuredClone(exported);
    const collisionRun = collision.runs[0];
    if (!collisionRun) throw new Error('Expected a run in the exported fixture.');
    collision.settings = null;
    collision.projects = [];
    collision.canvases = [];
    collision.snapshots = [];
    collision.audit = [];
    collision.runs[0] = { ...collisionRun, nodeId: 'different-node' };
    expect(() => destination.importData(collision)).toThrow(
      'merge imports cannot replace run history',
    );
    expect(destination.checkIntegrity()).toMatchObject({ ok: true, messages: [] });
  });

  it('preflights replace imports without mutating current local data', () => {
    const source = openStore();
    source.saveSettings(settings({ theme: 'dark' }));
    source.saveProject(
      project({
        id: '11000000-0000-4000-8000-000000000001',
        path: '/tmp/imported-project',
      }),
    );
    source.saveCanvas(
      canvas({
        id: '11000000-0000-4000-8000-000000000002',
        projectId: '11000000-0000-4000-8000-000000000001',
      }),
    );
    const imported = source.exportData(NOW);

    const destination = openStore();
    destination.saveSettings(settings({ theme: 'light' }));
    destination.saveProject(project());
    destination.saveCanvas(canvas({ name: 'Current local canvas' }));
    const before = destination.exportData(NOW);

    expect(destination.preflightImportData(imported, { replaceExisting: true })).toMatchObject({
      projects: 1,
      canvases: 1,
    });
    expect(destination.exportData(NOW)).toEqual(before);
    expect(destination.preflightImportData(imported)).toMatchObject({ projects: 1, canvases: 1 });
    expect(destination.exportData(NOW)).toEqual(before);
  });

  it('preserves existing settings while merging non-conflicting portable data', () => {
    const source = openStore();
    source.saveSettings(settings({ theme: 'dark' }));
    source.saveProject(
      project({
        id: '11500000-0000-4000-8000-000000000001',
        path: '/tmp/merge-settings-project',
      }),
    );
    const imported = source.exportData(NOW);

    const destination = openStore();
    destination.saveSettings(settings({ theme: 'light' }));
    expect(destination.importData(imported)).toMatchObject({ projects: 1 });
    expect(destination.getSettings(settings()).theme).toBe('light');
    expect(destination.getProject('11500000-0000-4000-8000-000000000001')).toBeDefined();
  });

  it('ignores imported settings during merge even when no local settings row exists', () => {
    const source = openStore();
    source.saveSettings(settings({ theme: 'dark' }));
    const imported = source.exportData(NOW);
    const destination = openStore();
    const fallback = settings({ theme: 'light' });

    expect(destination.importData(imported)).toMatchObject({ projects: 0 });
    expect(destination.getSettings(fallback)).toEqual(fallback);
  });

  it('rejects merge identity and project-canvas collisions without overwriting data', () => {
    const store = openStore();
    store.saveSettings(settings({ theme: 'light' }));
    store.saveProject(project());
    store.saveCanvas(canvas({ name: 'Current local canvas' }));
    store.appendAudit('existing', 'preserve', 'allowed', {});
    const before = store.exportData(NOW);

    const projectCollision = structuredClone(before);
    projectCollision.settings = null;
    projectCollision.canvases = [];
    projectCollision.runs = [];
    projectCollision.checkExecutions = [];
    projectCollision.snapshots = [];
    projectCollision.audit = [];
    expect(() => store.importData(projectCollision)).toThrow('merge imports cannot replace it');
    expect(store.exportData(NOW)).toEqual(before);

    const canvasCollision = structuredClone(projectCollision);
    canvasCollision.projects = [];
    canvasCollision.canvases = [
      sanitizeCanvasDocument(
        canvas({ id: '12000000-0000-4000-8000-000000000002', name: 'Imported overwrite' }),
      ),
    ];
    expect(() => store.importData(canvasCollision)).toThrow(
      'already has a canvas; merge imports cannot replace it',
    );
    expect(store.exportData(NOW)).toEqual(before);
  });

  it('rejects duplicate identities inside a portable import before writing', () => {
    const source = openStore();
    source.saveProject(project());
    source.saveCanvas(canvas());
    const duplicateProjects = source.exportData(NOW);
    const importedProject = duplicateProjects.projects[0];
    if (!importedProject) throw new Error('Expected an exported project.');
    duplicateProjects.projects.push({ ...importedProject, path: '/tmp/duplicate-project-id' });

    const destination = openStore();
    expect(() =>
      destination.preflightImportData(duplicateProjects, { replaceExisting: true }),
    ).toThrow('duplicate project id');
    expect(destination.listProjects()).toEqual([]);

    const duplicateCanvases = source.exportData(NOW);
    const importedCanvas = duplicateCanvases.canvases[0];
    if (!importedCanvas) throw new Error('Expected an exported canvas.');
    const duplicateCanvasId = '13000000-0000-4000-8000-000000000002';
    duplicateCanvases.canvases.push({
      ...importedCanvas,
      id: duplicateCanvasId,
      ...(importedCanvas.canonical === undefined
        ? {}
        : { canonical: { ...importedCanvas.canonical, id: duplicateCanvasId } }),
    });
    expect(() =>
      destination.preflightImportData(duplicateCanvases, { replaceExisting: true }),
    ).toThrow('more than one canvas for project');
    expect(destination.listProjects()).toEqual([]);
  });

  it('normalizes imported active runs and checks to durable lost records', () => {
    const source = openStore();
    source.saveProject(project());
    const runId = '16000000-0000-4000-8000-000000000001';
    const checkId = '16000000-0000-4000-8000-000000000002';
    source.saveRun(run(runId, 'prepared'));
    source.saveCheckExecution(checkExecution(checkId, 'queued', NOW.toISOString()));
    const imported = source.exportData(NOW);
    const recoveredAt = new Date('2026-07-14T17:00:00.000Z');

    const destination = openStore();
    destination.importDataWithAudit(
      imported,
      { replaceExisting: true, importedAt: recoveredAt },
      {
        category: 'recovery',
        action: 'local-data-import',
        outcome: 'allowed',
        metadata: {},
        occurredAt: recoveredAt,
      },
    );

    expect(destination.getRun(runId)).toMatchObject({
      status: 'lost',
      endedAt: recoveredAt.toISOString(),
      updatedAt: recoveredAt.toISOString(),
    });
    expect(destination.getCheckExecution(checkId)).toMatchObject({
      status: 'lost',
      endedAt: recoveredAt.toISOString(),
      updatedAt: recoveredAt.toISOString(),
    });
    expect(destination.exportData(NOW).audit.at(-1)?.metadata).toMatchObject({
      normalizedInterruptedRecords: { runs: 1, checkExecutions: 1 },
    });
  });

  it('preserves verified backups, trust, and only device-local ledgers on replace import', async () => {
    const source = openStore();
    source.saveProject(
      project({
        id: '14000000-0000-4000-8000-000000000001',
        path: '/tmp/imported-project',
      }),
    );
    const imported = source.exportData(NOW);

    const destination = openStore();
    destination.saveProject(project());
    destination.relocateProject(
      project({ path: '/tmp/relocated-before-import', openedAt: '2026-07-14T16:01:00.000Z' }),
    );
    const trusted = trustedExtension();
    destination.upsertActiveTrustedExtension(trusted);
    const backup = await destination.createBackup(join(temporaryRoot(), 'backups'), NOW);

    destination.importData(imported, { replaceExisting: true });

    expect(existsSync(backup.path)).toBe(true);
    expect(destination.listTrustedExtensions()).toEqual([trusted]);
    expect(destination.getProject(PROJECT_ID)).toBeUndefined();
    expect(destination.getProject('14000000-0000-4000-8000-000000000001')).toBeDefined();
    const inspector = new DatabaseSync(destination.databasePath, { readOnly: true });
    expect(inspector.prepare('SELECT COUNT(*) AS count FROM backup_records').get()).toEqual({
      count: 1,
    });
    expect(inspector.prepare('SELECT COUNT(*) AS count FROM project_path_history').get()).toEqual({
      count: 0,
    });
    inspector.close();
  });

  it('rolls back audited imports and restores when writing their success audit fails', () => {
    const importSource = openStore();
    importSource.saveProject(
      project({
        id: '15000000-0000-4000-8000-000000000001',
        path: '/tmp/audited-import-project',
      }),
    );
    const imported = importSource.exportData(NOW);

    const destination = openStore();
    destination.saveProject(project());
    destination.saveCanvas(canvas());
    const beforeImport = destination.exportData(NOW);
    expect(() =>
      destination.importDataWithAudit(
        imported,
        { replaceExisting: true },
        {
          category: 'recovery',
          action: 'local-data-import',
          outcome: 'allowed',
          metadata: {},
          occurredAt: new Date(Number.NaN),
        },
      ),
    ).toThrow('Invalid time value');
    expect(destination.exportData(NOW)).toEqual(beforeImport);

    destination.saveCanvas(
      canvas({ name: 'Changed canvas', updatedAt: '2026-07-14T16:01:00.000Z' }),
    );
    const target = destination
      .listCanvasSnapshots(PROJECT_ID)
      .find((snapshot) => snapshot.document.name === 'Main canvas');
    const current = destination.loadCanvas(PROJECT_ID);
    if (!target || !current) throw new Error('Expected current and recovery canvas data.');
    const snapshotCount = destination.listCanvasSnapshots(PROJECT_ID).length;
    expect(() =>
      destination.restoreCanvasSnapshotWithAudit(
        {
          projectId: PROJECT_ID,
          snapshotId: target.id,
          expectedSnapshotContentHash: target.contentHash,
          expectedCurrentCanvasContentHash: canvasContentHash(current),
          restoredAt: new Date('2026-07-14T16:02:00.000Z'),
        },
        {
          category: 'recovery',
          action: 'snapshot-restore',
          outcome: 'allowed',
          metadata: {},
          occurredAt: new Date(Number.NaN),
        },
      ),
    ).toThrow('Invalid time value');
    expect(destination.loadCanvas(PROJECT_ID)).toEqual(current);
    expect(destination.listCanvasSnapshots(PROJECT_ID)).toHaveLength(snapshotCount);
  });

  it('creates a timestamped, mode-restricted, checksummed SQLite backup', async () => {
    const store = openStore();
    store.saveProject(project());
    store.saveCanvas(canvas());
    const backupRoot = join(temporaryRoot(), 'nested', 'backups');
    const result = await store.createBackup(backupRoot, NOW);

    expect(result.path).toMatch(/forgeboard-2026-07-14T16-00-00-000Z-[a-f0-9-]{36}\.sqlite3$/);
    if (process.platform !== 'win32') {
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
    }
    const bytes = readFileSync(result.path);
    expect(result.sizeBytes).toBe(bytes.byteLength);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(readdirSync(backupRoot)).toEqual([basename(result.path)]);
    const backup = new DatabaseSync(result.path, { readOnly: true });
    expect(backup.prepare('PRAGMA quick_check;').get()).toEqual({ quick_check: 'ok' });
    expect(backup.prepare('SELECT COUNT(*) AS count FROM recent_projects').get()).toEqual({
      count: 1,
    });
    backup.close();
    await store.deleteAllLocalData();
    expect(existsSync(result.path)).toBe(false);
  });

  it('persists bounded backup health separately from portable data', async () => {
    const store = openStore();
    expect(store.getBackupHealth()).toEqual({
      lastAttemptAt: null,
      lastAttemptOutcome: null,
      lastError: null,
      lastVerifiedAt: null,
      lastVerifiedSizeBytes: null,
      lastVerifiedSha256Prefix: null,
      verifiedBackupCount: 0,
    });
    store.recordBackupAttempt({
      attemptedAt: NOW,
      outcome: 'failed',
      error: new Error(`\nDisk\u202e unavailable ${'x'.repeat(5_000)}`),
    });
    const failed = store.getBackupHealth();
    expect(failed.lastAttemptOutcome).toBe('failed');
    expect(failed.lastError).not.toMatch(/[\n\u202e]/u);
    expect(failed.lastError?.length).toBeLessThanOrEqual(4_096);

    const result = await store.createBackup(join(temporaryRoot(), 'backups'), NOW);
    store.recordVerifiedBackup(result);
    expect(store.getBackupHealth()).toMatchObject({
      lastAttemptAt: NOW.toISOString(),
      lastAttemptOutcome: 'verified',
      lastError: null,
      lastVerifiedAt: NOW.toISOString(),
      lastVerifiedSizeBytes: result.sizeBytes,
      lastVerifiedSha256Prefix: result.sha256.slice(0, 12),
      verifiedBackupCount: 1,
    });
  });

  it('prunes by insertion order while preserving the just-created backup across clock rollback', async () => {
    const store = openStore();
    store.saveProject(project());
    const backupRoot = join(temporaryRoot(), 'backups');
    const first = await store.createBackup(backupRoot, new Date('2026-07-14T12:00:00.000Z'));
    const latest = await store.createBackup(backupRoot, new Date('2026-07-12T12:00:00.000Z'));

    await expect(store.pruneBackups(1, latest.path)).resolves.toBe(1);
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(latest.path)).toBe(true);
    expect(readdirSync(backupRoot)).toEqual([basename(latest.path)]);
    await expect(store.pruneBackups(0, latest.path)).rejects.toThrow('from 1 through 365');
  }, 15_000);

  it('applies backup retention only within the newly backed-up destination', async () => {
    const store = openStore();
    store.saveProject(project());
    const firstRoot = join(temporaryRoot(), 'first-backups');
    const secondRoot = join(temporaryRoot(), 'second-backups');
    const first = await store.createBackup(firstRoot, new Date('2026-07-14T12:00:00.000Z'));
    const second = await store.createBackup(secondRoot, new Date('2026-07-14T13:00:00.000Z'));

    await expect(store.pruneBackups(1, second.path)).resolves.toBe(0);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  }, 15_000);

  it('rejects a backup destination writable by other users', async () => {
    if (process.platform === 'win32') return;
    const store = openStore();
    const backupRoot = join(temporaryRoot(), 'unsafe-backups');
    mkdirSync(backupRoot);
    chmodSync(backupRoot, 0o777);

    await expect(store.createBackup(backupRoot, NOW)).rejects.toThrow(
      'must not be writable by group or other users',
    );
    expect(existsSync(join(backupRoot, 'backup.sqlite3'))).toBe(false);
  });

  it('refuses to follow a replaced backup symlink during complete deletion', async () => {
    const store = openStore();
    store.saveProject(project());
    const backupRoot = join(temporaryRoot(), 'backups');
    const result = await store.createBackup(backupRoot, NOW);
    const outside = join(temporaryRoot(), 'outside.sqlite3');
    writeFileSync(outside, 'must survive');
    rmSync(result.path);
    symlinkSync(outside, result.path);

    await expect(store.deleteAllLocalData()).rejects.toThrow('no longer an ordinary file');
    expect(readFileSync(outside, 'utf8')).toBe('must survive');
    expect(store.getProject(PROJECT_ID)).toBeDefined();
  });

  it('does not forget backups in a currently unavailable recorded location', async () => {
    const store = openStore();
    store.saveProject(project());
    const backupRoot = join(temporaryRoot(), 'detached-backups');
    const backup = await store.createBackup(backupRoot, NOW);
    const secondId = '50000000-0000-4000-8000-000000000001';
    const secondPath = join(backupRoot, `forgeboard-manual-${secondId}.sqlite3`);
    copyFileSync(backup.path, secondPath);
    const ledgerWriter = new DatabaseSync(store.databasePath);
    ledgerWriter
      .prepare(
        `INSERT INTO backup_records(id, canonical_path, created_at, sha256, size_bytes)
         VALUES(?, ?, ?, ?, ?)`,
      )
      .run(secondId, secondPath, NOW.toISOString(), backup.sha256, backup.sizeBytes);
    ledgerWriter.close();
    rmSync(backup.path);

    const missingBackupIds = await store.listMissingRecordedBackupIds();
    expect(missingBackupIds).toHaveLength(1);
    await expect(store.deleteAllLocalData()).rejects.toThrow('recorded backup file is unavailable');
    expect(store.getProject(PROJECT_ID)).toBeDefined();
    let inspector = new DatabaseSync(store.databasePath, { readOnly: true });
    expect(inspector.prepare('SELECT COUNT(*) AS count FROM backup_records').get()).toEqual({
      count: 2,
    });
    inspector.close();

    rmSync(secondPath);
    await expect(
      store.deleteAllLocalData({ approvedMissingBackupIds: missingBackupIds }),
    ).rejects.toThrow('recorded backup file is unavailable');
    expect(store.getProject(PROJECT_ID)).toBeDefined();

    const allMissingBackupIds = await store.listMissingRecordedBackupIds();
    expect(allMissingBackupIds).toHaveLength(2);
    await store.deleteAllLocalData({ approvedMissingBackupIds: allMissingBackupIds });
    await expect(store.listMissingRecordedBackupIds()).resolves.toEqual([]);
    expect(store.getProject(PROJECT_ID)).toBeUndefined();
    inspector = new DatabaseSync(store.databasePath, { readOnly: true });
    expect(inspector.prepare('SELECT COUNT(*) AS count FROM backup_records').get()).toEqual({
      count: 0,
    });
    inspector.close();
  });

  it('securely vacuums deleted SQLite content instead of leaving recoverable row bytes', async () => {
    const databasePath = join(temporaryRoot(), 'forgeboard.sqlite3');
    const store = openStore(databasePath);
    const deletionMarker = 'FORGEBOARD_DELETION_MARKER_74a2f9fbc5';
    store.saveProject(project({ name: deletionMarker }));
    store.saveCanvas(
      canvas({
        nodes: [
          {
            id: 'secret-node',
            type: 'note-image',
            position: { x: 0, y: 0 },
            data: { title: deletionMarker },
          },
        ],
      }),
    );

    await store.deleteAllLocalData();
    expect(store.exportData().projects).toEqual([]);
    expect(readFileSync(databasePath).includes(Buffer.from(deletionMarker))).toBe(false);
  });

  it('reports logical corruption, rejects its backup, and exposes recovery details', async () => {
    const databasePath = join(temporaryRoot(), 'forgeboard.sqlite3');
    const store = openStore(databasePath);
    store.saveProject(project());
    const prepared = '40000000-0000-4000-8000-000000000001';
    const running = '40000000-0000-4000-8000-000000000002';
    store.saveRun(run(prepared, 'prepared'));
    store.saveRun(run(running, 'running'));
    expect(store.checkIntegrity('full')).toMatchObject({ ok: true, mode: 'full', messages: [] });
    closeStore(store);

    const reopened = openStore(databasePath);
    expect(reopened.getStartupRecoveryReport().lostRunIds.sort()).toEqual(
      [prepared, running].sort(),
    );
    expect(reopened.exportData().runs.every((record) => record.status === 'lost')).toBe(true);
    expect(reopened.listAuditEvents(1)[0]).toMatchObject({
      category: 'recovery',
      action: 'interrupted-runs',
    });

    const connection = new DatabaseSync(reopened.databasePath);
    connection.prepare('UPDATE recent_projects SET value_json = ?').run('{"invalid":true}');
    connection.close();
    expect(reopened.checkIntegrity()).toMatchObject({ ok: false });
    expect(reopened.checkIntegrity().messages.join(' ')).toContain('recent_projects row 1');
    const invalidBackupRoot = join(temporaryRoot(), 'invalid-backup');
    await expect(reopened.createBackup(invalidBackupRoot)).rejects.toThrow('failed validation');
    expect(readdirSync(invalidBackupRoot)).toEqual([]);
    const failedBackupLedger = new DatabaseSync(reopened.databasePath, { readOnly: true });
    expect(
      failedBackupLedger.prepare('SELECT COUNT(*) AS count FROM backup_records').get(),
    ).toEqual({ count: 0 });
    failedBackupLedger.close();
  });

  it('records project relocation while preserving the project id and canvas', () => {
    const store = openStore();
    store.saveProject(project({ missing: true }));
    store.saveCanvas(canvas());
    const relocated = project({
      path: '/tmp/moved-persistent-project',
      openedAt: '2026-07-14T18:00:00.000Z',
      missing: false,
    });
    expect(store.relocateProject(relocated)).toEqual(relocated);
    expect(store.getProject(PROJECT_ID)).toEqual(relocated);
    expect(store.loadCanvas(PROJECT_ID)).toEqual(sanitizeCanvasDocument(canvas()));

    const connection = new DatabaseSync(store.databasePath, { readOnly: true });
    expect(
      connection
        .prepare('SELECT project_id, previous_path, replacement_path FROM project_path_history')
        .get(),
    ).toEqual({
      project_id: PROJECT_ID,
      previous_path: '/tmp/persistent-project',
      replacement_path: '/tmp/moved-persistent-project',
    });
    connection.close();
  });
});
