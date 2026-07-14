import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { PRODUCT } from '@forgeboard/core';
import { app, dialog, ipcMain } from 'electron';
import { z } from 'zod';

import {
  AppSettingsSchema,
  AuditListInputSchema,
  CanvasDocumentSchema,
  CloneProjectInputSchema,
  CreateProjectInputSchema,
  IPC_CHANNELS,
  type AppSettings,
  type IpcResult,
} from '../shared/contracts.js';
import { detectAgents, ProjectService } from './project-service.js';
import { RunService } from './run-service.js';
import type { LocalStore } from './storage.js';

const PathSchema = z.string().min(1).max(32_768);
const ProjectIdSchema = z.string().uuid();

export function createDefaultSettings(): AppSettings {
  const documents = app.getPath('documents');
  return {
    theme: 'system',
    reducedMotion: false,
    density: 'comfortable',
    canvasGridSize: 16,
    canvasSnapToGrid: true,
    keyboardPreset: 'standard',
    defaultAgent: 'test-agent',
    defaultPermissionProfile: 'worktree-write',
    agentExecutableOverrides: {},
    agentDefaultModels: {},
    worktreeRoot: join(documents, PRODUCT.dataDirectoryName, PRODUCT.worktreeDirectoryName),
    worktreeCleanupPolicy: 'manual',
    branchPrefix: 'forgeboard/',
    gitIdentityName: '',
    gitIdentityEmail: '',
    gitRemote: 'origin',
    terminalShell:
      process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh'),
    envAllowlist: ['PATH', 'HOME', 'LANG', 'TERM', 'COLORTERM'],
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
    dockerImage: 'node:22-bookworm',
    dockerNetwork: 'disabled',
    dockerCpuLimit: 2,
    dockerMemoryMb: 4096,
    dockerMountHostCredentials: false,
    transcriptRetentionDays: 30,
    auditRetentionDays: 365,
    snapshotRetentionCount: 100,
    autosaveIntervalMs: 2000,
    backupsEnabled: true,
    backupDirectory: join(documents, PRODUCT.dataDirectoryName, 'backups'),
    collaborationEnabled: false,
    collaborationUrl: 'ws://127.0.0.1:1234',
    collaborationDisplayName: 'Local user',
    collaborationRoom: 'default',
    collaborationReconnect: true,
    updateChannel: 'stable',
    automaticUpdateDownloads: false,
  };
}

export function registerIpcHandlers(store: LocalStore): RunService {
  const projects = new ProjectService(app, dialog, store);
  const transcripts = join(app.getPath('userData'), 'transcripts');
  const testAgentPath = app.isPackaged
    ? join(process.resourcesPath, 'test-agent', 'cli.js')
    : resolve(process.cwd(), '../../packages/test-agent/dist/cli.js');

  handle(IPC_CHANNELS.appInfo, z.tuple([]), () => ({
    name: PRODUCT.name,
    version: app.getVersion(),
    platform: process.platform,
    dataDirectory: app.getPath('userData'),
    databasePath: store.databasePath,
    transcriptDirectory: transcripts,
  }));

  handle(IPC_CHANNELS.settingsGet, z.tuple([]), () => store.getSettings(createDefaultSettings()));
  handle(IPC_CHANNELS.settingsUpdate, z.tuple([AppSettingsSchema]), (settings) => {
    const saved = store.saveSettings(AppSettingsSchema.parse(settings));
    store.appendAudit('settings', 'update', 'allowed', {
      keys: Object.keys(saved),
      envNames: saved.envAllowlist,
    });
    return saved;
  });
  handle(IPC_CHANNELS.settingsReset, z.tuple([]), () => {
    const saved = store.saveSettings(createDefaultSettings());
    store.appendAudit('settings', 'reset', 'allowed', {});
    return saved;
  });
  handle(IPC_CHANNELS.settingsExport, z.tuple([]), async () => {
    const selection = await dialog.showSaveDialog({
      title: 'Export Forgeboard settings',
      defaultPath: 'forgeboard-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    const settings = store.getSettings(createDefaultSettings());
    await writeFile(
      selection.filePath,
      `${JSON.stringify({ format: 'forgeboard-settings', version: 1, settings }, null, 2)}\n`,
      { mode: 0o600 },
    );
    store.appendAudit('export', 'settings', 'allowed', { fileName: 'forgeboard-settings.json' });
    return selection.filePath;
  });
  handle(IPC_CHANNELS.settingsImport, z.tuple([]), async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Import Forgeboard settings',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    const importSchema = z.object({
      format: z.literal('forgeboard-settings'),
      version: z.literal(1),
      settings: AppSettingsSchema,
    });
    const imported = importSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const saved = store.saveSettings(imported.settings);
    store.appendAudit('settings', 'import', 'allowed', { keys: Object.keys(saved) });
    return saved;
  });

  handle(IPC_CHANNELS.agentsDetect, z.tuple([]), () => detectAgents(testAgentPath));
  handle(IPC_CHANNELS.projectsRecent, z.tuple([]), () => store.listProjects());
  handle(IPC_CHANNELS.projectsPick, z.tuple([]), async () => projects.pickRepository());
  handle(IPC_CHANNELS.projectsPickParent, z.tuple([]), async () => projects.pickParent());
  handle(IPC_CHANNELS.projectsPickExecutable, z.tuple([]), async () => projects.pickExecutable());
  handle(IPC_CHANNELS.projectsOpen, z.tuple([PathSchema]), async (path) => projects.open(path));
  handle(IPC_CHANNELS.projectsCreate, z.tuple([CreateProjectInputSchema]), async (input) =>
    projects.create(input.parentPath, input.name, input.initializeGit),
  );
  handle(IPC_CHANNELS.projectsClone, z.tuple([CloneProjectInputSchema]), async (input) =>
    projects.clone(input.remoteUrl, input.destinationPath),
  );
  handle(IPC_CHANNELS.projectsDemo, z.tuple([]), async () => projects.createDemo());

  handle(IPC_CHANNELS.canvasLoad, z.tuple([ProjectIdSchema]), (projectId) => {
    const existing = store.loadCanvas(projectId);
    if (existing) return existing;
    return store.saveCanvas({
      id: randomUUID(),
      projectId,
      name: 'Workshop',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: new Date().toISOString(),
    });
  });
  handle(IPC_CHANNELS.canvasSave, z.tuple([CanvasDocumentSchema]), (document) =>
    store.saveCanvas(document),
  );

  handle(IPC_CHANNELS.auditList, z.tuple([AuditListInputSchema]), (input) =>
    store.listAuditEvents(input.limit),
  );

  handle(IPC_CHANNELS.privacyExport, z.tuple([]), async () => {
    const selection = await dialog.showSaveDialog({
      title: 'Export all local Forgeboard data',
      defaultPath: 'forgeboard-local-data.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    await writeFile(selection.filePath, `${JSON.stringify(store.exportData(), null, 2)}\n`, {
      mode: 0o600,
    });
    store.appendAudit('export', 'local-data', 'allowed', {
      fileName: 'forgeboard-local-data.json',
    });
    return selection.filePath;
  });
  handle(
    IPC_CHANNELS.privacyDelete,
    z.tuple([z.literal('DELETE ALL LOCAL DATA')]),
    (confirmation) => {
      if (confirmation !== 'DELETE ALL LOCAL DATA') throw new Error('Deletion was not confirmed.');
      store.deleteAllLocalData();
      return true;
    },
  );

  const runs = new RunService(store, () => store.getSettings(createDefaultSettings()));
  runs.registerIpcHandlers();
  return runs;
}

function handle<Args extends unknown[], Output>(
  channel: string,
  schema: z.ZodType<Args>,
  operation: (...args: Args) => Output | Promise<Output>,
): void {
  ipcMain.handle(channel, async (_event, ...rawArgs: unknown[]): Promise<IpcResult<Output>> => {
    try {
      const args = schema.parse(rawArgs);
      return { ok: true, value: await operation(...args) };
    } catch (error) {
      const validation = error instanceof z.ZodError;
      return {
        ok: false,
        error: {
          code: validation ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message: validation
            ? 'Forgeboard rejected an invalid request.'
            : error instanceof Error
              ? error.message
              : 'The operation failed.',
        },
      };
    }
  });
}
