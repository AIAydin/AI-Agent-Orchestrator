import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AppSettings,
  CanvasDocument,
  Project,
} from '../../../shared/application/contracts.js';
import { SETTINGS_REPAIR_EVIDENCE_MAX_BYTES } from '../../../shared/settings/repair/contracts.js';
import { LocalStore } from '../../storage.js';
import { MIGRATIONS, openDatabase } from '../database.js';
import { sanitizeCanvasDocument } from '../values.js';

const PROJECT_ID = '20000000-0000-4000-8000-000000000001';
const CANVAS_ID = '20000000-0000-4000-8000-000000000002';
const NOW = '2026-07-16T12:00:00.000Z';
const roots: string[] = [];
const stores = new Set<LocalStore>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('stored settings upgrade compatibility', () => {
  it('starts a pre-current database, records evidence once, and preserves an oversized canvas', () => {
    const path = temporaryDatabasePath();
    const defaults = settings();
    const legacy = { ...defaults, worktreeRoot: 'relative/worktrees' };
    seedDatabase(path, MIGRATIONS.length - 1, JSON.stringify(legacy), oversizedCanvas());

    const first = openStore(path, defaults);

    expect(first.getSettings(defaults).worktreeRoot).toBe(defaults.worktreeRoot);
    expect(first.listSettingsRepairs()).toHaveLength(1);
    const summary = first.listSettingsRepairs()[0];
    expect(summary?.sourceDatabaseVersion).toBe(MIGRATIONS.length - 1);
    const evidence = summary === undefined ? undefined : first.getSettingsRepair(summary.id);
    expect(evidence?.sourceSettingsJson).toBe(JSON.stringify(legacy));
    const loaded = first.loadCanvas(PROJECT_ID);
    const agent = loaded?.canonical?.nodes.find((node) => node.type === 'agent');
    expect(agent?.type === 'agent' ? agent.data.contextAttachmentIds : []).toHaveLength(257);
    expect(first.checkIntegrity().ok).toBe(true);
    const portable = first.exportData();
    expect(portable).not.toHaveProperty('settingsRepairHistory');
    first.importData(portable, { replaceExisting: true });
    expect(first.listSettingsRepairs()).toHaveLength(1);

    closeStore(first);
    const second = openStore(path, defaults);
    expect(second.listSettingsRepairs()).toHaveLength(1);
  });

  it('repairs a known legacy row after the schema migration crash window', () => {
    const path = temporaryDatabasePath();
    const defaults = settings();
    seedDatabase(
      path,
      MIGRATIONS.length,
      JSON.stringify({ ...defaults, backupDirectory: 'relative/backups' }),
    );

    const store = openStore(path, defaults);

    expect(store.getSettings(defaults).backupDirectory).toBe(defaults.backupDirectory);
    expect(store.getSettings(defaults).backupsEnabled).toBe(false);
    expect(store.listSettingsRepairs()[0]?.sourceDatabaseVersion).toBe(MIGRATIONS.length);
  });

  it('resets a project-relative terminal executable before stored settings can activate', () => {
    const path = temporaryDatabasePath();
    const defaults = settings();
    seedDatabase(
      path,
      MIGRATIONS.length,
      JSON.stringify({ ...defaults, terminalShell: './project-tools/shell' }),
    );

    const store = openStore(path, defaults);

    expect(store.getSettings(defaults).terminalShell).toBe(defaults.terminalShell);
    expect(store.listSettingsRepairs()[0]?.repairedFieldPaths).toEqual(['terminalShell']);
  });

  it('enforces the 16 MiB UTF-8 evidence boundary in SQLite', () => {
    const path = temporaryDatabasePath();
    seedDatabase(path, MIGRATIONS.length, JSON.stringify(settings()));
    const connection = new DatabaseSync(path);
    const insert = connection.prepare(
      `INSERT INTO settings_repair_history(
         id, repaired_at, source_database_version, repaired_fields_json,
         source_settings_sha256, repaired_settings_sha256,
         source_settings_json, repaired_settings_json
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const exactBoundaryJson = `"${'x'.repeat(SETTINGS_REPAIR_EVIDENCE_MAX_BYTES - 2)}"`;
    insert.run(
      '30000000-0000-4000-8000-000000000001',
      NOW,
      MIGRATIONS.length - 1,
      '["worktreeRoot"]',
      'a'.repeat(64),
      'b'.repeat(64),
      exactBoundaryJson,
      '{}',
    );
    const byteLength = connection
      .prepare(
        `SELECT length(CAST(source_settings_json AS BLOB)) AS bytes
         FROM settings_repair_history WHERE id = ?`,
      )
      .get('30000000-0000-4000-8000-000000000001') as { bytes: number };
    expect(byteLength.bytes).toBe(SETTINGS_REPAIR_EVIDENCE_MAX_BYTES);
    connection.prepare('DELETE FROM settings_repair_history').run();

    expect(() =>
      insert.run(
        '30000000-0000-4000-8000-000000000002',
        NOW,
        MIGRATIONS.length - 1,
        '["worktreeRoot"]',
        'a'.repeat(64),
        'b'.repeat(64),
        `${exactBoundaryJson} `,
        '{}',
      ),
    ).toThrow(/CHECK constraint failed/iu);
    connection.close();
  });

  it('fails oversized stored settings with an explicit recovery error before copying evidence', () => {
    const path = temporaryDatabasePath();
    const oversizedSettings = `{"worktreeRoot":"${'x'.repeat(
      SETTINGS_REPAIR_EVIDENCE_MAX_BYTES,
    )}"}`;
    seedDatabase(path, MIGRATIONS.length - 1, oversizedSettings);

    expect(() => new LocalStore(path, { legacySettingsDefaults: settings() })).toThrow(
      /exceeds the 16 MiB bounded recovery-evidence limit.*Restore a known-good database backup/iu,
    );

    const connection = new DatabaseSync(path);
    const repairCount = connection
      .prepare('SELECT count(*) AS count FROM settings_repair_history')
      .get() as { count: number };
    expect(repairCount.count).toBe(0);
    connection.close();
  });

  it('still fails closed for unrelated corruption at the current version', () => {
    const path = temporaryDatabasePath();
    const defaults = settings();
    seedDatabase(
      path,
      MIGRATIONS.length,
      JSON.stringify({
        ...defaults,
        theme: 'corrupt',
        worktreeRoot: 'relative',
      }),
    );

    expect(() => new LocalStore(path, { legacySettingsDefaults: defaults })).toThrow(
      /outside the known legacy compatibility rules/iu,
    );
  });

  it('detects altered evidence and clears it only during complete data deletion', async () => {
    const path = temporaryDatabasePath();
    const defaults = settings();
    seedDatabase(
      path,
      MIGRATIONS.length - 1,
      JSON.stringify({ ...defaults, worktreeRoot: 'relative' }),
    );
    const store = openStore(path, defaults);
    const connection = new DatabaseSync(path);
    expect(() =>
      connection
        .prepare('UPDATE settings_repair_history SET source_settings_json = ?')
        .run(JSON.stringify({ altered: true })),
    ).toThrow(/immutable/iu);
    connection.exec('DROP TRIGGER settings_repair_history_no_update;');
    connection
      .prepare('UPDATE settings_repair_history SET source_settings_json = ?')
      .run(JSON.stringify({ altered: true }));
    expect(store.checkIntegrity().ok).toBe(false);
    connection.exec(`
      CREATE TRIGGER settings_repair_history_no_update
      BEFORE UPDATE ON settings_repair_history
      BEGIN
        SELECT RAISE(ABORT, 'settings repair evidence is immutable');
      END;
    `);
    connection.close();

    await store.deleteAllLocalData();
    expect(store.listSettingsRepairs()).toEqual([]);
    expect(store.checkIntegrity().ok).toBe(true);
  });
});

function temporaryDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeboard-settings-upgrade-'));
  roots.push(root);
  return join(root, 'forgeboard.sqlite3');
}

function openStore(path: string, defaults: AppSettings): LocalStore {
  const store = new LocalStore(path, { legacySettingsDefaults: defaults });
  stores.add(store);
  return store;
}

function closeStore(store: LocalStore): void {
  store.close();
  stores.delete(store);
}

function seedDatabase(
  path: string,
  version: number,
  settingsJson: string,
  canvas?: CanvasDocument,
): void {
  const database = openDatabase(path);
  for (let index = 0; index < version; index += 1) {
    const migration = MIGRATIONS[index];
    if (migration === undefined) throw new Error(`Missing migration ${String(index + 1)}.`);
    database.exec(migration);
    database
      .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
      .run(index + 1, NOW);
    database.exec(`PRAGMA user_version = ${String(index + 1)};`);
  }
  database
    .prepare('INSERT INTO app_settings(singleton, value_json, updated_at) VALUES(1, ?, ?)')
    .run(settingsJson, NOW);
  if (canvas !== undefined) {
    const seededProject = project();
    database
      .prepare('INSERT INTO recent_projects(id, path, value_json, opened_at) VALUES(?, ?, ?, ?)')
      .run(
        seededProject.id,
        seededProject.path,
        JSON.stringify(seededProject),
        seededProject.openedAt,
      );
    database
      .prepare(
        'INSERT INTO canvas_documents(id, project_id, value_json, updated_at) VALUES(?, ?, ?, ?)',
      )
      .run(canvas.id, canvas.projectId, JSON.stringify(canvas), canvas.updatedAt);
  }
  database.close();
}

function oversizedCanvas(): CanvasDocument {
  return sanitizeCanvasDocument({
    id: CANVAS_ID,
    projectId: PROJECT_ID,
    name: 'Legacy canvas',
    nodes: [
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          title: 'Legacy Agent',
          contextAttachmentIds: Array.from({ length: 257 }, (_, index) => `file-${String(index)}`),
        },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: NOW,
  });
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: 'Compatibility project',
    path: '/tmp/compatibility-project',
    openedAt: NOW,
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

function settings(): AppSettings {
  return {
    onboardingCompleted: true,
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    canvasGridSize: 16,
    canvasSnapToGrid: true,
    keyboardPreset: 'standard',
    defaultAgent: 'codex',
    defaultPermissionProfile: 'worktree-write',
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
    customPermissionProfile: {
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
    },
    worktreeRoot: '/device/worktrees',
    worktreeCleanupPolicy: 'manual',
    branchPrefix: 'forgeboard/',
    gitIdentityName: '',
    gitIdentityEmail: '',
    gitRemote: 'origin',
    externalEditorExecutable: '',
    terminalShell: '/bin/sh',
    envAllowlist: ['PATH'],
    developmentCommand: { executable: '', arguments: [] },
    testCommand: { executable: '', arguments: [] },
    lintCommand: { executable: '', arguments: [] },
    typecheckCommand: { executable: '', arguments: [] },
    buildCommand: { executable: '', arguments: [] },
    previewPortStart: 41_000,
    previewPortEnd: 41_999,
    previewTrustedHosts: ['127.0.0.1', 'localhost'],
    dockerEnabled: false,
    dockerExecutable: 'docker',
    dockerImage: '',
    dockerContainerExecutable: '',
    dockerNetwork: 'disabled',
    dockerCpuLimit: 2,
    dockerMemoryMb: 4_096,
    dockerMountHostCredentials: false,
    transcriptRetentionDays: 30,
    auditRetentionDays: 365,
    snapshotRetentionCount: 100,
    autosaveIntervalMs: 2_000,
    backupsEnabled: true,
    backupDirectory: '/device/backups',
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
    voiceCommandsEnabled: false,
    voiceAutoRunSafeActions: false,
  };
}
